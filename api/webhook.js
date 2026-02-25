// ... existing imports and IDs ...

module.exports = async (req, res) => {
  // ... existing POST check ...
  try {
    const { message } = req.body;
    if (!message || !message.text) return res.status(200).send('OK');

    const senderId = message.from?.id;
    const isAuthorized = senderId === AUTHORIZED_USER_ID || senderId === FRIEND_USER_ID;
    
    // Check if it's a private chat or a mention in a group
    const isPrivateChat = message.chat.type === 'private';
    const isMentioned = message.text.includes(BOT_USERNAME);

    // Trigger AI if (It's a Private DM) OR (Bot is mentioned in a Group)
    if (isPrivateChat || isMentioned) {
      
      if (!isAuthorized) {
        await bot.sendMessage(message.chat.id, "Sorry, I only talk to authorized users.");
        return res.status(200).send('OK');
      }

      await bot.sendChatAction(message.chat.id, 'typing');

      // Clean the prompt only if there was a mention
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
    console.error('Bot Error:', error);
    res.status(200).send('OK');
  }
};