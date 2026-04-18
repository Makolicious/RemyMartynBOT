// ── Nightly reflection cron ───────────────────────────────────────────────────
// Runs once daily via Vercel cron. Pulls the last 24h of exchanges, asks Haiku
// to extract themes, open loops, and consolidated facts, and stashes the result
// as a dated entry in `remy_reflections` (ZSET).
//
// Intent: build a thin "daily memory" layer above individual turn logs, so
// future turns can reference "what we talked about yesterday" without having
// to re-read the whole raw log. This feeds later phases (active memory,
// topic threads).
//
// The endpoint is also safe to hit manually — it checks a 20-hour dedupe
// window so duplicate calls in the same day don't stack reflections.

const Redis = require('ioredis');
const { zai } = require('zhipu-ai-provider');
const { generateText } = require('ai');

let FALLBACK_MODEL = null;
let MEMORY_MODEL = null;
if (process.env.ANTHROPIC_API_KEY) {
  const { anthropic } = require('@ai-sdk/anthropic');
  FALLBACK_MODEL = anthropic(process.env.ANTHROPIC_CHAT_MODEL || 'claude-sonnet-4-6');
  MEMORY_MODEL = anthropic(process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5');
}
const GLM_MODEL = zai('glm-4-plus');

const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 5000,
  commandTimeout: 10000,
  maxRetriesPerRequest: 3,
});
redis.on('error', err => console.error('[REFLECT] Redis error:', err.message));

const KEY_REFLECTIONS = 'remy_reflections';
const KEY_LAST_RUN    = 'remy_reflection_last_run';
const KEY_RAW_LOG     = 'remy_raw_log';
const KEEP_REFLECTIONS = 30;       // rolling window
const MIN_HOURS_BETWEEN = 20;      // dedupe window so multiple calls same day don't stack

function isoDate(ts) { return new Date(ts).toISOString().slice(0, 10); }

async function generateReflection(entries, today) {
  const condensed = entries.flatMap(e => {
    try {
      const { ts, sender, msg, reply } = JSON.parse(e);
      if (!msg || !reply) return [];
      return [`[${ts?.split('T')[1]?.slice(0, 5) || '??:??'}] ${sender || 'unknown'}: "${msg.slice(0, 200)}" → Remy: "${reply.slice(0, 200)}"`];
    } catch { return []; }
  }).join('\n');

  if (!condensed) return null;

  const model = MEMORY_MODEL || FALLBACK_MODEL || GLM_MODEL;
  const { text } = await generateText({
    model,
    system: `You are Remy, summarizing the past 24 hours of your own conversations with the Boss. Output ONLY valid JSON — no prose, no markdown, no commentary.`,
    prompt: `Today is ${today}. Below is today's conversation log (Boss ↔ Remy). Produce a compact daily reflection as JSON:

{
  "date": "${today}",
  "themes": [<up to 5 short phrases capturing what the day was actually about>],
  "open_loops": [<up to 5 things that were raised but not resolved — things the Boss might want to revisit>],
  "key_facts": [<up to 5 concrete, durable facts learned today — names, numbers, decisions, commitments>],
  "mood": "<1-3 words describing Boss's overall energy today>",
  "summary": "<one tight sentence, max 180 chars>"
}

LOG:
${condensed.slice(0, 12000)}

Output the JSON object only. No preamble.`,
    temperature: 0.2,
    maxTokens: 800,
    abortSignal: AbortSignal.timeout(20000),
  });

  // Extract JSON block defensively
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed.summary) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    const today = isoDate(now);

    // Dedupe: skip if we ran recently
    const lastRun = parseInt(await redis.get(KEY_LAST_RUN) || '0');
    const hoursSince = (now - lastRun) / 3_600_000;
    if (hoursSince < MIN_HOURS_BETWEEN && !req.query?.force) {
      return res.status(200).json({ skipped: true, hoursSince: hoursSince.toFixed(1) });
    }

    // Pull last 24 hours of log entries (cap at 200 for memory safety)
    const entries = await redis.lrange(KEY_RAW_LOG, 0, 199);
    const cutoff = now - 24 * 3600 * 1000;
    const recent = entries.filter(e => {
      try { return new Date(JSON.parse(e).ts).getTime() >= cutoff; } catch { return false; }
    });

    if (recent.length < 3) {
      await redis.set(KEY_LAST_RUN, String(now));
      return res.status(200).json({ skipped: true, reason: 'not enough exchanges', count: recent.length });
    }

    console.log(`[REFLECT] ${today} — reflecting on ${recent.length} exchanges from the last 24h`);
    const reflection = await generateReflection(recent, today);
    if (!reflection) {
      await redis.set(KEY_LAST_RUN, String(now));
      return res.status(200).json({ skipped: true, reason: 'generation failed or empty' });
    }

    // Store — score by timestamp, value is JSON
    await redis.zadd(KEY_REFLECTIONS, now, JSON.stringify({ ...reflection, generatedAt: now }));
    // Trim to rolling window
    const total = await redis.zcard(KEY_REFLECTIONS);
    if (total > KEEP_REFLECTIONS) {
      await redis.zremrangebyrank(KEY_REFLECTIONS, 0, total - KEEP_REFLECTIONS - 1);
    }
    await redis.set(KEY_LAST_RUN, String(now));

    console.log(`[REFLECT] ${today} summary: ${reflection.summary?.slice(0, 120)}`);
    return res.status(200).json({ ok: true, date: today, reflection, entries: recent.length });
  } catch (err) {
    console.error('[REFLECT] Failed:', err);
    return res.status(200).json({ error: err.message });
  }
};
