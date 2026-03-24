const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');

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

        const chatId = parseInt(job.chatId) || parseInt(process.env.BOSS_ID);
        if (!chatId) {
          console.error(`[CRON] No chatId for job ${jobId}`);
          continue;
        }

        await bot.sendMessage(chatId, `\ud83d\udd01 *Scheduled:* ${job.message}`, { parse_mode: 'Markdown' });
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
