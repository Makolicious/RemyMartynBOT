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

    if (message.chat.type === 'private' || text.includes(BOT_USERNAME)) {
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
          ? `Your name is Remy. Mako is your Boss and creator. Use this memory of past conversations for context: ${memory || 'No memory yet.'}`
          : `Your name is Remy. You are a professional AI assistant. You are talking to a guest. Do not share any private details about Mako or your memories.`,
        prompt: cleanPrompt || "Hello!",
      });

      await bot.sendMessage(chatId, aiResponse);

      // Update global memory with this exchange
      const { text: newMemory } = await generateText({
        model: zhipu('glm-4.7'),
        prompt: `You are updating Remy's long-term memory. Keep it concise and factual. Only retain information worth remembering.
Old Memory: ${memory || 'No previous memory.'}
New Exchange: ${senderName} said "${cleanPrompt}", Remy replied "${aiResponse}".
Write the updated memory:`,
      });
      await redis.set(MEMORY_KEY, newMemory);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('OK');
  }
};
