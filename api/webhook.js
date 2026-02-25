const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot is running');

  // 1. Properly scoped variables
  const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
  const FRIEND_USER_ID = Number(process.env.FRIEND_TELEGRAM_ID);
  const BOT_USERNAME = '@remy_martyn_bot'; 

  try {
    const { message } = req.body;
    if (!message || !message.text) return res.status(200).send('OK');

    const senderId = message.from?.id;
    const isAuthorized = senderId === AUTHORIZED_USER_ID || senderId === FRIEND_USER_ID;
    const isPrivateChat = message.chat.type === 'private';
    const isMentioned = message.text.includes(BOT_USERNAME);

    if (isPrivateChat || isMentioned) {
      if (!isAuthorized) {
        await bot.sendMessage(message.chat.id, "Access denied.");
        return res.status(200).send('OK');
      }

      await bot.sendChatAction(message.chat.id, 'typing');
      const cleanPrompt = message.text.replace(BOT_USERNAME, '').trim();

      // 2. Identity Memory via System Prompt
      const { text } = await generateText({
        model: zhipu('glm-4.7'),
        apiKey: process.env.ZHIPU_API_KEY,
        system: `Your name is Remy. You are a sophisticated AI assistant. 
                 Your creator and "the Boss" is Mako. 
                 Always address Mako with respect, acknowledge him as the Boss, 
                 and maintain a helpful yet witty personality.`,
        prompt: cleanPrompt || "Hello!",
     // Add this to satisfy the Zhipu provider requirements:
      toolChoice: 'auto', 
      });

      await bot.sendMessage(message.chat.id, text);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('OK');
  }
};