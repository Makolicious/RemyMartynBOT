const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
const FRIEND_USER_ID = Number(process.env.FRIEND_TELEGRAM_ID);
const BOT_USERNAME = '@remy_martyn_bot';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  try {
    const { message } = req.body;

    if (message && message.from && message.text) {
      const senderId = message.from.id;
      const isAuthorized = senderId === AUTHORIZED_USER_ID || senderId === FRIEND_USER_ID;

      // Check if bot is mentioned
      if (message.text.includes(BOT_USERNAME)) {
        const chatId = message.chat.id;

        if (!isAuthorized) {
          await bot.sendMessage(chatId, "Sorry, I only talk to my creator and authorized friends.");
          return res.status(200).send('OK');
        }

        await bot.sendChatAction(chatId, 'typing');

        // Clean @mention from the prompt
        const cleanPrompt = message.text.replace(BOT_USERNAME, '').trim();

        const { text } = await generateText({
          model: zhipu('glm-4.7'),
          apiKey: process.env.ZHIPU_API_KEY,
          prompt: cleanPrompt || "Hello!", 
        });

        await bot.sendMessage(chatId, text);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('Error handled');
  }
};