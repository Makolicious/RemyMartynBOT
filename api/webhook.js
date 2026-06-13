// ── Remy Webhook — Thin Router ────────────────────────────────────────────────
// All logic lives in handlers/, middleware/, tools/, and lib/
// This file only validates, authenticates, and dispatches.

const { bot, BOT_USERNAME, BOSS_ID } = require('./lib/telegram');
const { redis, KEYS } = require('./lib/redis');
const { authenticate, dedup } = require('./middleware/auth');
const { handleCallbackQuery } = require('./handlers/callbacks');
const { handleInlineQuery } = require('./handlers/inline');
const { handleCommand } = require('./handlers/commands');
const { handleVoice } = require('./handlers/voice');
const { handleChat } = require('./handlers/chat');

// ── Validate required env vars on cold start ─────────────────────────────────
const REQUIRED_ENV = ['TELEGRAM_TOKEN', 'MY_TELEGRAM_ID', 'REDIS_URL', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot is running');

  try {
    const { message, callback_query, inline_query } = req.body;

    // ── Callback queries (inline keyboard taps) ────────────────────────────
    if (callback_query) return handleCallbackQuery(callback_query, res);

    // ── Inline mode (@RemyMartynBot in any chat) ───────────────────────────
    if (inline_query) return handleInlineQuery(inline_query, res);

    // ── No message — nothing to do ─────────────────────────────────────────
    if (!message) {
      console.log('[SKIP] No message in body, keys:', Object.keys(req.body));
      return res.status(200).send('OK');
    }

    const chatId     = message.chat.id;
    const senderId   = message.from?.id;
    const senderName = message.from?.first_name || 'Someone';
    const isPrivate  = message.chat.type === 'private';
    const isBoss     = senderId === BOSS_ID;
    const rawText    = message.text || '';
    // Strip @BotUsername suffix from commands
    const botUser = BOT_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const text = rawText.startsWith('/')
      ? rawText.replace(new RegExp('(^/\\w+)' + botUser, 'i'), '$1').trim()
      : rawText;

    console.log(`[MSG] from=${senderName}(${senderId}) chat=${chatId} private=${isPrivate} isBoss=${isBoss} text="${text.slice(0,50)}"`);

    // ── Welcome new group members ──────────────────────────────────────────
    if (message.new_chat_members) {
      const bossActive = await redis.get(KEYS.BOSS_GRP(chatId));
      if (bossActive) {
        for (const member of message.new_chat_members) {
          if (member.is_bot) continue;
          await bot.sendMessage(chatId, `Welcome to the group, ${member.first_name}. I'm Remy. You're in good company.`);
        }
      }
      return res.status(200).send('OK');
    }

    // ── Only process text, photo, and voice messages ───────────────────────
    if (!message.text && !message.photo && !message.voice) {
      console.log('[SKIP] Not text/photo/voice');
      return res.status(200).send('OK');
    }

    // ── Dedup: ignore Telegram webhook retries ─────────────────────────────
    const isNew = await dedup(message.message_id);
    if (!isNew) { console.log('[SKIP] Dedup hit'); return res.status(200).send('OK'); }

    // ── Access control ─────────────────────────────────────────────────────
    const { authorized, role } = await authenticate(message);
    if (!authorized) return res.status(200).send('OK');

    // ── Boss commands (DM only) ────────────────────────────────────────────
    if (isBoss && isPrivate && text.startsWith('/')) {
      return handleCommand(message, chatId, text, res);
    }

    // ── In groups, ignore slash commands from non-boss users ───────────────
    if (!isPrivate && text.startsWith('/')) return res.status(200).send('OK');

    // ── Track Boss presence in groups ──────────────────────────────────────
    if (isBoss && !isPrivate) {
      redis.set(KEYS.BOSS_GRP(chatId), '1').catch(() => {});
    }

    // ── In groups: only respond when @mentioned or replied to ──────────────
    const triggerText = text || message.caption || '';
    const botUsername = BOT_USERNAME.replace('@', '').toLowerCase();
    const isReplyToBot = message.reply_to_message?.from?.username?.toLowerCase() === botUsername;
    if (!isPrivate && !triggerText.toLowerCase().includes(BOT_USERNAME.toLowerCase()) && !isReplyToBot) {
      return res.status(200).send('OK');
    }

    // ── Voice messages — transcribe first ──────────────────────────────────
    let voiceTranscript = null;
    if (message.voice) {
      voiceTranscript = await handleVoice(message, chatId);
      if (!voiceTranscript) return res.status(200).send('OK');
    }

    // ── Clean prompt ───────────────────────────────────────────────────────
    const rawPrompt = message.photo
      ? (message.caption || 'What do you see in this image?')
      : (voiceTranscript || text);
    const cleanPrompt = rawPrompt.replace(new RegExp(BOT_USERNAME, 'i'), '').trim() || 'Hello!';

    // ── Hand off to AI chat handler ────────────────────────────────────────
    return handleChat(message, chatId, cleanPrompt, senderName, isBoss, isPrivate, voiceTranscript, res);

  } catch (error) {
    console.error('Bot Error:', error);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await bot.sendMessage(chatId, '\u26A0\uFE0F Something broke on my end. Try again.').catch(() => {});
    } catch {}
    if (!res.headersSent) res.status(200).send('OK');
  }
};
