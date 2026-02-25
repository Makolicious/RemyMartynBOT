const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

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

    // 1. Check Permissions & Ignore List
    const isAuthorized = senderId === AUTHORIZED_USER_ID || senderId === Number(process.env.FRIEND_TELEGRAM_ID);
    const isIgnored = await kv.get(`ignore_id_${senderId}`);
    if (isIgnored || (!isAuthorized && text.includes(BOT_USERNAME))) {
      if (!isIgnored && text.includes(BOT_USERNAME)) await bot.sendMessage(chatId, "Access denied.");
      return res.status(200).send('OK');
    }

    if (message.chat.type === 'private' || text.includes(BOT_USERNAME)) {
      await bot.sendChatAction(chatId, 'typing');

      // 2. Fetch the "Running Summary"
      const currentSummary = await kv.get(`summary_${chatId}`) || "No previous context.";

      // 3. Generate the Response
      const { text: aiResponse } = await generateText({
        model: zhipu('glm-4.7'),
        apiKey: process.env.ZHIPU_API_KEY,
        system: `Your name is Remy. Mako is the Boss. 
                 Current context of your relationship/conversation: ${currentSummary}`,
        prompt: text.replace(BOT_USERNAME, '').trim(),
      });

      await bot.sendMessage(chatId, aiResponse);

      // 4. Update the Summary (Background task)
      const { text: newSummary } = await generateText({
        model: zhipu('glm-4.7'),
        apiKey: process.env.ZHIPU_API_KEY,
        prompt: `Condense the following into a short, permanent memory summary for an AI:
                 Old Summary: ${currentSummary}
                 New Exchange: User said "${text}", Remy replied "${aiResponse}".
                 Keep it under 200 words but retain key facts and the "Boss" relationship.`,
      });

      await kv.set(`summary_${chatId}`, newSummary);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('OK');
  }
};