const Redis = require('ioredis');
const { formatMemoryForTelegram } = require('./utils/formatter');
const memory = require('./memory');  // Self-organizing memory system

// ── Admin Authentication ─────────────────────────────────────────────────────

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

  const token = authHeader.replace('Bearer ', '').trim();
  return token === adminSecret;
}

// ── Lazy Redis Connection ────────────────────────────────────────────────────
// Only connect when we actually need Redis (not for /auth checks)

let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      connectTimeout: 10000,
      commandTimeout: 10000,
      maxRetriesPerRequest: 3,
      keepAlive: 1000,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 300, 1000);
      },
    });
    redis.on('error', err => console.error('[ADMIN] Redis error:', err.message));
  }
  return redis;
}

// ── Redis Keys ───────────────────────────────────────────────────────────────

const MEMORY_KEY      = 'remy_memory';
const RAW_LOG_KEY     = 'remy_raw_log';
const APPROVED_KEY    = 'approved_users';
const BOSS_GRP_PREFIX = 'boss_group_';
const NOTES_KEY       = 'remy_notes';
const REMINDERS_KEY   = 'remy_reminders';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(isoString) {
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function jsonResponse(res, data, status = 200) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).json(data);
}

// ── API Handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // ── FIX: Strip /api/admin prefix so route matching works on Vercel ──
  const rawPath = req.path || req.url?.split('?')[0] || '/';
  const path = rawPath.replace(/^\/api\/admin/, '') || '/';

  console.log(`[ADMIN] ${req.method} ${rawPath} → matched path: ${path}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── GET /auth — no Redis needed ────────────────────────────────────
  if (path === '/auth' && req.method === 'GET') {
    if (isAdmin(req)) {
      return jsonResponse(res, { authenticated: true, message: 'Welcome, Boss' });
    }
    return jsonResponse(res, { authenticated: false, message: 'Access denied' }, 401);
  }

  // ── All other endpoints require auth ───────────────────────────────
  if (!isAdmin(req)) {
    return jsonResponse(res, { error: 'Unauthorized' }, 401);
  }

  // ── Connect Redis only for authenticated data endpoints ────────────
  const db = getRedis();

  try {
    await db.connect().catch(() => {});  // no-op if already connected

    // ── GET /stats ───────────────────────────────────────────────────
    if (path === '/stats' && req.method === 'GET') {
      const [logLen, memStr, approvedCount, exchangeCount, notesLen, remindersLen] = await Promise.all([
        db.llen(RAW_LOG_KEY),
        db.get(MEMORY_KEY),
        db.scard(APPROVED_KEY),
        db.get('remy_exchange_count'),
        db.llen(NOTES_KEY),
        db.zcard(REMINDERS_KEY),
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

    // ── GET /memory ──────────────────────────────────────────────────
    if (path === '/memory' && req.method === 'GET') {
      const memory = await db.get(MEMORY_KEY);
      // Return raw memory for editing (formatted version is read-only display)
      return jsonResponse(res, {
        memory: memory || '',
        length: memory?.length || 0,
      });
    }

    // ── PUT /memory ──────────────────────────────────────────────────
    if (path === '/memory' && req.method === 'PUT') {
      const body = req.body || {};
      const newMemory = body.memory;

      if (!newMemory || typeof newMemory !== 'string') {
        return jsonResponse(res, { error: 'Invalid memory format' }, 400);
      }

      await db.set(MEMORY_KEY, newMemory);
      return jsonResponse(res, { success: true, message: 'Memory updated' });
    }

    // ── GET /notes ───────────────────────────────────────────────────
    if (path === '/notes' && req.method === 'GET') {
      const entries = await db.lrange(NOTES_KEY, 0, 99);
      const notes = entries.map((e, i) => {
        const { ts, text } = JSON.parse(e);
        return { id: i + 1, timestamp: ts, text };
      });
      return jsonResponse(res, { notes });
    }

    // ── POST /notes ──────────────────────────────────────────────────
    if (path === '/notes' && req.method === 'POST') {
      const body = req.body || {};
      const text = body.text?.trim();

      if (!text) {
        return jsonResponse(res, { error: 'Note text required' }, 400);
      }

      await db.lpush(NOTES_KEY, JSON.stringify({
        ts: new Date().toISOString(),
        text,
      }));
      return jsonResponse(res, { success: true, message: 'Note added' });
    }

    // ── DELETE /notes/:id ────────────────────────────────────────────
    if (path.startsWith('/notes/') && req.method === 'DELETE') {
      const id = parseInt(path.split('/notes/')[1]);
      const entries = await db.lrange(NOTES_KEY, 0, -1);

      if (id < 1 || id > entries.length) {
        return jsonResponse(res, { error: 'Invalid note ID' }, 400);
      }

      const target = entries[id - 1];
      await db.lrem(NOTES_KEY, 1, target);

      return jsonResponse(res, { success: true, message: `Note ${id} deleted` });
    }

    // ── GET /reminders ───────────────────────────────────────────────
    if (path === '/reminders' && req.method === 'GET') {
      const all = await db.zrangebyscore(REMINDERS_KEY, Date.now(), '+inf', 'WITHSCORES');
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

    // ── POST /reminders ──────────────────────────────────────────────
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

      await db.zadd(REMINDERS_KEY, timestamp, JSON.stringify({ message }));
      return jsonResponse(res, { success: true, message: 'Reminder set' });
    }

    // ── DELETE /reminders/:id ────────────────────────────────────────
    if (path.startsWith('/reminders/') && req.method === 'DELETE') {
      const id = parseInt(path.split('/reminders/')[1]);
      const all = await db.zrangebyscore(REMINDERS_KEY, Date.now(), '+inf', 'WITHSCORES');

      if (id < 1 || id * 2 > all.length) {
        return jsonResponse(res, { error: 'Invalid reminder ID' }, 400);
      }

      const target = all[(id - 1) * 2];
      await db.zrem(REMINDERS_KEY, target);

      return jsonResponse(res, { success: true, message: `Reminder ${id} deleted` });
    }

    // ── GET /log ─────────────────────────────────────────────────────
    if (path === '/log' && req.method === 'GET') {
      const query = req.query || {};
      const limit = Math.min(parseInt(query.limit) || 50, 500);

      const entries = await db.lrange(RAW_LOG_KEY, 0, limit - 1);
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

    // ── GET /users ───────────────────────────────────────────────────
    if (path === '/users' && req.method === 'GET') {
      const [users, groupKeys] = await Promise.all([
        db.smembers(APPROVED_KEY),
        db.keys(`${BOSS_GRP_PREFIX}*`),
      ]);

      const groups = groupKeys.map(k => k.replace(BOSS_GRP_PREFIX, ''));

      return jsonResponse(res, {
        approvedUsers: users,
        activeGroups: groups,
        totalUsers: users.length,
        totalGroups: groups.length,
      });
    }

    // ── POST /users ──────────────────────────────────────────────────
    if (path === '/users' && req.method === 'POST') {
      const body = req.body || {};
      const { userId, action } = body;

      if (!userId || !action) {
        return jsonResponse(res, { error: 'userId and action required' }, 400);
      }

      if (action === 'add') {
        await db.sadd(APPROVED_KEY, userId);
        return jsonResponse(res, { success: true, message: `User ${userId} added` });
      }

      if (action === 'remove') {
        await db.srem(APPROVED_KEY, userId);
        return jsonResponse(res, { success: true, message: `User ${userId} removed` });
      }

      return jsonResponse(res, { error: 'Invalid action (use "add" or "remove")' }, 400);
    }

    // ── GET /memories — list all memories with optional filters ───────
    if (path === '/memories' && req.method === 'GET') {
      const query = req.query || {};
      const category = query.category;

      let memories;
      if (category) {
        memories = await memory.getMemoriesByCategory(category, 100);
      } else {
        // Get memories from all categories
        const allCategories = memory.CATEGORIES;
        memories = [];
        for (const cat of allCategories) {
          const catMemories = await memory.getMemoriesByCategory(cat, 10);
          memories.push(...catMemories);
        }
        // Sort by importance
        memories.sort((a, b) => b.importance - a.importance);
      }

      return jsonResponse(res, { memories, total: memories.length });
    }

    // ── GET /memories/stats — memory system statistics ─────────────────
    if (path === '/memories/stats' && req.method === 'GET') {
      const stats = await memory.getStats();
      return jsonResponse(res, { stats });
    }

    // ── POST /memories/add — add a new memory entry ───────────────────
    if (path === '/memories/add' && req.method === 'POST') {
      const body = req.body || {};
      const { content, category, confidence, pinned } = body;

      if (!content || !category) {
        return jsonResponse(res, { error: 'content and category required' }, 400);
      }

      try {
        const newMemory = await memory.addMemory(content, category, confidence, pinned);
        return jsonResponse(res, { success: true, memory: newMemory });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ── PUT /memories/:id — update a memory entry ───────────────────
    if (path.startsWith('/memories/') && req.method === 'PUT' && !path.endsWith('/add')) {
      const id = path.split('/')[2];
      const body = req.body || {};

      try {
        const updated = await memory.updateMemory(id, body);
        return jsonResponse(res, { success: true, memory: updated });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ── DELETE /memories/:id — delete a memory entry ───────────────
    if (path.startsWith('/memories/') && req.method === 'DELETE') {
      const id = path.split('/')[2];
      const deleted = await memory.deleteMemory(id);

      return jsonResponse(res, {
        success: deleted,
        message: deleted ? 'Memory deleted' : 'Memory not found'
      });
    }

    // ── POST /memories/decay — trigger time decay ─────────────────────
    if (path === '/memories/decay' && req.method === 'POST') {
      const result = await memory.applyDecay();
      return jsonResponse(res, { success: true, ...result });
    }

    // ── POST /memories/prune — prune low-importance memories ───────────
    if (path === '/memories/prune' && req.method === 'POST') {
      const body = req.body || {};
      const threshold = body.threshold || 10;

      const pruned = await memory.pruneMemories(threshold);
      return jsonResponse(res, { success: true, pruned });
    }

    // ── POST /memories/migrate — migrate legacy memory to new system ──
    if (path === '/memories/migrate' && req.method === 'POST') {
      const { parseTables } = require('./utils/formatter');
      const LEGACY_MEMORY_KEY = 'remy_memory';

      const legacyMemory = await db.get(LEGACY_MEMORY_KEY);

      if (!legacyMemory) {
        return jsonResponse(res, {
          success: false,
          message: 'No legacy memory found to migrate'
        });
      }

      // Get existing memories for deduplication
      const existingMemories = await memory.getMemoriesByCategory('', 100);
      const existingKeys = new Set(
        existingMemories.map(m => `${m.category}:${m.content.toLowerCase().slice(0, 30)}`)
      );

      // Parse markdown tables
      const tables = parseTables(legacyMemory);

      let totalMigrated = 0;
      let skipped = 0;
      const results = [];

      for (const table of tables) {
        const category = table.title;

        // Skip if category doesn't exist
        if (!memory.CATEGORIES.includes(category)) {
          skipped++;
          continue;
        }

        let categoryMigrated = 0;

        for (const row of table.rows) {
          const content = row[0] || row.join(' ').trim();

          // Skip empty or placeholder rows
          if (!content ||
              content.match(/^(-+|\[.+\]|---|N\/A|Empty|None|\s+)$/i) ||
              content.length < 5) {
            skipped++;
            continue;
          }

          // Remove timestamps and clean
          const cleanContent = content.replace(/\[\d{4}-\d{2}-\d{2}\]\s*/g, '').trim();

          if (cleanContent.length < 5) {
            skipped++;
            continue;
          }

          // Check for duplicates
          const key = `${category}:${cleanContent.toLowerCase().slice(0, 30)}`;
          if (existingKeys.has(key)) {
            skipped++;
            continue;
          }

          try {
            await memory.addMemory(cleanContent, category, 85);
            existingKeys.add(key);
            totalMigrated++;
            categoryMigrated++;
          } catch (err) {
            console.error('[MIGRATE] Error:', err.message);
            skipped++;
          }
        }

        if (categoryMigrated > 0) {
          results.push({ category, migrated: categoryMigrated });
        }
      }

      return jsonResponse(res, {
        success: true,
        migrated: totalMigrated,
        skipped,
        tables: tables.length,
        results
      });
    }

    // ── Unknown endpoint ─────────────────────────────────────────────
    return jsonResponse(res, { error: 'Not found', path }, 404);

  } catch (error) {
    console.error('[ADMIN] Error:', error);
    return jsonResponse(res, { error: error.message }, 500);
  }
};