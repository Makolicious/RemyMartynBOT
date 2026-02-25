const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env['5444040664']);

// Initialize the bot with your token from environment variables
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

module.exports = async (req, res) => {
  // Check if it's a POST request from Telegram
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const { message } = req.body;

    if (message && message.text) {
      const chatId = message.chat.id;

      // 1. Send a "typing..." action so the user knows the AI is thinking
      await bot.sendChatAction(chatId, 'typing');

      // 2. Call GLM-4.7 via Zhipu provider
      const { text } = await generateText({
        model: zhipu('glm-4.7'),
        apiKey: process.env.ZHIPU_API_KEY, // This will come from Vercel settings
        prompt: message.text,
      });

      // 3. Send the AI response back to the user
      await bot.sendMessage(chatId, text);
    }

    // Always tell Telegram you received the message
    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(500).send('Error processing message');
  }
};