const { bot } = require('../lib/telegram');
const { redis, KEYS } = require('../lib/redis');
const { parseReminderTime, getBossTimezone } = require('../lib/time');
const memory = require('../memory');

// ── Voice message handler — transcribe via Groq Whisper ──────────────────────
// Returns the transcript string, or null if transcription failed (with user notified)
async function handleVoice(message, chatId) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    await bot.sendMessage(chatId, "Voice isn't configured yet \u{2014} GROQ_API_KEY is missing. Type it out for now, Boss.");
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

// ── Voice smart routing: check if voice note is a reminder, expense, or pin ──
// Returns true if handled (caller should return), false to continue to AI chat
async function handleVoiceRouting(voiceTranscript, chatId) {
  const vt = voiceTranscript;

  // Check for reminder in voice
  const voiceReminderMatch = vt.match(/^(?:remind\s+me|set\s+a?\s*reminder|reminder)\s+(.+)$/i);
  if (voiceReminderMatch) {
    const tz = await getBossTimezone(redis, KEYS.TIMEZONE);
    const parsed = parseReminderTime(voiceReminderMatch[1], tz);
    if (parsed) {
      await redis.zadd(KEYS.REMINDERS, parsed.ts, JSON.stringify({ chatId, message: parsed.message, id: Date.now() }));
      const timeStr = new Date(parsed.ts).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
      await bot.sendMessage(chatId, `\u{1F399}\u{FE0F} \u{23F0} Voice reminder set for *${timeStr}*: "${parsed.message}"`, { parse_mode: 'Markdown' });
      return true;
    }
  }

  // Check for expense in voice
  const voiceExpense = vt.match(/(?:spent|bought|purchased|paid|picked up)\s+\$?([\d,.]+)\s+(?:at|from|on)\s+(.+?)(?:\s+for\s+(?:the\s+)?(.+?))?$/i);
  if (voiceExpense) {
    const amount = voiceExpense[1].replace(',', '');
    const vendor = voiceExpense[2].trim().replace(/[.,]+$/, '');
    const jobName = voiceExpense[3]?.trim().replace(/[.,]+$/, '') || 'general';
    const logEntry = `$${amount} at ${vendor} for ${jobName} (${new Date().toLocaleDateString('en-US')})`;
    try {
      await memory.addMemory(logEntry, 'work_projects', 70);
      await bot.sendMessage(chatId, `\u{1F399}\u{FE0F} \u{1F4B0} *Logged:* $${amount} at ${vendor}\n\u{1F4C1} Job: ${jobName}`, { parse_mode: 'Markdown' });
      return true;
    } catch (err) { console.error('[VOICE] Expense log failed:', err.message); }
  }

  // Check for pin in voice
  const voicePin = vt.match(/^(?:pin|save|note)\s*[:\-]?\s*(.+)$/i);
  if (voicePin && voicePin[1].length > 10) {
    try {
      await memory.addMemory(voicePin[1].trim(), 'personal_preferences', 90, true);
      await bot.sendMessage(chatId, `\u{1F399}\u{FE0F} \u{1F4CC} *Pinned:* "${voicePin[1].trim().slice(0, 80)}"`, { parse_mode: 'Markdown' });
      return true;
    } catch (err) { console.error('[VOICE] Pin failed:', err.message); }
  }

  return false;
}

module.exports = { handleVoice, handleVoiceRouting };
