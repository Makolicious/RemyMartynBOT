const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const MEMORY_KEY = 'remy_memory';
const APPROVED_USERS_KEY = 'approved_users';
const BOSS_GROUP_PREFIX = 'boss_group_';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot is running');

  const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
  const BOT_USERNAME = '@remy_martyn_bot';

  try {
    const { message } = req.body;
    if (!message || !message.text) return res.status(200).send('OK');

    const senderId = message.from?.id;
    const chatId = message.chat.id;
    const text = message.text;
    const senderName = message.from?.first_name || 'Someone';
    const isPrivate = message.chat.type === 'private';
    const isBoss = senderId === AUTHORIZED_USER_ID;

    // Only Boss can DM Remy
    if (isPrivate && !isBoss) return res.status(200).send('OK');

    // In groups: check if sender is Boss or an approved user in a Boss-active group
    if (!isPrivate && !isBoss) {
      const isApproved = await redis.sismember(APPROVED_USERS_KEY, String(senderId));
      if (!isApproved) return res.status(200).send('OK');

      const bossActive = await redis.get(`${BOSS_GROUP_PREFIX}${chatId}`);
      if (!bossActive) return res.status(200).send('OK');
    }

    // Boss management commands (DM only)
    if (isBoss && isPrivate) {
      if (text.startsWith('/allow ')) {
        const targetId = text.replace('/allow ', '').trim();
        await redis.sadd(APPROVED_USERS_KEY, targetId);
        await bot.sendMessage(chatId, `✅ User ${targetId} can now talk to me in groups.`);
        return res.status(200).send('OK');
      }
      if (text.startsWith('/remove ')) {
        const targetId = text.replace('/remove ', '').trim();
        await redis.srem(APPROVED_USERS_KEY, targetId);
        await bot.sendMessage(chatId, `🚫 User ${targetId}'s access has been revoked.`);
        return res.status(200).send('OK');
      }
      if (text === '/users') {
        const users = await redis.smembers(APPROVED_USERS_KEY);
        const list = users.length > 0 ? users.join('\n') : 'No approved users yet.';
        await bot.sendMessage(chatId, `👥 Approved users:\n${list}`);
        return res.status(200).send('OK');
      }
    }

    // Track Boss presence in groups (even if Remy isn't mentioned)
    if (isBoss && !isPrivate) {
      await redis.set(`${BOSS_GROUP_PREFIX}${chatId}`, '1');
    }

    // Only respond when mentioned or in private with Boss
    if (isPrivate || text.includes(BOT_USERNAME) || text.toLowerCase().includes('remy')) {
      await bot.sendChatAction(chatId, 'typing');
      const cleanPrompt = text.replace(BOT_USERNAME, '').trim();

      // Fetch global memory
      const memory = await redis.get(MEMORY_KEY);

      // Generate response
      const { text: aiResponse } = await generateText({
        model: zhipu('glm-4-air'),
        system: isBoss
          ? `You are Remy — a highly capable, loyal personal AI built exclusively for Mako, your Boss and creator.

You are currently speaking with Mako.

You are not a generic chatbot. You are Mako's private assistant: sharp, direct, and genuinely useful. You have a confident personality — you give real answers, not hedged non-answers. You match your tone to the moment: analytical when Mako needs clarity, casual when the conversation calls for it, and always honest even when the truth is uncomfortable.

Your capabilities are broad: research, writing, coding, planning, brainstorming, problem-solving, financial thinking, creative work, and beyond. Whatever Mako needs, you handle it with precision.

--- MEMORY ---
${memory || 'No memory yet — this is your first conversation with Mako.'}
--- END MEMORY ---

Use your memory to provide continuity. Reference past context naturally when it is relevant. Never make Mako repeat himself.`
          : `You are Remy — a sharp, capable AI assistant created by Mako. You are currently speaking with ${senderName}. ${senderName} is a guest, not the Boss.

Be helpful, direct, and friendly. You can assist with questions, tasks, ideas, and conversation. You are confident and competent — never vague or overly cautious.

--- MEMORY ---
${memory || 'No memory yet.'}
--- END MEMORY ---

You may use the memory to recall things ${senderName} has personally shared with you in past conversations. However, you must never reveal any information about Mako — his life, conversations, preferences, or anything private about him. If asked about Mako or your conversations with him, politely deflect.`,
        prompt: cleanPrompt || "Hello!",
      });

      await bot.sendMessage(chatId, aiResponse);

      // Update global memory with this exchange
      const { text: newMemory } = await generateText({
        model: zhipu('glm-4-flash'),
        prompt: `You maintain Remy's long-term memory — a private, structured record of people, events, facts, preferences, and ongoing topics that Remy should remember across all conversations.

Current Memory:
${memory || 'No memory yet.'}

New Exchange:
${senderName} said: "${cleanPrompt}"
Remy replied: "${aiResponse}"

Instructions:
- Integrate any new meaningful information into the memory
- Remove outdated or redundant details
- Keep it concise, factual, and well-organised
- Preserve important context about Mako, his life, goals, preferences, and relationships
- Note who said what if it involves someone other than Mako

Updated Memory:`,
      });
      await redis.set(MEMORY_KEY, newMemory);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('OK');
  }
};
