const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

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

    // 1. Permission Check — allowlist only
    const isBoss = senderId === AUTHORIZED_USER_ID;
    const isFriend = senderId === FRIEND_USER_ID;

    if (!isBoss && !isFriend) return res.status(200).send('OK');

    if (message.chat.type === 'private' || text.includes(BOT_USERNAME)) {
      await bot.sendChatAction(chatId, 'typing');
      const cleanPrompt = text.replace(BOT_USERNAME, '').trim();

      // 2. PRIVATE MEMORY LOGIC: Only fetch summary if the Boss is talking
      let currentSummary = "No context available.";
      if (isBoss) {
        currentSummary = await redis.get(`summary_${chatId}`) || "This is your first deep conversation with the Boss.";
      }

      // 3. Generate Response
      const { text: aiResponse } = await generateText({
        model: zhipu('glm-4.7'),
        system: isBoss
          ? `Your name is Remy. Mako is the Boss. Use this private summary for context: ${currentSummary}`
          : `Your name is Remy. You are a professional AI assistant. You are talking to a guest, not the Boss. Do not mention any private details about Mako or your past conversations with him.`,
        prompt: cleanPrompt || "Hello!",
      });

      await bot.sendMessage(chatId, aiResponse);

      // 4. UPDATE MEMORY: Only if the Boss is talking
      if (isBoss) {
        const { text: newSummary } = await generateText({
          model: zhipu('glm-4.7'),
          prompt: `Update the private memory summary.
                   Old Summary: ${currentSummary}
                   Newest Exchange: Mako said "${cleanPrompt}", you replied "${aiResponse}".
                   Keep the summary concise and focused on facts Mako would want you to remember.`,
        });
        await redis.set(`summary_${chatId}`, newSummary);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('OK');
  }
};