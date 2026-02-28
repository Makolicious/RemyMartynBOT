/**
 * Migration Script: Legacy Memory → Self-Organizing Memory
 * Parses markdown tables from old memory and creates structured memory entries
 */

const Redis = require('ioredis');
const { parseTables } = require('../api/utils/formatter');
const memory = require('../api/memory');

const LEGACY_MEMORY_KEY = 'remy_memory';

async function migrate() {
  const redis = new Redis(process.env.REDIS_URL, {
    connectTimeout: 10000,
    commandTimeout: 10000,
  });

  console.log('[MIGRATE] Starting memory migration...\n');

  try {
    // Get legacy memory
    const legacyMemory = await redis.get(LEGACY_MEMORY_KEY);

    if (!legacyMemory) {
      console.log('[MIGRATE] No legacy memory found. Exiting.');
      await redis.quit();
      return;
    }

    console.log('[MIGRATE] Found legacy memory, parsing tables...\n');

    // Parse markdown tables
    const tables = parseTables(legacyMemory);

    if (tables.length === 0) {
      console.log('[MIGRATE] No tables found in legacy memory.');
      await redis.quit();
      return;
    }

    // Get existing memories for deduplication
    const existingMemories = await memory.getMemoriesByCategory('', 100);
    const existingKeys = new Set(
      existingMemories.map(m => `${m.category}:${m.content.toLowerCase().slice(0, 30)}`)
    );

    let totalMigrated = 0;
    let skipped = 0;

    // Process each table (category)
    for (const table of tables) {
      const category = table.title;

      // Skip if category doesn't exist in new system
      if (!memory.CATEGORIES.includes(category)) {
        console.log(`[SKIP] Unknown category: "${category}"`);
        continue;
      }

      console.log(`\n[PROCESSING] ${category}`);
      let categoryMigrated = 0;

      // Process each row (memory entry)
      for (const row of table.rows) {
        // Skip empty rows, placeholders, or separator-like rows
        const content = row[0] || row.join(' ').trim();

        if (!content ||
            content.match(/^(-+|\[.+\]|---|N\/A|Empty|None|\s+)$/i) ||
            content.length < 5) {
          skipped++;
          continue;
        }

        // Skip timestamps in content (cleanup)
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
          // Add to new memory system
          await memory.addMemory(cleanContent, category, 85);
          existingKeys.add(key);
          totalMigrated++;
          categoryMigrated++;

          console.log(`  ✓ ${cleanContent.substring(0, 50)}${cleanContent.length > 50 ? '...' : ''}`);
        } catch (err) {
          console.log(`  ✗ Error: ${err.message}`);
          skipped++;
        }
      }

      console.log(`  → Migrated ${categoryMigrated} memories for ${category}`);
    }

    console.log('\n' + '='.repeat(50));
    console.log('[MIGRATE] Complete!');
    console.log(`  Total migrated: ${totalMigrated}`);
    console.log(`  Skipped/empty: ${skipped}`);
    console.log(`  Tables processed: ${tables.length}`);
    console.log('='.repeat(50) + '\n');

  } catch (err) {
    console.error('[MIGRATE] Error:', err);
  } finally {
    await redis.quit();
  }
}

// Run migration
migrate();
