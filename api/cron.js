const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const { zai } = require('zhipu-ai-provider');
const { generateText } = require('ai');

const CHAT_MODEL = zai('glm-4-plus');

let FALLBACK_MODEL = null;
if (process.env.ANTHROPIC_API_KEY) {
  const { anthropic } = require('@ai-sdk/anthropic');
  FALLBACK_MODEL = anthropic('claude-3-haiku-20240307');
}

const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 5000,
  commandTimeout: 10000,
  maxRetriesPerRequest: 3,
  keepAlive: 1000,
  retryStrategy(times) {
    if (times > 3) return null;
    return Math.min(times * 300, 1000);
  },
});
redis.on('error', err => console.error('Cron Redis error:', err.message));

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
const REMINDERS_KEY = 'remy_reminders';
const CRON_JOBS_KEY = 'remy_cron_jobs';
const CRON_PREFIX   = 'remy_cron:';

// ── Web search for AI tasks ───────────────────────────────────────────────────

async function cronWebSearch(query) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return null;
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 10, tbs: 'qdr:d' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parts = [];
    // Include top stories if available
    if (data.topStories) {
      parts.push(...data.topStories.slice(0, 5).map(r => `[TOP] ${r.title}${r.source ? ` (${r.source})` : ''}`));
    }
    // Include news results if available
    if (data.news) {
      parts.push(...data.news.slice(0, 5).map(r => `[NEWS] ${r.title}: ${r.snippet || ''}${r.source ? ` (${r.source})` : ''}`));
    }
    // Include organic results
    if (data.organic) {
      parts.push(...data.organic.slice(0, 8).map(r => `${r.title}: ${r.snippet}`));
    }
    return parts.join('\n') || null;
  } catch (err) {
    console.error('[CRON] Web search failed:', err.message);
    return null;
  }
}

// News-specific search via Serper news endpoint
async function cronNewsSearch(query) {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return null;
  try {
    const res = await fetch('https://google.serper.dev/news', {
      method: 'POST',
      headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 10 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const results = (data.news || []).slice(0, 10).map(r =>
      `${r.title}${r.snippet ? ': ' + r.snippet : ''} (${r.source || 'unknown'})`
    ).join('\n');
    return results || null;
  } catch (err) {
    console.error('[CRON] News search failed:', err.message);
    return null;
  }
}

// Execute an AI task job — Sonnet for quality, Serper for live data
async function executeAiTask(job) {
  const bossName = process.env.BOSS_NAME || 'Mako';
  const tzOffset = parseInt(process.env.TZ_OFFSET) || -4; // EDT default
  const now = new Date();
  const local = new Date(now.getTime() + tzOffset * 3600000);
  const localTime = local.toLocaleString('en-US', {
    timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // Run multiple searches for better coverage on news tasks
  const needsSearch = /\b(news|weather|price|stock|latest|today|current|trending|headlines|market|debrief|summary)\b/i.test(job.message);
  let searchSection = '';
  if (needsSearch) {
    const isLocal = /\blocal\b/i.test(job.message);
    const results = await Promise.all([
      cronNewsSearch('top breaking news today'),
      cronNewsSearch('US politics economy news today'),
      cronNewsSearch('technology AI business news today'),
      cronNewsSearch('world international news today'),
      cronWebSearch('most important news today ' + new Date().toISOString().slice(0, 10)),
      isLocal ? cronNewsSearch('Miami South Florida Hialeah news today') : Promise.resolve(null),
    ]);
    const combined = results.filter(Boolean).join('\n---\n');
    if (combined) {
      searchSection = `\n\nLIVE NEWS DATA (fetched just now — synthesize ALL of this into the debrief, do NOT skip or ignore any results, do NOT fabricate stories not found here):\n${combined}\n`;
    }
    console.log(`[CRON] Search returned ${combined.split('\n').length} lines of data`);
  }

  // Use Sonnet if available (better at synthesis), fall back to GLM
  const taskModel = FALLBACK_MODEL || CHAT_MODEL;
  const modelName = FALLBACK_MODEL ? 'Sonnet' : 'GLM';
  console.log(`[CRON] AI task using ${modelName} | search: ${needsSearch} | hasResults: ${!!searchSection}`);

  const { text } = await generateText({
    model: taskModel,
    system: `You are Remy — ${bossName}'s personal AI agent. Sharp, direct, loyal. Current time: ${localTime}.${needsSearch ? ` ${bossName} is based in South Florida (Miami / Hialeah). "Local" always means Miami-Dade / South Florida.` : ''}${searchSection}`,
    prompt: needsSearch
      ? `Execute this scheduled task for ${bossName}: ${job.message}\n\nIMPORTANT: Base your response ONLY on the live search results provided above. If no search results were provided, say so honestly — never fabricate or hallucinate information.\n\nFormatting rules:\n- Start with a bold title line including the date and time\n- Use ## headers with relevant emojis for each category (e.g. ## 🏛️ Politics, ## 💻 Tech, ## 🌍 International, ## 💰 Business)\n- Use --- separators between sections\n- 3+ bullet points per category\n- Keep it punchy and scannable`
      : `Execute this scheduled task for ${bossName}: ${job.message}\n\nKeep it short and direct. No filler.`,
    maxTokens: 2500,
  });

  return text;
}

// ── Next fire time calculator ────────────────────────────────────────────────

function calculateNextFire(time, repeat, dayOfWeek, dayOfMonth) {
  const [hours, minutes] = time.split(':').map(Number);
  const now = new Date();
  let next = new Date(now);
  next.setUTCHours(hours, minutes, 0, 0);

  // Always move to at least tomorrow since we just fired
  next.setUTCDate(next.getUTCDate() + 1);

  switch (repeat) {
    case 'daily':
      return next.getTime();
    case 'weekdays':
      while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
      return next.getTime();
    case 'weekly':
      const targetDay = parseInt(dayOfWeek) || 1;
      while (next.getUTCDay() !== targetDay) next.setUTCDate(next.getUTCDate() + 1);
      return next.getTime();
    case 'monthly':
      const targetDate = parseInt(dayOfMonth) || 1;
      if (next.getUTCDate() > targetDate) {
        next.setUTCDate(1); // prevent month rollover
        next.setUTCMonth(next.getUTCMonth() + 1);
      }
      const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
      next.setUTCDate(Math.min(targetDate, lastDay));
      return next.getTime();
    default:
      return next.getTime();
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    let processed = 0;
    console.log(`[CRON] tick at ${new Date(now).toISOString()} — checking reminders + jobs`);
    await redis.set('cron_last_tick', String(now));

    // ── One-shot reminders ─────────────────────────────────────────────
    const due = await redis.zrangebyscore(REMINDERS_KEY, 0, now);

    for (const entry of due) {
      try {
        const parsed = JSON.parse(entry);
        const { chatId, message } = parsed;
        if (!Number(chatId) || !message) {
          // Corrupt entry — remove it
          await redis.zrem(REMINDERS_KEY, entry);
          continue;
        }
        try {
          await bot.sendMessage(chatId, `\u23f0 *Reminder:* ${message}`, { parse_mode: 'Markdown' });
        } catch (parseErr) {
          if (parseErr.message?.includes('parse') || parseErr.response?.body?.description?.includes('parse')) {
            await bot.sendMessage(chatId, `\u23f0 Reminder: ${message}`);
          } else { throw parseErr; }
        }
        await redis.zrem(REMINDERS_KEY, entry);
        processed++;
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Unparseable JSON — remove corrupt entry
          await redis.zrem(REMINDERS_KEY, entry);
        }
        // Telegram send failed — leave in Redis to retry next cycle
        console.error('Failed to send reminder:', err.message);
      }
    }

    // ── Recurring cron jobs ────────────────────────────────────────────
    const dueJobs = await redis.zrangebyscore(CRON_JOBS_KEY, 0, now);

    for (const jobId of dueJobs) {
      try {
        const job = await redis.hgetall(`${CRON_PREFIX}${jobId}`);
        if (!job || !job.message) {
          // Orphaned job ID — clean up
          await redis.zrem(CRON_JOBS_KEY, jobId);
          continue;
        }

        // Skip disabled jobs — just reschedule them
        if (job.enabled === 'false') {
          const nextFire = calculateNextFire(job.time, job.repeat, job.dayOfWeek, job.dayOfMonth);
          await redis.zadd(CRON_JOBS_KEY, nextFire, jobId);
          continue;
        }

        const chatId = parseInt(job.chatId) || parseInt(process.env.BOSS_ID) || parseInt(process.env.MY_TELEGRAM_ID);
        if (!chatId) {
          console.error(`[CRON] No chatId for job ${jobId}`);
          continue;
        }

        let messageToSend;
        if (job.jobType !== 'message') {
          try {
            messageToSend = await executeAiTask(job);
          } catch (err) {
            console.error(`[CRON] AI task failed for job ${jobId}:`, err.message);
            messageToSend = `📅 *Scheduled task failed:* ${job.message}\n\n⚠️ ${err.message?.slice(0, 100)}`;
          }
        } else {
          messageToSend = `🔄 *Scheduled:* ${job.message}`;
        }
        try {
          await bot.sendMessage(chatId, messageToSend, { parse_mode: 'Markdown' });
        } catch (parseErr) {
          if (parseErr.message?.includes('parse') || parseErr.response?.body?.description?.includes('parse')) {
            await bot.sendMessage(chatId, messageToSend);
          } else { throw parseErr; }
        }
        processed++;

        // Update stats, reset fail counter, and reschedule
        const fireCount = (parseInt(job.fireCount) || 0) + 1;
        await redis.hset(`${CRON_PREFIX}${jobId}`, 'fireCount', String(fireCount), 'lastFired', String(now), 'failCount', '0');

        const nextFire = calculateNextFire(job.time, job.repeat, job.dayOfWeek, job.dayOfMonth);
        await redis.zadd(CRON_JOBS_KEY, nextFire, jobId);

      } catch (err) {
        console.error(`[CRON] Failed to process job ${jobId}:`, err.message);
        // Circuit breaker: disable after 5 consecutive failures
        const failCount = parseInt(await redis.hget(`${CRON_PREFIX}${jobId}`, 'failCount') || '0') + 1;
        await redis.hset(`${CRON_PREFIX}${jobId}`, 'failCount', String(failCount));
        if (failCount >= 5) {
          await redis.hset(`${CRON_PREFIX}${jobId}`, 'enabled', 'false');
          console.error(`[CRON] Job ${jobId} disabled after ${failCount} consecutive failures`);
        }
        // Reschedule to avoid getting stuck — push 1 hour forward
        await redis.zadd(CRON_JOBS_KEY, now + 3600000, jobId);
      }
    }

    res.status(200).send(`OK — ${processed} item(s) processed`);
  } catch (error) {
    console.error('Cron error:', error);
    res.status(200).send('Error');
  }
};
