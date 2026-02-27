const Redis = require('ioredis');

// ── Admin Authentication ─────────────────────────────────────────────────────

// Validate admin password from request header
function isAdmin(req) {
  const authHeader = req.headers['authorization'];
  const adminSecret = process.env.ADMIN_SECRET;

  if (!adminSecret) {
    console.error('[ADMIN] ADMIN_SECRET not set in environment');
    return false;
  }

  if (!authHeader) {
    return false;
  }

  // Support both "Bearer token" and plain token
  const token = authHeader.replace('Bearer ', '').trim();
  return token === adminSecret;
}

// ── Redis Setup ─────────────────────────────────────────────────────────

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
redis.on('error', err => console.error('Redis error:', err.message));

// ── Helper Functions ─────────────────────────────────────────────────────

// Redis keys (same as webhook.js)
const MEMORY_KEY      = 'remy_memory';
const RAW_LOG_KEY     = 'remy_raw_log';
const APPROVED_KEY    = 'approved_users';
const BOSS_GRP_PREFIX = 'boss_group_';
const NOTES_KEY       = 'remy_notes';
const REMINDERS_KEY   = 'remy_reminders';

// Format date nicely
function formatDate(isoString) {
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Send JSON response
function jsonResponse(res, data, status = 200) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).json(data);
}

// ── API Endpoints ────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const path = req.path || req.url?.split('?')[0] || '/';

  // CORS headers for frontend access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── GET /api/admin/auth ───────────────────────────────────────
  if (path === '/auth' && req.method === 'GET') {
    if (isAdmin(req)) {
      return jsonResponse(res, { authenticated: true, message: 'Welcome, Boss' });
    }
    return jsonResponse(res, { authenticated: false, message: 'Access denied' }, 401);
  }

  // ── All other endpoints require auth ───────────────────────────
  if (!isAdmin(req)) {
    return jsonResponse(res, { error: 'Unauthorized' }, 401);
  }

  try {
    // ── GET /api/admin/stats ─────────────────────────────────────
    if (path === '/stats' && req.method === 'GET') {
      const [logLen, memStr, approvedCount, exchangeCount, notesLen, remindersLen] = await Promise.all([
        redis.llen(RAW_LOG_KEY),
        redis.get(MEMORY_KEY),
        redis.scard(APPROVED_KEY),
        redis.get('remy_exchange_count'),
        redis.llen(NOTES_KEY),
        redis.zcard(REMINDERS_KEY),
      ]);

      const memKB = memStr ? (memStr.length / 1024).toFixed(1) : 0;

      return jsonResponse(res, {
        totalExchanges: exchangeCount || 0,
        logEntries: logLen,
        memorySize: `${memKB} KB`,
        memoryLength: memStr?.length || 0,
        approvedUsers: approvedCount,
        savedNotes: notesLen,
        pendingReminders: remindersLen,
      });
    }

    // ── GET /api/admin/memory ───────────────────────────────────
    if (path === '/memory' && req.method === 'GET') {
      const memory = await redis.get(MEMORY_KEY);
      return jsonResponse(res, {
        memory: memory || 'No memory yet.',
        length: memory?.length || 0,
      });
    }

    // ── PUT /api/admin/memory ───────────────────────────────────
    if (path === '/memory' && req.method === 'PUT') {
      const body = req.body || {};
      const newMemory = body.memory;

      if (!newMemory || typeof newMemory !== 'string') {
        return jsonResponse(res, { error: 'Invalid memory format' }, 400);
      }

      await redis.set(MEMORY_KEY, newMemory);
      return jsonResponse(res, { success: true, message: 'Memory updated' });
    }

    // ── GET /api/admin/notes ───────────────────────────────────
    if (path === '/notes' && req.method === 'GET') {
      const entries = await redis.lrange(NOTES_KEY, 0, 99);
      const notes = entries.map((e, i) => {
        const { ts, text } = JSON.parse(e);
        return { id: i + 1, timestamp: ts, text };
      });
      return jsonResponse(res, { notes });
    }

    // ── POST /api/admin/notes ──────────────────────────────────
    if (path === '/notes' && req.method === 'POST') {
      const body = req.body || {};
      const text = body.text?.trim();

      if (!text) {
        return jsonResponse(res, { error: 'Note text required' }, 400);
      }

      await redis.lpush(NOTES_KEY, JSON.stringify({
        ts: new Date().toISOString(),
        text,
      }));
      return jsonResponse(res, { success: true, message: 'Note added' });
    }

    // ── DELETE /api/admin/notes/:id ────────────────────────────
    if (path.startsWith('/notes/') && req.method === 'DELETE') {
      const id = parseInt(path.split('/notes/')[1]);
      const entries = await redis.lrange(NOTES_KEY, 0, -1);

      if (id < 1 || id > entries.length) {
        return jsonResponse(res, { error: 'Invalid note ID' }, 400);
      }

      // Redis lists don't support direct index delete — remove by value
      const target = entries[id - 1];
      await redis.lrem(NOTES_KEY, 1, target);

      return jsonResponse(res, { success: true, message: `Note ${id} deleted` });
    }

    // ── GET /api/admin/reminders ───────────────────────────────
    if (path === '/reminders' && req.method === 'GET') {
      const all = await redis.zrangebyscore(REMINDERS_KEY, Date.now(), '+inf', 'WITHSCORES');
      const reminders = [];

      for (let i = 0; i < all.length; i += 2) {
        const entry = JSON.parse(all[i]);
        const score = parseInt(all[i + 1]);
        reminders.push({
          id: Math.floor(i / 2) + 1,
          timestamp: score,
          message: entry.message,
          formattedDate: formatDate(new Date(score)),
        });
      }

      return jsonResponse(res, { reminders });
    }

    // ── POST /api/admin/reminders ──────────────────────────────
    if (path === '/reminders' && req.method === 'POST') {
      const body = req.body || {};
      const { when, message } = body;

      if (!when || !message) {
        return jsonResponse(res, { error: 'when and message required' }, 400);
      }

      const timestamp = when === 'now' ? Date.now() : new Date(when).getTime();
      if (isNaN(timestamp)) {
        return jsonResponse(res, { error: 'Invalid date format' }, 400);
      }

      await redis.zadd(REMINDERS_KEY, timestamp, JSON.stringify({ message }));
      return jsonResponse(res, { success: true, message: 'Reminder set' });
    }

    // ── DELETE /api/admin/reminders/:id ─────────────────────────
    if (path.startsWith('/reminders/') && req.method === 'DELETE') {
      const id = parseInt(path.split('/reminders/')[1]);
      const all = await redis.zrangebyscore(REMINDERS_KEY, Date.now(), '+inf', 'WITHSCORES');

      if (id < 1 || id * 2 > all.length) {
        return jsonResponse(res, { error: 'Invalid reminder ID' }, 400);
      }

      const target = all[(id - 1) * 2];
      await redis.zrem(REMINDERS_KEY, target);

      return jsonResponse(res, { success: true, message: `Reminder ${id} deleted` });
    }

    // ── GET /api/admin/log ─────────────────────────────────────
    if (path === '/log' && req.method === 'GET') {
      const query = req.query || {};
      const limit = Math.min(parseInt(query.limit) || 50, 500);

      const entries = await redis.lrange(RAW_LOG_KEY, 0, limit - 1);
      const log = entries.map(e => {
        const { ts, sender, msg, reply, isBoss, chat } = JSON.parse(e);
        return {
          timestamp: ts,
          formattedDate: formatDate(ts),
          sender,
          isBoss,
          chatType: chat,
          message: msg,
          reply: reply?.slice(0, 100) + (reply?.length > 100 ? '...' : ''),
        };
      });

      return jsonResponse(res, { log, count: entries.length });
    }

    // ── GET /api/admin/users ───────────────────────────────────
    if (path === '/users' && req.method === 'GET') {
      const [users, groupKeys] = await Promise.all([
        redis.smembers(APPROVED_KEY),
        redis.keys(`${BOSS_GRP_PREFIX}*`),
      ]);

      const groups = groupKeys.map(k => k.replace(BOSS_GRP_PREFIX, ''));

      return jsonResponse(res, {
        approvedUsers: users,
        activeGroups: groups,
        totalUsers: users.length,
        totalGroups: groups.length,
      });
    }

    // ── POST /api/admin/users ──────────────────────────────────
    if (path === '/users' && req.method === 'POST') {
      const body = req.body || {};
      const { userId, action } = body;

      if (!userId || !action) {
        return jsonResponse(res, { error: 'userId and action required' }, 400);
      }

      if (action === 'add') {
        await redis.sadd(APPROVED_KEY, userId);
        return jsonResponse(res, { success: true, message: `User ${userId} added` });
      }

      if (action === 'remove') {
        await redis.srem(APPROVED_KEY, userId);
        return jsonResponse(res, { success: true, message: `User ${userId} removed` });
      }

      return jsonResponse(res, { error: 'Invalid action (use "add" or "remove")' }, 400);
    }

    // ── Unknown endpoint ────────────────────────────────────────
    return jsonResponse(res, { error: 'Not found' }, 404);

  } catch (error) {
    console.error('[ADMIN] Error:', error);
    return jsonResponse(res, { error: error.message }, 500);
  }
};
