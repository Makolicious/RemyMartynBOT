const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
// Replace with your actual bot username
const BOT_USERNAME = '@remy_martyn_bot'; 

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  try {
    const { message } = req.body;

    // 1. Verify it's YOU and the message has text
    if (message && message.from && message.from.id === AUTHORIZED_USER_ID && message.text) {
      
      // 2. ONLY proceed if the bot is mentioned
      if (message.text.includes(BOT_USERNAME)) {
        const chatId = message.chat.id;

        await bot.sendChatAction(chatId, 'typing');

        // Clean the prompt by removing the @mention so the AI doesn't get confused
        const cleanPrompt = message.text.replace(BOT_USERNAME, '').trim();

        const { text } = await generateText({
          model: zhipu('glm-4.7'),
          apiKey: process.env.ZHIPU_API_KEY,
          prompt: cleanPrompt || "Hello!", // Fallback if it's just a mention
        });

        await bot.sendMessage(chatId, text);
      }
      // If you messaged the bot but didn't mention it, the bot stays silent.
      
    } else if (message && message.text && message.text.includes(BOT_USERNAME)) {
      // 3. If someone else mentions the bot, tell them no.
      await bot.sendMessage(message.chat.id, "Sorry, I only talk to my creator.");
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('Error handled');
  }
};