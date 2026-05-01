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
  reconnectOnError(err) {
    return err.message.includes('READONLY') || err.message.includes('ECONNRESET');
  },
});
redis.on('error', err => console.error('Redis error:', err.message));

// ── Redis Keys ────────────────────────────────────────────────────────────────
const KEYS = {
  MEMORY:       'remy_memory',
  RAW_LOG:      'remy_raw_log',
  APPROVED:     'approved_users',
  BOSS_GRP:     (chatId) => `boss_group_${chatId}`,
  HISTORY:      (chatId) => `history_${chatId}`,
  BOSS_HIST:    'history_boss',
  DEDUP:        (msgId) => `dedup_${msgId}`,
  REMINDERS:    'remy_reminders',
  TIMEZONE:     'remy_boss_timezone',
  CRON_JOBS:    'remy_cron_jobs',
  CRON_ENTRY:   (jobId) => `remy_cron:${jobId}`,
  EXCHANGE_COUNT: 'remy_exchange_count',
  SPAM:         (senderId) => `spam_${senderId}_${Math.floor(Date.now() / 60000)}`,
  DEBUG_LAST:   (chatId) => `debug_last_${chatId}`,  // last turn's debug trace (TTL 1h)
};

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_HIST_MSGS   = 8;
const MAX_LOG_ENTRIES  = 500;
const DEDUP_TTL        = 60;
const MIN_MEMORY_LEN   = 10;
const SPAM_LIMIT       = 5;

module.exports = {
  redis,
  KEYS,
  MAX_HIST_MSGS,
  MAX_LOG_ENTRIES,
  DEDUP_TTL,
  MIN_MEMORY_LEN,
  SPAM_LIMIT,
};
