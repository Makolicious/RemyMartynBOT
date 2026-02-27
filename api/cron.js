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

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    // Get all reminders with score (timestamp) <= now
    const due = await redis.zrangebyscore(REMINDERS_KEY, 0, now);

    for (const entry of due) {
      try {
        const { chatId, message } = JSON.parse(entry);
        await bot.sendMessage(chatId, `⏰ *Reminder:* ${message}`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Failed to send reminder:', err.message);
      }
      // Remove regardless of send success to avoid infinite retries
      await redis.zrem(REMINDERS_KEY, entry);
    }

    res.status(200).send(`OK — ${due.length} reminder(s) processed`);
  } catch (error) {
    console.error('Cron error:', error);
    res.status(200).send('Error');
  }
};
