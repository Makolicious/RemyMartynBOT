/**
 * Self-Organizing Memory System
 * A lean, unconventional AI memory framework with importance decay and auto-organization
 */

const Redis = require('ioredis');
const {
  CATEGORIES,
  createMemory,
  normalizeCategory,
  validateMemory
} = require('./schema');

// ── Redis Keys ───────────────────────────────────────────────────────────
const KEYS = {
  ALL: 'remy_memories_all',           // ZSET: importance -> memory_id
  ENTRY: (id) => `remy_mem:${id}`,    // HASH: full memory data
  CATEGORY: (cat) => `remy_mem_cat:${cat}`,  // SET: memory_ids in category
  ACCESSED: 'remy_mem_accessed_recent', // ZSET: timestamp -> memory_id (hot cache)
  STATS: 'remy_mem_stats',            // HASH: system stats
  LAST_DECAY: 'remy_mem_last_decay'   // STRING: timestamp of last decay run
};

// ── Lazy Redis Connection ──────────────────────────────────────────────────
let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      connectTimeout: 10000,
      commandTimeout: 10000,
      lazyConnect: true
    });
    redis.on('error', err => console.error('[MEMORY] Redis error:', err.message));
  }
  return redis;
}

// ── Core Operations ───────────────────────────────────────────────────────

/**
 * Add a new memory entry
 */
async function addMemory(content, category, confidence = 80) {
  const db = getRedis();
  const memory = createMemory(content, category, confidence);

  // Store full entry
  await db.hset(KEYS.ENTRY(memory.id), {
    id: memory.id,
    content: memory.content,
    category: memory.category,
    importance: memory.importance,
    confidence: memory.confidence,
    created_at: memory.created_at,
    last_accessed: memory.last_accessed,
    access_count: memory.access_count,
    decay_rate: memory.decay_rate,
    related_ids: JSON.stringify(memory.related_ids),
    pinned: memory.pinned ? 'true' : 'false'  // Store pinned status
  });

  // Add to importance-sorted set
  await db.zadd(KEYS.ALL, memory.importance, memory.id);

  // Add to category index
  await db.sadd(KEYS.CATEGORY(memory.category), memory.id);

  // Add to recent access (as creation)
  await db.zadd(KEYS.ACCESSED, Date.now(), memory.id);

  // Update stats
  await incrementStat('total_memories');
  await incrementStat(`category_${memory.category}`);

  return memory;
}

/**
 * Get a memory entry by ID (also boosts importance)
 */
async function getMemory(id, boost = true) {
  const db = getRedis();
  const data = await db.hgetall(KEYS.ENTRY(id));

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  // Parse and convert numbers
  const memory = {
    id: data.id,
    content: data.content,
    category: data.category,
    importance: parseFloat(data.importance),
    confidence: parseFloat(data.confidence),
    created_at: parseInt(data.created_at),
    last_accessed: parseInt(data.last_accessed),
    access_count: parseInt(data.access_count),
    decay_rate: parseFloat(data.decay_rate),
    related_ids: JSON.parse(data.related_ids || '[]'),
    pinned: data.pinned === 'true' || data.pinned === true  // Parse pinned boolean
  };

  // Boost on access if requested
  if (boost) {
    await boostMemory(id, memory);
  }

  return memory;
}

/**
 * Boost memory importance on access
 */
async function boostMemory(id, memory) {
  const db = getRedis();
  const boostAmount = 8; // Importance boost per access
  const newImportance = Math.min(100, memory.importance + boostAmount);

  // Update entry
  await db.hset(KEYS.ENTRY(id), {
    importance: newImportance,
    last_accessed: Date.now(),
    access_count: memory.access_count + 1
  });

  // Update sorted set
  await db.zadd(KEYS.ALL, newImportance, id);

  // Update recent access
  await db.zadd(KEYS.ACCESSED, Date.now(), id);

  // Trim recent access to last 100
  await db.zremrangebyrank(KEYS.ACCESSED, 0, -101);

  await incrementStat('total_accesses');
}

/**
 * Search memories by category
 */
async function getMemoriesByCategory(category, limit = 20) {
  const db = getRedis();
  const normalized = normalizeCategory(category);
  const ids = await db.smembers(KEYS.CATEGORY(normalized));

  if (ids.length === 0) {
    return [];
  }

  // Get importance scores for all IDs in this category
  const scores = {};
  for (const id of ids) {
    scores[id] = await db.zscore(KEYS.ALL, id);
  }

  // Sort by importance and fetch top N
  const sortedIds = ids
    .sort((a, b) => (scores[b] || 0) - (scores[a] || 0))
    .slice(0, limit);

  const memories = [];
  for (const id of sortedIds) {
    const mem = await getMemory(id, false); // don't boost on list view
    if (mem) memories.push(mem);
  }

  return memories;
}

/**
 * Search memories by content (simple text search)
 */
async function searchMemories(query, limit = 10) {
  const db = getRedis();
  const queryLower = query.toLowerCase();

  // Get all memory IDs (limited for performance)
  const ids = await db.zrevrange(KEYS.ALL, 0, 99);

  const results = [];
  for (const id of ids) {
    const mem = await getMemory(id, false);
    if (!mem) continue;

    const contentMatch = mem.content.toLowerCase().includes(queryLower);
    const categoryMatch = mem.category.toLowerCase().includes(queryLower);

    if (contentMatch || categoryMatch) {
      results.push({
        ...mem,
        relevance: contentMatch ? 1 : 0.5
      });
    }

    if (results.length >= limit) break;
  }

  // Sort by relevance then importance
  results.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return b.importance - a.importance;
  });

  return results;
}

/**
 * Update an existing memory
 */
async function updateMemory(id, updates) {
  const db = getRedis();
  const existing = await getMemory(id, false);

  if (!existing) {
    throw new Error('Memory not found');
  }

  const updated = { ...existing, ...updates };

  // Validate
  const validation = validateMemory(updated);
  if (!validation.valid) {
    throw new Error(`Invalid memory: ${validation.errors.join(', ')}`);
  }

  // Store updated
  await db.hset(KEYS.ENTRY(id), {
    id: updated.id,
    content: updated.content,
    category: updated.category,
    importance: updated.importance,
    confidence: updated.confidence,
    created_at: updated.created_at,
    last_accessed: updated.last_accessed,
    access_count: updated.access_count,
    decay_rate: updated.decay_rate,
    related_ids: JSON.stringify(updated.related_ids),
    pinned: updated.pinned ? 'true' : 'false'  // Store pinned status
  });

  // Update sorted set if importance changed
  if (updates.importance !== undefined) {
    await db.zadd(KEYS.ALL, updated.importance, id);
  }

  // Update category index if changed
  if (updates.category && updates.category !== existing.category) {
    await db.srem(KEYS.CATEGORY(existing.category), id);
    await db.sadd(KEYS.CATEGORY(updated.category), id);
  }

  return updated;
}

/**
 * Delete a memory
 */
async function deleteMemory(id) {
  const db = getRedis();
  const mem = await getMemory(id, false);

  if (!mem) {
    return false;
  }

  // Remove from all indexes
  await db.del(KEYS.ENTRY(id));
  await db.zrem(KEYS.ALL, id);
  await db.srem(KEYS.CATEGORY(mem.category), id);
  await db.zrem(KEYS.ACCESSED, id);

  await incrementStat('deleted_memories');

  return true;
}

/**
 * Apply time decay to all memories
 */
async function applyDecay() {
  const db = getRedis();
  const now = Date.now();
  const lastDecay = await db.get(KEYS.LAST_DECAY);
  const lastDecayTime = lastDecay ? parseInt(lastDecay) : now;
  const daysPassed = Math.max(1, Math.floor((now - lastDecayTime) / (1000 * 60 * 60 * 24)));

  console.log(`[MEMORY] Applying decay for ${daysPassed} day(s)...`);

  // Get all memory IDs with their importance
  const entries = await db.zrange(KEYS.ALL, 0, -1, 'WITHSCORES');
  let decayed = 0;

  for (let i = 0; i < entries.length; i += 2) {
    const id = entries[i];
    const currentImportance = parseFloat(entries[i + 1]);

    // Get memory to get its decay rate and pinned status
    const mem = await getMemory(id, false);
    if (!mem) continue;

    // Skip pinned memories - they don't decay
    if (mem.pinned) continue;

    // Apply decay: importance * (decay_rate ^ days)
    const newImportance = currentImportance * Math.pow(mem.decay_rate, daysPassed);

    // Update entry
    await db.hset(KEYS.ENTRY(id), 'importance', newImportance);
    await db.zadd(KEYS.ALL, newImportance, id);

    decayed++;
  }

  // Update last decay timestamp
  await db.set(KEYS.LAST_DECAY, now);
  await db.hset(KEYS.STATS, 'last_decay', now);

  console.log(`[MEMORY] Decay applied to ${decayed} memories`);

  return { decayed, daysPassed };
}

/**
 * Prune low-importance memories
 */
async function pruneMemories(threshold = 10) {
  const db = getRedis();
  const lowImportanceIds = await db.zrange(KEYS.ALL, 0, -1); // ascending

  let pruned = 0;
  for (const id of lowImportanceIds) {
    const importance = await db.zscore(KEYS.ALL, id);

    if (importance !== null && parseFloat(importance) < threshold) {
      await deleteMemory(id);
      pruned++;
    } else {
      // Stop when we hit threshold (list is sorted ascending)
      break;
    }
  }

  await incrementStat('pruned_memories', pruned);
  console.log(`[MEMORY] Pruned ${pruned} memories below importance ${threshold}`);

  return pruned;
}

/**
 * Get memory statistics
 */
async function getStats() {
  const db = getRedis();

  const totalMemories = await db.zcard(KEYS.ALL);
  const hotMemories = await db.zcard(KEYS.ACCESSED);
  const allStats = await db.hgetall(KEYS.STATS) || {};

  // Get category counts
  const categoryStats = {};
  for (const cat of CATEGORIES) {
    categoryStats[cat] = await db.scard(KEYS.CATEGORY(cat));
  }

  return {
    totalMemories,
    hotMemories,
    ...allStats,
    categories: categoryStats
  };
}

/**
 * Increment a stat counter
 */
async function incrementStat(key, amount = 1) {
  const db = getRedis();
  await db.hincrby(KEYS.STATS, key, amount);
}

/**
 * Export memory as the old markdown format (for backward compatibility)
 */
async function exportAsMarkdown() {
  const output = ['# Remy\'s Memory Tables\n'];

  for (const category of CATEGORIES) {
    const memories = await getMemoriesByCategory(category, 50);

    if (memories.length > 0) {
      output.push(`\n## ${category}`);
      output.push('| Content | Importance | Confidence | Last Accessed |');
      output.push('|----------|------------|------------|--------------|');

      for (const mem of memories) {
        const lastAccessed = new Date(mem.last_accessed).toLocaleDateString();
        output.push(
          `| ${mem.content} | ${mem.importance.toFixed(0)} | ${mem.confidence} | ${lastAccessed} |`
        );
      }
    }
  }

  return output.join('\n');
}

/**
 * Close Redis connection
 */
async function close() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

module.exports = {
  addMemory,
  getMemory,
  boostMemory,
  getMemoriesByCategory,
  searchMemories,
  updateMemory,
  deleteMemory,
  applyDecay,
  pruneMemories,
  getStats,
  incrementStat,
  exportAsMarkdown,
  close,
  CATEGORIES
};
