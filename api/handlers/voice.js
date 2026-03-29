const { bot } = require('../lib/telegram');

// ── Voice message handler — transcribe via Groq Whisper ──────────────────────
// Returns the transcript string, or null if transcription failed (with user notified)
async function handleVoice(message, chatId) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    await bot.sendMessage(chatId, "Voice message received \u{2014} can't listen in just yet. Type it out for me.");
    return null;
  }

  try {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    const fileInfo = await bot.getFile(message.voice.file_id);
    const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const audioRes = await fetch(fileUrl);
    if (!audioRes.ok) throw new Error(`Telegram file fetch failed: ${audioRes.status}`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
    formData.append('model', 'whisper-large-v3');

    const whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}` },
      body: formData,
      signal: AbortSignal.timeout(15000),
    });
    if (!whisperRes.ok) throw new Error(`Groq Whisper ${whisperRes.status}: ${(await whisperRes.text()).slice(0, 200)}`);
    const whisperData = await whisperRes.json();
    const transcript = whisperData.text?.trim();
    if (!transcript) throw new Error('Empty transcript');
    console.log(`[VOICE] Transcribed: "${transcript.slice(0, 100)}"`);
    return transcript;
  } catch (err) {
    console.error('[VOICE] Transcription failed:', err.message);
    await bot.sendMessage(chatId, "Couldn't make out what you said. Try again or type it out.");
    return null;
  }
}

module.exports = { handleVoice };
