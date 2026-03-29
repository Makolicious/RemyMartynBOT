const { redis, KEYS, DEDUP_TTL, SPAM_LIMIT } = require('../lib/redis');
const { BOSS_ID } = require('../lib/telegram');

// ── Classify the incoming message ─────────────────────────────────────────────
// Returns: { authorized, role, reason? }
// role: 'boss' | 'approved' | 'unknown'
async function authenticate(message) {
  const senderId  = message.from?.id;
  const chatId    = message.chat.id;
  const isPrivate = message.chat.type === 'private';
  const isBoss    = senderId === BOSS_ID;

  // Private chats: boss only
  if (isPrivate && !isBoss) {
    return { authorized: false, role: 'unknown', reason: 'private_not_boss' };
  }

  // Groups: need to be approved + boss must be active in group
  if (!isPrivate && !isBoss) {
    const spamKey = KEYS.SPAM(senderId);
    const [isApproved, bossActive, spamCount] = await Promise.all([
      redis.sismember(KEYS.APPROVED, String(senderId)),
      redis.get(KEYS.BOSS_GRP(chatId)),
      redis.incr(spamKey).then(c => { redis.expire(spamKey, 120).catch(() => {}); return c; }),
    ]);
    if (!isApproved || !bossActive) return { authorized: false, role: 'unknown', reason: 'not_approved' };
    if (spamCount > SPAM_LIMIT) return { authorized: false, role: 'approved', reason: 'spam' };
  }

  return { authorized: true, role: isBoss ? 'boss' : 'approved' };
}

// ── Dedup — ignore Telegram webhook retries ───────────────────────────────────
async function dedup(messageId) {
  try {
    const isNew = await redis.set(KEYS.DEDUP(messageId), '1', 'EX', DEDUP_TTL, 'NX');
    return !!isNew;
  } catch (e) {
    console.error('Dedup Redis failed, processing anyway:', e.message);
    return true; // proceed on failure
  }
}

module.exports = { authenticate, dedup };
