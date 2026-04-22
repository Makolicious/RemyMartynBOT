// Run: node scripts/check-cron-jobs.js (from project root)
const path = require('path');
try { require(path.join(__dirname, '../node_modules/dotenv')).config({ path: path.join(__dirname, '../.env.local') }); } catch {}
const Redis = require(path.join(__dirname, '../node_modules/ioredis'));

const redis = new Redis(process.env.REDIS_URL, { connectTimeout: 5000, maxRetriesPerRequest: 1 });
const CRON_JOBS_KEY = 'remy_cron_jobs';
const CRON_PREFIX   = 'remy_cron:';

async function main() {
  console.log('Connecting to Redis...\n');

  // All job IDs in the sorted set (with scores = next fire timestamps)
  const all = await redis.zrangebyscore(CRON_JOBS_KEY, '-inf', '+inf', 'WITHSCORES');

  if (!all.length) {
    console.log('No cron jobs found in Redis (remy_cron_jobs is empty or missing).');
    await redis.quit();
    return;
  }

  console.log(`Found ${all.length / 2} job(s) in remy_cron_jobs:\n`);

  for (let i = 0; i < all.length; i += 2) {
    const jobId    = all[i];
    const nextFire = parseInt(all[i + 1]);
    const job      = await redis.hgetall(`${CRON_PREFIX}${jobId}`);

    console.log(`--- Job ${Math.floor(i / 2) + 1} ---`);
    console.log(`ID:       ${jobId}`);
    console.log(`Next:     ${new Date(nextFire).toLocaleString()}`);
    if (!job || !Object.keys(job).length) {
      console.log(`ORPHANED — ID exists in sorted set but no hash data found`);
    } else {
      console.log(`Message:  ${job.message}`);
      console.log(`Repeat:   ${job.repeat} @ ${job.time}`);
      console.log(`Type:     ${job.jobType || 'message (static)'}`);
      console.log(`Enabled:  ${job.enabled !== 'false' ? 'yes' : 'PAUSED'}`);
      console.log(`Chat ID:  ${job.chatId || '(missing — will use BOSS_ID fallback)'}`);
      console.log(`Fires:    ${job.fireCount || 0}x${job.lastFired ? `, last: ${new Date(parseInt(job.lastFired)).toLocaleString()}` : ', never fired'}`);
      console.log(`Created:  ${job.createdAt || 'unknown'}`);
    }
    console.log('');
  }

  // Also check for orphaned hashes (hash exists but not in sorted set)
  const allHashKeys = await redis.keys(`${CRON_PREFIX}*`);
  const registeredIds = new Set();
  for (let i = 0; i < all.length; i += 2) registeredIds.add(all[i]);

  const orphanedHashes = allHashKeys.filter(k => !registeredIds.has(k.replace(CRON_PREFIX, '')));
  if (orphanedHashes.length) {
    console.log(`\n⚠️  Found ${orphanedHashes.length} orphaned hash(es) not in the sorted set:`);
    for (const key of orphanedHashes) {
      const job = await redis.hgetall(key);
      console.log(`  ${key}: "${job.message}" (${job.repeat} @ ${job.time})`);
    }
  }

  await redis.quit();
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
