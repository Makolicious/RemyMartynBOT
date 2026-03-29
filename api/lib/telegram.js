const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const BOT_USERNAME = process.env.BOT_USERNAME || '@RemyMartynBot';
const BOSS_ID = Number(process.env.MY_TELEGRAM_ID);
const BOSS_NAME = process.env.BOSS_NAME || 'Mako';
const BOSS_ALIASES = process.env.BOSS_ALIASES || '';

// ── Safe message sending with chunking and Markdown fallback ──────────────────
async function safeSend(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }); }
    catch { await bot.sendMessage(chatId, chunk); }
  }
}

// ── Safe message editing with Markdown fallback ───────────────────────────────
async function safeEdit(chatId, messageId, text, replyMarkup) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'Markdown', reply_markup: replyMarkup,
    });
  } catch {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      reply_markup: replyMarkup,
    });
  }
}

// ── Inline Keyboard Menu ──────────────────────────────────────────────────────
const MAIN_MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🧠 Memory',    callback_data: 'menu_memory' },
      { text: '⏰ Reminders', callback_data: 'menu_reminders' },
    ],
    [
      { text: '📊 Stats',     callback_data: 'menu_stats' },
      { text: '📋 Log',       callback_data: 'menu_log' },
      { text: '👥 Status',    callback_data: 'menu_status' },
    ],
    [
      { text: '📰 Summarize', callback_data: 'menu_summarize' },
      { text: '📦 Export',    callback_data: 'menu_exportdata' },
    ],
    [
      { text: '🌍 Timezone',  callback_data: 'menu_timezone' },
      { text: '❓ Help',      callback_data: 'menu_help' },
    ],
  ],
};

function backButton() {
  return { inline_keyboard: [[{ text: '← Back to menu', callback_data: 'back_main' }]] };
}

module.exports = {
  bot,
  BOT_USERNAME,
  BOSS_ID,
  BOSS_NAME,
  BOSS_ALIASES,
  safeSend,
  safeEdit,
  MAIN_MENU_KEYBOARD,
  backButton,
};
