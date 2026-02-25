const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

// Best practice: Store your ID in Vercel Environment Variables as MY_TELEGRAM_ID
const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  try {
    const { message } = req.body;

    // Check if the message exists and if the sender is YOU
    if (message && message.from && message.from.id === AUTHORIZED_USER_ID) {
      if (message.text) {
        const chatId = message.chat.id;

        await bot.sendChatAction(chatId, 'typing');

        const { text } = await generateText({
          model: zhipu('glm-4.7'),
          apiKey: process.env.ZHIPU_API_KEY,
          prompt: message.text,
        });

        await bot.sendMessage(chatId, text);
      }
    } else if (message) {
      // Optional: Tell unauthorized users to go away
      await bot.sendMessage(message.chat.id, "Sorry, I only talk to my creator.");
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('Error handled');
  }
};