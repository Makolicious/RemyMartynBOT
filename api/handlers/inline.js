const { bot, BOSS_ID } = require('../lib/telegram');
const { redis, KEYS } = require('../lib/redis');
const { generateText, CHAT_MODEL, analyzeQueryComplexity } = require('../lib/models');
const { getBossTimezone, formatLocalTime } = require('../lib/time');

// ── Inline mode handler (@RemyMartynBot in any chat) ─────────────────────────
async function handleInlineQuery(query, res) {
  const senderId = query.from.id;
  const queryText = query.query?.trim();

  // Boss-only
  if (senderId !== BOSS_ID) {
    await bot.answerInlineQuery(query.id, []);
    return res.status(200).send('OK');
  }

  // Empty query — user just typed @RemyMartynBot
  if (!queryText) {
    await bot.answerInlineQuery(query.id, []);
    return res.status(200).send('OK');
  }

  const { complexity, maxTokens } = analyzeQueryComplexity(queryText);
  const bossTimezone = await getBossTimezone(redis, KEYS.TIMEZONE);
  const currentTime = formatLocalTime(bossTimezone);

  let systemPrompt;
  if (complexity === 'simple') {
    systemPrompt = `You are Remy \u{2014} a sharp, concise AI assistant. Current time: ${currentTime}. Answer in 1-2 sentences. No fluff.`;
  } else if (complexity === 'medium') {
    systemPrompt = `You are Remy \u{2014} a sharp, concise AI assistant. Current time: ${currentTime}. Answer in 2-3 sentences. No fluff.`;
  } else {
    systemPrompt = `You are Remy \u{2014} a sharp, concise AI assistant. Current time: ${currentTime}. Answer in 3-5 sentences. No fluff.`;
  }

  console.log(`[INLINE] Complexity: ${complexity}, maxTokens: ${maxTokens}, Query: "${queryText.slice(0, 50)}"...`);

  try {
    const { text: answer } = await generateText({
      model: CHAT_MODEL,
      system: systemPrompt,
      messages: [{ role: 'user', content: queryText }],
      maxTokens,
      temperature: 0.7,
      abortSignal: AbortSignal.timeout(8000),
    });

    const result = {
      type: 'article',
      id: `remy_${Date.now()}`,
      title: answer.slice(0, 50) + (answer.length > 50 ? '...' : ''),
      description: answer.slice(0, 200),
      input_message_content: { message_text: answer },
    };

    await bot.answerInlineQuery(query.id, [result], { cache_time: 5 });
    console.log(`[INLINE] Answered: "${queryText.slice(0, 50)}" \u{2192} "${answer.slice(0, 80)}"`);
  } catch (err) {
    console.error('[INLINE] Failed:', err.message);
    await bot.answerInlineQuery(query.id, [{
      type: 'article',
      id: `remy_err_${Date.now()}`,
      title: "Couldn't think fast enough",
      description: 'Try asking in DMs instead',
      input_message_content: { message_text: '\u{26A0}\u{FE0F} Remy timed out on that one. Try asking in DMs.' },
    }], { cache_time: 5 });
  }

  return res.status(200).send('OK');
}

module.exports = { handleInlineQuery };
