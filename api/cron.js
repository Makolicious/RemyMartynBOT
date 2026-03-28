const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const { zai } = require('zhipu-ai-provider');
const { generateText } = require('ai');

const CHAT_MODEL = zai('glm-4-plus');

let FALLBACK_MODEL = null;
if (process.env.ANTHROPIC_API_KEY) {
  const { anthropic } = require('@ai-sdk/anthropic');
  FALLBACK_MODEL = anthropic('claude-sonnet-4-6');
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
      body: JSON.stringify({ q: query, num: 5 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const results = (data.organic || []).slice(0, 5).map(r => `${r.title}: ${r.snippet}`).join('\n');
    return results || null;
  } catch (err) {
    console.error('[CRON] Web search failed:', err.message);
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
    const queries = [
      'top news today ' + new Date().toISOString().slice(0, 10),
      'breaking news headlines today',
      'technology business world news today',
    ];
    const results = await Promise.all(queries.map(q => cronWebSearch(q)));
    const combined = results.filter(Boolean).join('\n\n');
    if (combined) {
      searchSection = `\n\nLIVE SEARCH RESULTS (fetched just now — use ONLY this data, do NOT make up news):\n${combined}\n`;
    }
  }

  // Use Sonnet if available (better at synthesis), fall back to GLM
  const taskModel = FALLBACK_MODEL || CHAT_MODEL;
  const modelName = FALLBACK_MODEL ? 'Sonnet' : 'GLM';
  console.log(`[CRON] AI task using ${modelName} | search: ${needsSearch} | hasResults: ${!!searchSection}`);

  const { text } = await generateText({
    model: taskModel,
    system: `You are Remy — ${bossName}'s personal AI agent. Sharp, direct, loyal. Current time: ${localTime}.${searchSection}`,
    prompt: `Execute this scheduled task for ${bossName}: ${job.message}\n\nIMPORTANT: Base your response ONLY on the live search results provided above. If no search results were provided, say so honestly — never fabricate or hallucinate information. Deliver concisely using Markdown.`,
    maxTokens: 1500,
  });

  return text;
}

// ── Next fire time calculator ────────────────────────────────────────────────

function calculateNextFire(time, repeat, dayOfWeek, dayOfMonth) {
  const [hours, minutes] = time.split(':').map(Number);
  const now = new Date();
  let next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  // Always move to at least tomorrow since we just fired
  next.setDate(next.getDate() + 1);

  switch (repeat) {
    case 'daily':
      return next.getTime();
    case 'weekdays':
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
      return next.getTime();
    case 'weekly':
      const targetDay = parseInt(dayOfWeek) || 1;
      while (next.getDay() !== targetDay) next.setDate(next.getDate() + 1);
      return next.getTime();
    case 'monthly':
      const targetDate = parseInt(dayOfMonth) || 1;
      let targetMonth = next.getMonth();
      // If we've already passed this day this month, move to next month
      if (next.getDate() > targetDate || (next.getDate() === targetDate && new Date(now) >= next)) {
        targetMonth++;
      }
      next.setMonth(targetMonth);
      // Clamp to last day of month if target day doesn't exist (e.g., 31st in April)
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(targetDate, lastDay));
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
        const { chatId, message } = JSON.parse(entry);
        if (typeof chatId !== 'number' || !message) throw new Error(`Invalid reminder data: ${entry}`);
        await bot.sendMessage(chatId, `\u23f0 *Reminder:* ${message}`, { parse_mode: 'Markdown' });
        processed++;
      } catch (err) {
        console.error('Failed to send reminder:', err.message);
      }
      await redis.zrem(REMINDERS_KEY, entry);
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
        await bot.sendMessage(chatId, messageToSend, { parse_mode: 'Markdown' });
        processed++;

        // Update stats and reschedule
        const fireCount = (parseInt(job.fireCount) || 0) + 1;
        await redis.hset(`${CRON_PREFIX}${jobId}`, 'fireCount', String(fireCount), 'lastFired', String(now));

        const nextFire = calculateNextFire(job.time, job.repeat, job.dayOfWeek, job.dayOfMonth);
        await redis.zadd(CRON_JOBS_KEY, nextFire, jobId);

      } catch (err) {
        console.error(`[CRON] Failed to process job ${jobId}:`, err.message);
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
