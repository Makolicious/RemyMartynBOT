const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 5000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 1,
});

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const MEMORY_KEY      = 'remy_memory';
const APPROVED_KEY    = 'approved_users';
const BOSS_GRP_PREFIX = 'boss_group_';
const HIST_PREFIX     = 'history_';
const MAX_HIST_MSGS   = 12; // 6 exchanges

async function safeSend(chatId, text) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch {
    await bot.sendMessage(chatId, text);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot is running');

  const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
  const BOT_USERNAME = '@remy_martyn_bot';

  try {
    const { message } = req.body;
    if (!message || !message.text) return res.status(200).send('OK');

    const senderId  = message.from?.id;
    const chatId    = message.chat.id;
    const text      = message.text;
    const senderName = message.from?.first_name || 'Someone';
    const isPrivate = message.chat.type === 'private';
    const isBoss    = senderId === AUTHORIZED_USER_ID;

    // Only Boss can DM Remy
    if (isPrivate && !isBoss) return res.status(200).send('OK');

    // In groups: sender must be Boss or an approved user in a Boss-active group
    if (!isPrivate && !isBoss) {
      const [isApproved, bossActive] = await Promise.all([
        redis.sismember(APPROVED_KEY, String(senderId)),
        redis.get(`${BOSS_GRP_PREFIX}${chatId}`)
      ]);
      if (!isApproved || !bossActive) return res.status(200).send('OK');
    }

    // ── Boss commands (DM only) ──────────────────────────────────────────────
    if (isBoss && isPrivate) {
      if (text.startsWith('/allow ')) {
        const id = text.slice(7).trim();
        await redis.sadd(APPROVED_KEY, id);
        await bot.sendMessage(chatId, `✅ User \`${id}\` can now talk to me in groups.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      if (text.startsWith('/remove ')) {
        const id = text.slice(8).trim();
        await redis.srem(APPROVED_KEY, id);
        await bot.sendMessage(chatId, `🚫 User \`${id}\` access revoked.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      if (text === '/status') {
        const [users, groupKeys] = await Promise.all([
          redis.smembers(APPROVED_KEY),
          redis.keys(`${BOSS_GRP_PREFIX}*`)
        ]);
        const userList  = users.length     ? users.map(u => `• \`${u}\``).join('\n')                                 : '_None_';
        const groupList = groupKeys.length ? groupKeys.map(k => `• \`${k.replace(BOSS_GRP_PREFIX, '')}\``).join('\n') : '_None_';
        await bot.sendMessage(chatId, `👥 *Approved users:*\n${userList}\n\n📍 *Active groups:*\n${groupList}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      if (text === '/memory') {
        const memory = await redis.get(MEMORY_KEY);
        await bot.sendMessage(chatId, memory ? `🧠 *My memory:*\n\n${memory}` : '🧠 No memory yet.', { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
      if (text === '/clearmemory') {
        await redis.del(MEMORY_KEY);
        await bot.sendMessage(chatId, '🗑️ Memory wiped.');
        return res.status(200).send('OK');
      }
      if (text === '/clearhistory') {
        await redis.del(`${HIST_PREFIX}${chatId}`);
        await bot.sendMessage(chatId, '🗑️ Conversation history cleared for this chat.');
        return res.status(200).send('OK');
      }
      if (text === '/help') {
        await bot.sendMessage(chatId,
          `*Remy commands:*\n\n` +
          `\`/allow <id>\` — grant group access\n` +
          `\`/remove <id>\` — revoke access\n` +
          `\`/status\` — approved users & active groups\n` +
          `\`/memory\` — view my memory\n` +
          `\`/clearmemory\` — wipe memory\n` +
          `\`/clearhistory\` — clear this chat's history`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }
    }

    // Track Boss presence in groups
    if (isBoss && !isPrivate) {
      redis.set(`${BOSS_GRP_PREFIX}${chatId}`, '1').catch(() => {});
    }

    // Only respond when mentioned, called by name, or Boss DM
    if (!isPrivate && !text.includes(BOT_USERNAME) && !text.toLowerCase().includes('remy')) {
      return res.status(200).send('OK');
    }

    // ── Generate response ────────────────────────────────────────────────────
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      await bot.sendChatAction(chatId, 'typing');
      const cleanPrompt = text.replace(BOT_USERNAME, '').trim() || 'Hello!';

      // Fetch memory + history in parallel
      const [memory, rawHistory] = await Promise.all([
        redis.get(MEMORY_KEY),
        redis.lrange(`${HIST_PREFIX}${chatId}`, 0, MAX_HIST_MSGS - 1)
      ]);

      // History stored newest-first — reverse for chronological order
      const history = rawHistory.map(e => JSON.parse(e)).reverse();

      const systemPrompt = isBoss
        ? `You are Remy — a highly capable, loyal personal AI built exclusively for Mako, your Boss and creator.

You are currently speaking with Mako.

You are not a generic chatbot. You are Mako's private assistant: sharp, direct, and genuinely useful. You have a confident personality — you give real answers, not hedged non-answers. You match your tone to the moment: analytical when Mako needs clarity, casual when the conversation calls for it, and always honest even when the truth is uncomfortable.

Your capabilities are broad: research, writing, coding, planning, brainstorming, problem-solving, financial thinking, creative work, and beyond. Whatever Mako needs, you handle it with precision.

--- MEMORY ---
${memory || 'No memory yet — this is your first conversation with Mako.'}
--- END MEMORY ---

Use your memory to provide continuity. Reference past context naturally when it is relevant. Never make Mako repeat himself.
Use Markdown formatting where it improves clarity — **bold** for emphasis, bullet points for lists, \`code\` for code.`
        : `You are Remy — a sharp, capable AI assistant created by Mako. You are currently speaking with ${senderName}. ${senderName} is a guest, not the Boss.

Be helpful, direct, and friendly. You can assist with questions, tasks, ideas, and conversation. Never be vague or overly cautious.

--- MEMORY ---
${memory || 'No memory yet.'}
--- END MEMORY ---

You may reference things ${senderName} has personally shared with you. Never reveal anything about Mako — his life, conversations, or private details. Politely deflect if asked.
Use Markdown formatting where it improves clarity.`;

      const { text: aiResponse } = await generateText({
        model: zhipu('glm-4.7'),
        system: systemPrompt,
        messages: [
          ...history,
          { role: 'user', content: cleanPrompt }
        ],
      });

      await safeSend(chatId, aiResponse);

      // Return to Telegram immediately
      res.status(200).send('OK');

      // Background: save history + update memory
      const histKey = `${HIST_PREFIX}${chatId}`;
      Promise.all([
        // Push newest exchange to front (user first so assistant ends up at head)
        redis.lpush(histKey,
          JSON.stringify({ role: 'user', content: cleanPrompt }),
          JSON.stringify({ role: 'assistant', content: aiResponse })
        ).then(() => redis.ltrim(histKey, 0, MAX_HIST_MSGS - 1)),

        generateText({
          model: zhipu('glm-4-flash'),
          prompt: `You maintain Remy's private long-term memory.

Current Memory:
${memory || 'No memory yet.'}

New Exchange:
${senderName} said: "${cleanPrompt}"
Remy replied: "${aiResponse}"

Instructions:
- Integrate meaningful new information
- Remove outdated or redundant details
- Keep it concise, factual, and well-organised
- Preserve key context about Mako: his life, goals, preferences, relationships
- Note who said what for non-Mako exchanges

Write only the updated memory:`,
        }).then(({ text: newMemory }) => redis.set(MEMORY_KEY, newMemory))
      ]).catch(err => console.error('Background update failed:', err));

    } finally {
      clearInterval(typingInterval);
    }

    return;

  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('OK');
  }
};
