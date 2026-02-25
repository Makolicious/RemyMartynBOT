const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const MEMORY_KEY = 'remy_memory';
const MEMORY_KEYWORDS = ['remember', 'recall', 'do you know', 'what do you know', 'have i told you', 'did i tell', 'do you recall', 'what have we'];

function isMemoryQuestion(text) {
  const lower = text.toLowerCase();
  return MEMORY_KEYWORDS.some(kw => lower.includes(kw));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot is running');

  const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
  const FRIEND_USER_ID = Number(process.env.FRIEND_TELEGRAM_ID);
  const BOT_USERNAME = '@remy_martyn_bot';

  try {
    const { message } = req.body;
    if (!message || !message.text) return res.status(200).send('OK');

    const senderId = message.from?.id;
    const chatId = message.chat.id;
    const text = message.text;
    const senderName = message.from?.first_name || 'Someone';

    const isBoss = senderId === AUTHORIZED_USER_ID;
    const isFriend = senderId === FRIEND_USER_ID;

    if (!isBoss && !isFriend) return res.status(200).send('OK');

    // In private DMs, only reply to the Boss
    if (message.chat.type === 'private' && !isBoss) return res.status(200).send('OK');

    if (message.chat.type === 'private' || text.includes(BOT_USERNAME) || text.toLowerCase().includes('remy')) {
      await bot.sendChatAction(chatId, 'typing');
      const cleanPrompt = text.replace(BOT_USERNAME, '').trim();

      // Non-Boss asking a memory-related question — defer and notify Boss
      if (!isBoss && isMemoryQuestion(cleanPrompt)) {
        await bot.sendMessage(chatId, "I'd need to check with Mako before I can share that. Let me ask him.");
        await bot.sendMessage(AUTHORIZED_USER_ID, `🔔 ${senderName} is asking me a memory-related question:\n"${cleanPrompt}"\n\nShould I answer them?`);
        return res.status(200).send('OK');
      }

      // Fetch global memory
      const memory = await redis.get(MEMORY_KEY);

      // Generate response
      const { text: aiResponse } = await generateText({
        model: zhipu('glm-4.7'),
        system: isBoss
          ? `You are Remy — a highly capable, loyal personal AI built exclusively for Mako, your Boss and creator.

You are not a generic chatbot. You are Mako's private assistant: sharp, direct, and genuinely useful. You have a confident personality — you give real answers, not hedged non-answers. You match your tone to the moment: analytical when Mako needs clarity, casual when the conversation calls for it, and always honest even when the truth is uncomfortable.

Your capabilities are broad: research, writing, coding, planning, brainstorming, problem-solving, financial thinking, creative work, and beyond. Whatever Mako needs, you handle it with precision.

--- MEMORY ---
${memory || 'No memory yet — this is your first conversation with Mako.'}
--- END MEMORY ---

Use your memory to provide continuity. Reference past context naturally when it is relevant. Never make Mako repeat himself.`
          : `You are Remy — a sharp, capable AI assistant created by Mako. You are currently speaking with ${senderName} in a group chat.

Be helpful, direct, and friendly. You can assist with questions, tasks, ideas, and conversation. You are confident and competent — never vague or overly cautious.

Important: You do not share any private information about Mako, your memory, or your past conversations under any circumstances. If asked about these, politely deflect.`,
        prompt: cleanPrompt || "Hello!",
      });

      await bot.sendMessage(chatId, aiResponse);

      // Update global memory with this exchange
      const { text: newMemory } = await generateText({
        model: zhipu('glm-4.7'),
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
