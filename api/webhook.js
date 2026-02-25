const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

module.exports = async (req, res) => {
  // Always acknowledge the POST request immediately to stop Telegram from retrying
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  try {
    const { message } = req.body;
    
    // Log incoming message for debugging in Vercel Logs
    console.log("Incoming Message:", JSON.stringify(message));

    // Guard: Exit if there is no message or no text
    if (!message || !message.text) {
      return res.status(200).send('OK');
    }

    const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
    const FRIEND_USER_ID = Number(process.env.FRIEND_TELEGRAM_ID);
    const BOT_USERNAME = '@remy_martyn_bot'; // CHECK: Must match exactly (case-sensitive)

    const senderId = message.from?.id;
    const isAuthorized = senderId === AUTHORIZED_USER_ID || senderId === FRIEND_USER_ID;

    // Check for mention
    if (message.text.includes(BOT_USERNAME)) {
      if (!isAuthorized) {
        await bot.sendMessage(message.chat.id, "Access denied.");
        return res.status(200).send('OK');
      }

      await bot.sendChatAction(message.chat.id, 'typing');

      const cleanPrompt = message.text.replace(BOT_USERNAME, '').trim();

      const { text } = await generateText({
        model: zhipu('glm-4.7'),
        apiKey: process.env.ZHIPU_API_KEY,
        prompt: cleanPrompt || "Hello!",
      });

      await bot.sendMessage(message.chat.id, text);
    }

    res.status(200).send('OK');
  } catch (error) {
    // This prevents the "500 Internal Server Error" by catching it
    console.error('CRASH LOG:', error.message);
    res.status(200).send('Error suppressed'); 
  }
};