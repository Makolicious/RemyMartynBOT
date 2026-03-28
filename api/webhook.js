const { zai } = require('zhipu-ai-provider');
const { generateText } = require('ai');

const CHAT_MODEL    = zai('glm-4-plus');  // Proven fast chat model
const UTILITY_MODEL = zai('glm-5');    // memory rebuild, summarize, reasoning

// Anthropic models — Sonnet for fallback chat + memory extraction
let FALLBACK_MODEL = null;
let MEMORY_MODEL = null;
if (process.env.ANTHROPIC_API_KEY) {
  const { anthropic } = require('@ai-sdk/anthropic');
  FALLBACK_MODEL = anthropic('claude-3-haiku-20240307');
  MEMORY_MODEL = anthropic('claude-3-haiku-20240307');  // Fast + cheap for extraction
}
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const memory = require('./memory');  // Self-organizing memory system

// ── Validate required env vars on cold start ──────────────────────────────────
const REQUIRED_ENV = ['TELEGRAM_TOKEN', 'MY_TELEGRAM_ID', 'REDIS_URL', 'ZHIPU_API_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 5000,
  commandTimeout: 10000,
  maxRetriesPerRequest: 3,
  keepAlive: 1000,
  retryStrategy(times) {
    if (times > 3) return null;
    return Math.min(times * 300, 1000);
  },
  reconnectOnError(err) {
    return err.message.includes('READONLY') || err.message.includes('ECONNRESET');
  },
});
redis.on('error', err => console.error('Redis error:', err.message));

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

// ── Redis keys ────────────────────────────────────────────────────────────────
const MEMORY_KEY      = 'remy_memory';
const RAW_LOG_KEY     = 'remy_raw_log';
const APPROVED_KEY    = 'approved_users';
const BOSS_GRP_PREFIX = 'boss_group_';
const HIST_PREFIX     = 'history_';
const DEDUP_PREFIX    = 'dedup_';
const NOTES_KEY       = 'remy_notes';
const REMINDERS_KEY   = 'remy_reminders';
const TIMEZONE_KEY    = 'remy_boss_timezone';
const CRON_JOBS_KEY   = 'remy_cron_jobs';
const CRON_PREFIX     = 'remy_cron:';

const MAX_HIST_MSGS   = 8;
const MAX_LOG_ENTRIES = 500;
const DEDUP_TTL       = 60;
const MIN_MEMORY_LEN  = 10;
const SPAM_LIMIT      = 5; // max @mentions per minute from approved users

// ── Config ────────────────────────────────────────────────────────────────────
const BOSS_NAME    = process.env.BOSS_NAME     || 'Mako';
const BOSS_ALIASES = process.env.BOSS_ALIASES  || '';
const SERPER_KEY   = process.env.SERPER_API_KEY || '';

// ── Adaptive Response System ────────────────────────────────────
// Analyze query complexity and adjust response length dynamically
function analyzeQueryComplexity(query) {
  const questionWords = ['who', 'what', 'when', 'where', 'how', 'why'];
  const contextKeywords = ['explain', 'summarize', 'list'];

  const wordCount = query.trim().split(/\s+/).length;
  const hasQuestionWords = questionWords.some(word => query.toLowerCase().includes(word));
  const hasContextKeywords = contextKeywords.some(keyword => query.toLowerCase().includes(keyword));

  // Determine complexity based on query characteristics
  let complexity;
  let maxTokens;

  if (hasQuestionWords || hasContextKeywords) {
    // Questions or context requests need detailed answers
    complexity = 'complex';
    maxTokens = 500;
  } else if (wordCount > 30) {
    // Medium length queries
    complexity = 'medium';
    maxTokens = 300;
  } else {
    // Short, simple queries
    complexity = 'simple';
    maxTokens = 200;
  }

  return { complexity, maxTokens };
}

const PLANNER_SYSTEM = `You are a planning agent for Remy.

Break down user goals into 3-7 clear, actionable steps.
Use memory for context about projects, goals, preferences.

Return ONLY JSON:
{
  "title": "Short title",
  "steps": [
    { "id":1, "action": "Specific action", "estimatedTime": "15min" }
  ],
  "notes": "Optional advice"
}`;

// ── Inline Keyboard Menu ──────────────────────────────────────────────────────
const MAIN_MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🧠 Memory',    callback_data: 'menu_memory' },
      { text: '📝 Notes',     callback_data: 'menu_notes' },
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeSend(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  for (const chunk of chunks) {
    try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }); }
    catch { await bot.sendMessage(chatId, chunk); }
  }
}

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

// Web search via Serper.dev — runs in parallel with Redis fetches
async function webSearch(query) {
  if (!SERPER_KEY) return null;
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5 }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const answer  = data.answerBox?.answer || data.answerBox?.snippet || '';
    const organic = data.organic?.slice(0, 4).map(r => `• ${r.title}: ${r.snippet}`).join('\n') || '';
    return [answer, organic].filter(Boolean).join('\n\n') || null;
  } catch (err) {
    console.error('[SEARCH] Web search failed:', err.message);
    return null;
  }
}

// Heuristic: does this message need live web data?
function needsWebSearch(text) {
  if (!SERPER_KEY) return false;
  const lower = text.toLowerCase();
  // Block conversational patterns that look like questions but aren't searches
  const conversational = /how are you|what'?s up|what do you think|why not|where were we|what about you|how'?s it going|how come you|what should i|how do you feel/i;
  if (conversational.test(lower)) return false;
  // Require factual follow-up words for common question words, or direct search intents
  return /\b(who (is|was|are)|what (is|are|was|were|does)|when (did|is|was|does)|where (is|are|can|do)|how (to|much|many|does|do|did)|why (did|does|is|are|do)|latest|current|today|news|price|weather|stock|rate|score|search|look up|find|tell me about)\b/i.test(text);
}

// Heuristic: is this message too trivial to update memory?
function isTrivialMessage(text) {
  if (text.length < 10) return true;
  return /^(ok|okay|lol|lmao|haha|yeah|yep|yup|nah|nope|no|yes|sure|cool|nice|k|thanks|ty|thx|got it|understood|👍|😂|🙏|💯|👌|✅|hmm|hm|oh|ah|wow|damn|shit|fuck|bro|nigga|fam|bruh|lmfao|fr|word|bet|facts)\W*$/i.test(text.trim());
}

// Parse natural language reminder time
// Accepts: "in 2h to call John", "in 30m check email", "in 1d to review contract"
function parseReminderTime(text) {
  const match = text.match(/^in\s+(\d+)\s*(m(?:in(?:s|utes?)?)?|h(?:r?s?|ours?)?|d(?:ays?)?)\s+(?:to\s+|about\s+)?(.+)$/i);
  if (!match) return null;
  const amount = parseInt(match[1]);
  const unit   = match[2][0].toLowerCase();
  const msg    = match[3].trim();
  const ms     = { m: 60000, h: 3600000, d: 86400000 }[unit] || 60000;
  return { ts: Date.now() + amount * ms, message: msg };
}

// Parse time string — supports HH:MM and 9am/9:30pm formats
function parseTimeStr(input) {
  const hhmm = input.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const h = parseInt(hhmm[1]), m = parseInt(hhmm[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59)
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  const ampm = input.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const m = parseInt(ampm[2] || '0');
    if (ampm[3].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (ampm[3].toLowerCase() === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59)
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  return null;
}

// Parse day name or number (0=Sun … 6=Sat) for weekly jobs
function parseDayOfWeek(input) {
  const days = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
                 wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5,
                 sat: 6, saturday: 6 };
  const n = parseInt(input);
  if (!isNaN(n) && n >= 0 && n <= 6) return n;
  return days[input.toLowerCase()] ?? null;
}

// Calculate next fire timestamp for a new cron job
function calculateNextFire(time, repeat, dayOfWeek, dayOfMonth) {
  const [hours, minutes] = time.split(':').map(Number);
  const now = new Date();
  let next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  switch (repeat) {
    case 'daily':
      return next.getTime();
    case 'weekdays':
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
      return next.getTime();
    case 'weekly': {
      const targetDay = parseInt(dayOfWeek) || 1;
      while (next.getDay() !== targetDay) next.setDate(next.getDate() + 1);
      return next.getTime();
    }
    case 'monthly': {
      const targetDate = parseInt(dayOfMonth) || 1;
      if (next.getDate() > targetDate || next <= now) next.setMonth(next.getMonth() + 1);
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(targetDate, lastDay));
      return next.getTime();
    }
    default:
      return next.getTime();
  }
}

// Parse /schedule command args: <repeat> [day/date] <time> <message>
function parseCronCommand(input) {
  const parts = input.trim().split(/\s+/);
  if (parts.length < 3) return null;

  const repeat = parts[0].toLowerCase();
  if (!['daily', 'weekdays', 'weekly', 'monthly'].includes(repeat)) return null;

  let timeStr, dayOfWeek = null, dayOfMonth = null, messageStart;

  if (repeat === 'weekly') {
    if (parts.length < 4) return null;
    dayOfWeek = parseDayOfWeek(parts[1]);
    if (dayOfWeek === null) return null;
    timeStr = parseTimeStr(parts[2]);
    if (!timeStr) return null;
    messageStart = 3;
  } else if (repeat === 'monthly') {
    if (parts.length < 4) return null;
    dayOfMonth = parseInt(parts[1]);
    if (isNaN(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
    timeStr = parseTimeStr(parts[2]);
    if (!timeStr) return null;
    messageStart = 3;
  } else {
    timeStr = parseTimeStr(parts[1]);
    if (!timeStr) return null;
    messageStart = 2;
  }

  const message = parts.slice(messageStart).join(' ').trim();
  if (!message) return null;

  return { repeat, time: timeStr, dayOfWeek, dayOfMonth, message };
}

// Parse natural language recurring schedules
// Handles: "every day at 9am ...", "daily at 8:00 ...", "every monday at 10am ...", "every weekday at 9am ..."
function parseCronNL(input) {
  const text = input.trim();

  const dailyMatch = text.match(
    /^(?:every\s+(?:day|morning|evening|night)|daily|each\s+day)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-,:]?\s*(?:to\s+|send\s+me\s+)?(.+)$/i
  );
  if (dailyMatch) {
    const timeStr = parseTimeStr(dailyMatch[1].trim());
    if (timeStr) return { repeat: 'daily', time: timeStr, dayOfWeek: null, dayOfMonth: null, message: dailyMatch[2].trim() };
  }

  const weekdayMatch = text.match(
    /^every\s+weekdays?\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-,:]?\s*(?:to\s+)?(.+)$/i
  );
  if (weekdayMatch) {
    const timeStr = parseTimeStr(weekdayMatch[1].trim());
    if (timeStr) return { repeat: 'weekdays', time: timeStr, dayOfWeek: null, dayOfMonth: null, message: weekdayMatch[2].trim() };
  }

  const weeklyMatch = text.match(
    /^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-,:]?\s*(?:to\s+)?(.+)$/i
  );
  if (weeklyMatch) {
    const dayOfWeek = parseDayOfWeek(weeklyMatch[1]);
    const timeStr = parseTimeStr(weeklyMatch[2].trim());
    if (timeStr && dayOfWeek !== null) return { repeat: 'weekly', time: timeStr, dayOfWeek, dayOfMonth: null, message: weeklyMatch[3].trim() };
  }

  return null;
}

// Format plan for Telegram display
function formatPlanForTelegram(plan) {
  let msg = `📋 *${plan.title}*\n\n`;

  plan.steps.forEach(step => {
    msg += `${step.id}. ${step.action} (${step.estimatedTime})\n`;
  });

  if (plan.notes) {
    msg += `\n💡 ${plan.notes}`;
  }

  return msg;
}

// Call planner - inline to avoid network call
async function planGoal(goal) {
  const [memoryExport, timezone] = await Promise.all([
    memory.exportAsMarkdown(),
    redis.get(TIMEZONE_KEY),
  ]);
  const currentDate = new Date().toISOString().split('T')[0];

  const result = await generateText({
    model: CHAT_MODEL,
    system: PLANNER_SYSTEM,
    prompt: `Goal: ${goal}\n\nContext:\n- Current Date: ${currentDate}\n- Timezone: ${timezone || 'UTC'}\n\nMemory:\n${memoryExport || 'No memory available yet.'}\n\nGenerate a plan. Return ONLY valid JSON with title, steps array (each with id, action, estimatedTime), and optional notes. 3-7 steps max.`,
    temperature: 0.7,
    maxTokens: 800,
  });

  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in response');

  const plan = JSON.parse(jsonMatch[0]);
  if (!plan.title || !plan.steps || !Array.isArray(plan.steps)) throw new Error('Invalid plan structure');

  plan.steps = plan.steps.map((step, idx) => ({
    id: step.id || idx + 1,
    action: step.action || 'Action not specified',
    estimatedTime: step.estimatedTime || '15min'
  }));

  return plan;
}

// ── Smart Memory Triggers ─────────────────────────────────────────────────────

// Quick heuristic: does this text contain patterns that might indicate key facts?
// Catches: names, emails, phone numbers, dates, decisions, commitments, preferences
function containsKeyFactPatterns(text) {
  const patterns = [
    /\b(my|our|the)\s+(name|email|phone|address|birthday|anniversary)/i,
    /\b(my|our)\s+(password|username|account|pin|ssn|id number)/i,
    /\b(I'll|I will|we'll|we will|gonna|going to)\s+(call|meet|email|text|remind|buy|sell|pay|send)/i,
    /\b(remember|don't forget|note|remind me|make sure)\b/i,
    /\b(decided|agreed|confirmed|committed|promised|scheduled|planned)/i,
    /\b(preference|favorite|love|hate|always|never|prefer|want|need)\b/i,
    /\b(deadline|due|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|next week)/i,
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // Email
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // Phone number
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/i, // Date
  ];
  return patterns.some(p => p.test(text));
}

// ── Context-aware memory builder ─────────────────────────────────────────────
// Fetches permanent category memories (always relevant) + semantically matched
// memories for the current message via vector embeddings.
async function buildContextMemory(currentMessage) {
  const MAX_CHARS = 2000;
  const PERMANENT_CATS = memory.PERMANENT_CATEGORIES;

  try {
    // Fetch permanent categories (top 3 per cat) + semantic search in parallel
    const [permanentResults, searchResults] = await Promise.all([
      Promise.all(PERMANENT_CATS.map(cat => memory.getMemoriesByCategory(cat, 3).catch(() => []))),
      (typeof currentMessage === 'string'
        ? memory.semanticSearch(currentMessage.slice(0, 200), 10)
        : Promise.resolve([])
      ).catch(() => []),
    ]);

    // Flatten permanent memories and collect IDs for dedup
    const permanentMemories = permanentResults.flat();
    const permanentIds = new Set(permanentMemories.map(m => m.id));

    // Only keep search results not already in permanent set
    const extraMemories = searchResults.filter(m => !permanentIds.has(m.id));

    // Group all memories by category for compact formatting
    const grouped = {};
    for (const mem of [...permanentMemories, ...extraMemories]) {
      if (!grouped[mem.category]) grouped[mem.category] = [];
      grouped[mem.category].push(mem.content);
    }

    // Format as compact lines: [Category] fact1 | fact2 | fact3
    const lines = Object.entries(grouped).map(([cat, facts]) => {
      const factsStr = facts.join(' | ');
      return `[${cat}] ${factsStr}`;
    });

    const result = lines.join('\n');
    if (result.length <= MAX_CHARS) return result;
    const lines2 = result.split('\n');
    let truncated = '';
    for (const line of lines2) {
      if ((truncated + '\n' + line).length > MAX_CHARS) break;
      truncated += (truncated ? '\n' : '') + line;
    }
    return truncated + '\n[...memory truncated...]';

  } catch (e) {
    console.error('[MEMORY] buildContextMemory failed:', e.message);
    return null;
  }
}

// ── Callback query handler (inline keyboard button taps) ─────────────────────
async function handleCallbackQuery(query, res) {
  const chatId    = query.message.chat.id;
  const senderId  = query.from.id;
  const messageId = query.message.message_id;
  const data      = query.data;
  const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);

  // Boss-only
  if (senderId !== AUTHORIZED_USER_ID) {
    await bot.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    return res.status(200).send('OK');
  }

  try {
    // ── Back to main menu ──
    if (data === 'back_main') {
      await safeEdit(chatId, messageId, `What do you need, ${process.env.BOSS_NAME || 'Boss'}?`, MAIN_MENU_KEYBOARD);
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    // ── Memory ──
    if (data === 'menu_memory') {
      const markdown = await memory.exportAsMarkdown();
      const memText = markdown ? `🧠 *Memory:*\n\n${markdown}` : '🧠 No memory yet.';
      if (memText.length > 4000) {
        await safeSend(chatId, memText);
        await bot.answerCallbackQuery(query.id, { text: 'See below ↓' });
      } else {
        await safeEdit(chatId, messageId, memText, backButton());
        await bot.answerCallbackQuery(query.id);
      }
      return res.status(200).send('OK');
    }

    // ── Notes ──
    if (data === 'menu_notes') {
      const entries = await redis.lrange(NOTES_KEY, 0, 19);
      if (!entries.length) {
        await safeEdit(chatId, messageId, '📝 No notes yet. Use `/note <text>` to save one.', backButton());
      } else {
        const notesList = entries.flatMap((e, i) => {
          try {
            const { ts, text: t } = JSON.parse(e);
            return [`${i + 1}. [${ts.split('T')[0]}] ${t}`];
          } catch { console.error('[NOTES] Corrupt entry at index', i); return []; }
        }).join('\n');
        const text = `📝 *Your notes:*\n\n${notesList}`;
        if (text.length > 4000) {
          await safeSend(chatId, text);
          await bot.answerCallbackQuery(query.id, { text: 'See below ↓' });
        } else {
          await safeEdit(chatId, messageId, text, backButton());
          await bot.answerCallbackQuery(query.id);
        }
      }
      return res.status(200).send('OK');
    }

    // ── Reminders ──
    if (data === 'menu_reminders') {
      const all = await redis.zrangebyscore(REMINDERS_KEY, Date.now(), '+inf', 'WITHSCORES');
      if (!all.length) {
        await safeEdit(chatId, messageId, '⏰ No pending reminders.', backButton());
      } else {
        const tz = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
        const list = [];
        for (let i = 0; i < all.length; i += 2) {
          try {
            const { message: msg } = JSON.parse(all[i]);
            const timeStr = new Date(parseInt(all[i + 1])).toLocaleString('en-US', {
              timeZone: tz, dateStyle: 'medium', timeStyle: 'short',
            });
            list.push(`${Math.floor(i / 2) + 1}. [${timeStr}] ${msg}`);
          } catch { console.error('[REMINDERS] Corrupt entry at index', i / 2); }
        }
        await safeEdit(chatId, messageId, `⏰ *Pending reminders:*\n\n${list.join('\n')}`, backButton());
      }
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    // ── Stats ──
    if (data === 'menu_stats') {
      const [logLen, memStr, approvedCount, exchangeCount, notesLen, remindersLen] = await Promise.all([
        redis.llen(RAW_LOG_KEY), redis.get(MEMORY_KEY), redis.scard(APPROVED_KEY),
        redis.get('remy_exchange_count'), redis.llen(NOTES_KEY), redis.zcard(REMINDERS_KEY),
      ]);
      const memKB = memStr ? (memStr.length / 1024).toFixed(1) : 0;
      const text = `📊 *Remy Stats*\n\n` +
        `💬 Total exchanges: *${exchangeCount || 0}*\n` +
        `📋 Log entries: *${logLen}*\n` +
        `🧠 Memory size: *${memKB} KB*\n` +
        `📝 Saved notes: *${notesLen}*\n` +
        `⏰ Pending reminders: *${remindersLen}*\n` +
        `👥 Approved users: *${approvedCount}*`;
      await safeEdit(chatId, messageId, text, backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    // ── Log ──
    if (data === 'menu_log') {
      const entries = await redis.lrange(RAW_LOG_KEY, 0, 9);
      if (!entries.length) {
        await safeEdit(chatId, messageId, '📋 No log entries yet.', backButton());
      } else {
        const logText = entries.flatMap(e => {
          try {
            const { ts, sender, msg } = JSON.parse(e);
            const date    = new Date(ts).toLocaleString();
            const preview = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
            return [`*[${date}]* ${sender}:\n_${preview}_`];
          } catch { console.error('[LOG] Corrupt menu log entry'); return []; }
        }).join('\n\n');
        const text = `📋 *Last 10 exchanges:*\n\n${logText}`;
        if (text.length > 4000) {
          await safeSend(chatId, text);
          await bot.answerCallbackQuery(query.id, { text: 'See below ↓' });
        } else {
          await safeEdit(chatId, messageId, text, backButton());
          await bot.answerCallbackQuery(query.id);
        }
      }
      return res.status(200).send('OK');
    }

    // ── Status ──
    if (data === 'menu_status') {
      const [users, groupKeys] = await Promise.all([
        redis.smembers(APPROVED_KEY), redis.keys(`${BOSS_GRP_PREFIX}*`),
      ]);
      const userList  = users.length     ? users.map(u => `• \`${u}\``).join('\n')                                         : '_None_';
      const groupList = groupKeys.length ? groupKeys.map(k => `• \`${k.replace(BOSS_GRP_PREFIX, '')}\``).join('\n') : '_None_';
      await safeEdit(chatId, messageId, `👥 *Approved:*\n${userList}\n\n📍 *Active groups:*\n${groupList}`, backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    // ── Timezone ──
    if (data === 'menu_timezone') {
      const tz = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
      const now = new Date().toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
      await safeEdit(chatId, messageId, `🌍 Timezone: \`${tz}\`\nLocal time: *${now}*\n\nTo change: \`/timezone America/New_York\``, backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    // ── Summarize (sends new message — slow + long) ──
    if (data === 'menu_summarize') {
      await bot.answerCallbackQuery(query.id, { text: 'Summarizing...' });
      const entries = await redis.lrange(RAW_LOG_KEY, 0, 19);
      if (!entries.length) {
        await safeEdit(chatId, messageId, '⚠️ No conversation history to summarize.', backButton());
        return res.status(200).send('OK');
      }
      const logText = entries.reverse().flatMap(e => {
        try {
          const { ts, sender, msg, reply } = JSON.parse(e);
          return [`[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 120)}" → Remy: "${reply.slice(0, 120)}"`];
        } catch { return []; }
      }).join('\n');
      const { text: summary } = await generateText({
        model: CHAT_MODEL,
        prompt: `Summarize these conversation exchanges concisely. Key topics, decisions, and important points only:\n\n${logText}`,
      });
      await safeSend(chatId, `📰 *Summary (last ${entries.length} exchanges):*\n\n${summary}`);
      return res.status(200).send('OK');
    }

    // ── Export Data (sends file) ──
    if (data === 'menu_exportdata') {
      await bot.answerCallbackQuery(query.id, { text: 'Exporting...' });
      const entries = await redis.lrange(RAW_LOG_KEY, 0, 4999);
      if (!entries.length) {
        await safeEdit(chatId, messageId, '⚠️ No log to export.', backButton());
        return res.status(200).send('OK');
      }
      const lines = entries.reverse().flatMap(e => {
        try {
          const { sender, msg, reply } = JSON.parse(e);
          return [JSON.stringify({ messages: [
            { role: 'user', content: msg },
            { role: 'assistant', content: reply },
          ]})];
        } catch { return []; }
      });
      const jsonl = lines.join('\n');
      const buf = Buffer.from(jsonl, 'utf8');
      await bot.sendDocument(chatId, buf, { caption: `📦 Exported ${entries.length} exchanges` }, { filename: 'remy_export.jsonl', contentType: 'application/jsonl' });
      return res.status(200).send('OK');
    }

    // ── Help ──
    if (data === 'menu_help') {
      await bot.answerCallbackQuery(query.id, { text: 'See below ↓' });
      await safeSend(chatId,
        `*Remy commands:*\n\n` +
        `*General*\n` +
        `\`/start\` — wake Remy up\n` +
        `\`/help\` — show commands\n` +
        `\`/stats\` — usage stats\n\n` +
        `*Memory*\n` +
        `\`/memory\` — view memory\n` +
        `\`/clearmemory\` — wipe memory\n` +
        `\`/rebuildmemory\` — rebuild from log\n\n` +
        `*Notes*\n` +
        `\`/note <text>\` — save a note\n` +
        `\`/notes\` — view notes\n` +
        `\`/editnote <n> <text>\` — edit a note\n` +
        `\`/deletenote <n>\` — delete a note\n\n` +
        `*Reminders*\n` +
        `\`/remind in 2h to <task>\` — set reminder\n` +
        `\`/reminders\` — view reminders\n` +
        `\`/deletereminder <n>\` — delete a reminder\n\n` +
        `*Data*\n` +
        `\`/log\` — last 10 exchanges\n` +
        `\`/summarize\` — summarize recent chat\n` +
        `\`/exportdata\` — export as JSONL`
      );
      return res.status(200).send('OK');
    }

    // ── Destructive: Confirm flows ──
    if (data === 'clear_memory_confirm') {
      await safeEdit(chatId, messageId, '⚠️ Wipe all memory? This cannot be undone.', {
        inline_keyboard: [[
          { text: '✅ Yes, wipe it', callback_data: 'clear_memory_yes' },
          { text: '❌ Cancel',       callback_data: 'back_main' },
        ]],
      });
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }
    if (data === 'clear_memory_yes') {
      // Clear self-organizing memory system (all keys)
      const allMemIds = await redis.zrange('remy_memories_all', 0, -1);
      if (allMemIds.length > 0) {
        const pipeline = redis.pipeline();
        for (const id of allMemIds) {
          pipeline.del(`remy_mem:${id}`);
        }
        // Clear all category sets
        for (const cat of memory.CATEGORIES) {
          pipeline.del(`remy_mem_cat:${cat}`);
        }
        pipeline.del('remy_memories_all');
        pipeline.del('remy_mem_accessed_recent');
        pipeline.del('remy_mem_embeddings');
        pipeline.del('remy_mem_stats');
        pipeline.del('remy_mem_last_decay');
        await pipeline.exec();
      }
      // Also clear legacy key if it exists
      await redis.del(MEMORY_KEY);
      await safeEdit(chatId, messageId, '🗑️ Memory wiped.', backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    if (data === 'clear_history_confirm') {
      await safeEdit(chatId, messageId, '⚠️ Clear chat history? This cannot be undone.', {
        inline_keyboard: [[
          { text: '✅ Yes, clear it', callback_data: 'clear_history_yes' },
          { text: '❌ Cancel',        callback_data: 'back_main' },
        ]],
      });
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }
    if (data === 'clear_history_yes') {
      await redis.del(`${HIST_PREFIX}${chatId}`);
      await safeEdit(chatId, messageId, '🗑️ History cleared.', backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    // Fallback — unknown button
    await bot.answerCallbackQuery(query.id, { text: 'Unknown action' });
    return res.status(200).send('OK');

  } catch (err) {
    console.error('[CALLBACK] Error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Error' }).catch(() => {});
    return res.status(200).send('OK');
  }
}

// ── Inline mode handler (use @RemyMartynBot in any chat) ─────────────────────
async function handleInlineQuery(query, res) {
  const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
  const senderId = query.from.id;
  const queryText = query.query?.trim();

  // Boss-only
  if (senderId !== AUTHORIZED_USER_ID) {
    await bot.answerInlineQuery(query.id, []);
    return res.status(200).send('OK');
  }

  // Empty query — user just typed @RemyMartynBot, wait for actual input
  if (!queryText) {
    await bot.answerInlineQuery(query.id, []);
    return res.status(200).send('OK');
  }

  // Analyze query complexity for adaptive response
  const { complexity, maxTokens } = analyzeQueryComplexity(queryText);

  // Get current date/time
  const savedTz = await redis.get(TIMEZONE_KEY).catch(() => null);
  const bossTimezone = savedTz || process.env.BOSS_TIMEZONE || 'UTC';
  const now = new Date();
  const currentTime = now.toLocaleString('en-US', {
    timeZone: bossTimezone,
    weekday: 'short',
    year:    'numeric',
    month:   'short',
    day:     'numeric',
    hour:    '2-digit',
    minute:  '2-digit',
  });

  // Generate dynamic system prompt based on complexity
  let systemPrompt;
  if (complexity === 'simple') {
    systemPrompt = `You are Remy — a sharp, concise AI assistant. Current time: ${currentTime}. Answer in 1-2 sentences. No fluff.`;
  } else if (complexity === 'medium') {
    systemPrompt = `You are Remy — a sharp, concise AI assistant. Current time: ${currentTime}. Answer in 2-3 sentences. No fluff.`;
  } else {
    systemPrompt = `You are Remy — a sharp, concise AI assistant. Current time: ${currentTime}. Answer in 3-5 sentences. No fluff.`;
  }

  console.log(`[INLINE] Complexity: ${complexity}, maxTokens: ${maxTokens}, Query: "${queryText.slice(0, 50)}"...`);

  try {
    const { text: answer } = await generateText({
      model: CHAT_MODEL,
      system: systemPrompt,
      messages: [{ role: 'user', content: queryText }],
      maxTokens: maxTokens,
      temperature: 0.7,
      abortSignal: AbortSignal.timeout(8000),
    });

    const result = {
      type: 'article',
      id: `remy_${Date.now()}`,
      title: answer.slice(0, 50) + (answer.length > 50 ? '...' : ''),
      description: answer.slice(0, 200),
      input_message_content: { message_text: answer },
    };

    await bot.answerInlineQuery(query.id, [result], { cache_time: 5 });
    console.log(`[INLINE] Answered: "${queryText.slice(0, 50)}" → "${answer.slice(0, 80)}"`);
  } catch (err) {
    console.error('[INLINE] Failed:', err.message);
    await bot.answerInlineQuery(query.id, [{
      type: 'article',
      id: `remy_err_${Date.now()}`,
      title: "Couldn't think fast enough",
      description: 'Try asking in DMs instead',
      input_message_content: { message_text: '⚠️ Remy timed out on that one. Try asking in DMs.' },
    }], { cache_time: 5 });
  }

  return res.status(200).send('OK');
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot is running');

  const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
  const BOT_USERNAME = process.env.BOT_USERNAME || '@RemyMartynBot';

  try {
    const { message, callback_query, inline_query } = req.body;

    // Handle inline keyboard button taps
    if (callback_query) {
      return handleCallbackQuery(callback_query, res);
    }

    // Handle inline mode (@RemyMartynBot query in any chat)
    if (inline_query) {
      return handleInlineQuery(inline_query, res);
    }

    if (!message) { console.log('[SKIP] No message in body, keys:', Object.keys(req.body)); return res.status(200).send('OK'); }

    const chatId     = message.chat.id;
    const senderId   = message.from?.id;
    const senderName = message.from?.first_name || 'Someone';
    const isPrivate  = message.chat.type === 'private';
    const isBoss     = senderId === AUTHORIZED_USER_ID;
    const text       = message.text || '';

    console.log(`[MSG] from=${senderName}(${senderId}) chat=${chatId} private=${isPrivate} isBoss=${isBoss} text="${text.slice(0,50)}" authId=${AUTHORIZED_USER_ID}`);

    // ── Welcome new group members ─────────────────────────────────────────────
    if (message.new_chat_members) {
      const bossActive = await redis.get(`${BOSS_GRP_PREFIX}${chatId}`);
      if (bossActive) {
        for (const member of message.new_chat_members) {
          if (member.is_bot) continue;
          await bot.sendMessage(chatId,
            `Welcome to the group, ${member.first_name}. I'm Remy. You're in good company.`
          );
        }
      }
      return res.status(200).send('OK');
    }

    // Only process text, photo, and voice messages
    if (!message.text && !message.photo && !message.voice) { console.log('[SKIP] Not text/photo/voice'); return res.status(200).send('OK'); }

    // ── Dedup: ignore Telegram webhook retries (skip if Redis slow) ──────────
    const dedupKey = `${DEDUP_PREFIX}${message.message_id}`;
    let isNew = true;
    try {
      isNew = await redis.set(dedupKey, '1', 'EX', DEDUP_TTL, 'NX');
    } catch (e) {
      console.error('Dedup Redis failed, processing anyway:', e.message);
    }
    if (!isNew) { console.log('[SKIP] Dedup hit'); return res.status(200).send('OK'); }

    // ── Access control ────────────────────────────────────────────────────────
    if (isPrivate && !isBoss) { console.log('[SKIP] Private + not boss'); return res.status(200).send('OK'); }

    if (!isPrivate && !isBoss) {
      const spamKey = `spam_${senderId}_${Math.floor(Date.now() / 60000)}`;
      const [isApproved, bossActive, spamCount] = await Promise.all([
        redis.sismember(APPROVED_KEY, String(senderId)),
        redis.get(`${BOSS_GRP_PREFIX}${chatId}`),
        redis.incr(spamKey).then(c => { redis.expire(spamKey, 120).catch(() => {}); return c; }),
      ]);
      if (!isApproved || !bossActive) return res.status(200).send('OK');
      if (spamCount > SPAM_LIMIT) return res.status(200).send('OK');
    }

    // ── Boss commands (DM only) ───────────────────────────────────────────────
    if (isBoss && isPrivate && text.startsWith('/')) {

      // Agent planning command
      if (text.startsWith('/agent plan ')) {
        const goal = text.substring('/agent plan '.length).trim();
        if (goal.length < 3) {
          await bot.sendMessage(chatId, 'Please provide a clear goal after /agent plan\nExample: /agent plan my productive week');
          return res.status(200).send('OK');
        }

        try {
          await bot.sendChatAction(chatId, 'typing');
          const plan = await planGoal(goal, senderId);
          await bot.sendMessage(chatId, formatPlanForTelegram(plan), { parse_mode: 'Markdown' });
        } catch (error) {
          console.error('Plan generation error:', error);
          await bot.sendMessage(chatId, `Sorry, I couldn't generate a plan. Error: ${error.message}`);
        }
        return res.status(200).send('OK');
      }

      // /agent help
      if (text.startsWith('/agent') || text.startsWith('/agent ')) {
        await bot.sendMessage(chatId, `*Agent Commands*\n\n/agent plan <goal> - Generate a structured plan\n\nExample: /agent plan my productive week`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (text === '/start') {
        await bot.sendMessage(chatId, `What's good ${BOSS_NAME} 👋\nOnline and ready.`, { reply_markup: MAIN_MENU_KEYBOARD });
        return res.status(200).send('OK');
      }

      if (text.startsWith('/allow ')) {
        const id = text.slice(7).trim().replace(/[<>]/g, '');
        await redis.sadd(APPROVED_KEY, id);
        await bot.sendMessage(chatId, `✅ User \`${id}\` added.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (text.startsWith('/remove ') || text.startsWith('/revoke ')) {
        const id = text.split(' ').slice(1).join(' ').trim().replace(/[<>]/g, '');
        await redis.srem(APPROVED_KEY, id);
        await bot.sendMessage(chatId, `🚫 User \`${id}\` revoked.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (text === '/status' || text === '/list') {
        const [users, groupKeys] = await Promise.all([
          redis.smembers(APPROVED_KEY),
          redis.keys(`${BOSS_GRP_PREFIX}*`),
        ]);
        const userList  = users.length     ? users.map(u => `• \`${u}\``).join('\n')                                         : '_None_';
        const groupList = groupKeys.length ? groupKeys.map(k => `• \`${k.replace(BOSS_GRP_PREFIX, '')}\``).join('\n') : '_None_';
        await bot.sendMessage(chatId, `👥 *Approved:*\n${userList}\n\n📍 *Active groups:*\n${groupList}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (text === '/memory') {
        const markdown = await memory.exportAsMarkdown();
        await safeSend(chatId, markdown ? `🧠 *Memory:*\n\n${markdown}` : '🧠 No memory yet. Talk to me and I\'ll remember.');
        return res.status(200).send('OK');
      }

      if (text === '/clearhistory') {
        await redis.del(`${HIST_PREFIX}${chatId}`);
        await bot.sendMessage(chatId, '🗑️ History cleared for this chat.');
        return res.status(200).send('OK');
      }

      if (text === '/log') {
        const entries = await redis.lrange(RAW_LOG_KEY, 0, 9);
        if (!entries.length) {
          await bot.sendMessage(chatId, '📋 No log entries yet.');
          return res.status(200).send('OK');
        }
        const logText = entries.flatMap(e => {
          try {
            const { ts, sender, msg } = JSON.parse(e);
            const date    = new Date(ts).toLocaleString();
            const preview = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
            return [`*[${date}]* ${sender}:\n_${preview}_`];
          } catch { console.error('[LOG] Corrupt log entry'); return []; }
        }).join('\n\n');
        await safeSend(chatId, `📋 *Last 10 exchanges:*\n\n${logText}`);
        return res.status(200).send('OK');
      }

      if (text === '/clearlog') {
        await redis.del(RAW_LOG_KEY);
        await bot.sendMessage(chatId, '🗑️ Log cleared.');
        return res.status(200).send('OK');
      }

      if (text === '/rebuildmemory') {
        const entries = await redis.lrange(RAW_LOG_KEY, 0, 49);
        if (!entries.length) {
          await bot.sendMessage(chatId, '⚠️ Nothing to rebuild from.');
          return res.status(200).send('OK');
        }
        await bot.sendMessage(chatId, `🔄 Rebuilding memory from ${entries.length} entries...`);
        try {
          const logText = entries.reverse().flatMap(e => {
            try {
              const { ts, sender, msg, reply } = JSON.parse(e);
              return [`[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 120)}" → Remy: "${reply.slice(0, 120)}"`];
            } catch { return []; }
          }).join('\n');
          const currentDate = new Date().toISOString().split('T')[0];
          const extractionModel = MEMORY_MODEL || UTILITY_MODEL;
          const { text: extractionResult } = await generateText({
            model: extractionModel,
            system: `You are a fact extraction assistant. Today's date is ${currentDate}. Extract facts accurately. Return ONLY valid JSON.`,
            prompt: `Extract ALL facts about the user from this conversation log. Return as JSON array.\n\nCONVERSATION LOG:\n${logText}\n\nCATEGORIES TO USE: ${memory.CATEGORIES.join(', ')}\n\nRules:\n- Extract every meaningful fact, preference, person, project, or event\n- Each fact should be a single concise statement\n- Assign appropriate category\n- Return ONLY JSON array\n\nResponse format:\n[{"content": "fact", "category": "Category Name"}]`,
            temperature: 0.2,
            maxTokens: 2000,
          });
          let facts;
          try { facts = JSON.parse(extractionResult); } catch { facts = []; }
          let added = 0, boosted = 0;
          if (Array.isArray(facts)) {
            for (const fact of facts) {
              if (fact.content && fact.category && fact.content.length >= 5) {
                const result = await memory.smartAddMemory(fact.content, fact.category, 85);
                if (result.action === 'added') added++;
                if (result.action === 'boosted') boosted++;
              }
            }
          }
          await bot.sendMessage(chatId, `✅ Memory rebuilt: ${added} new facts, ${boosted} existing boosted. Use /memstats to review.`);
        } catch (err) {
          console.error('Rebuild failed:', err);
          await bot.sendMessage(chatId, '❌ Rebuild failed. Check logs.');
        }
        return res.status(200).send('OK');
      }

      // ── Self-Organizing Memory Commands ────────────────────────────────────

      // /memadd <content> <category>
      if (text.startsWith('/memadd ')) {
        const args = text.slice(8).trim();
        // Extract category (last word) and content (rest)
        const lastSpace = args.lastIndexOf(' ');
        if (lastSpace === -1) {
          await bot.sendMessage(chatId, '⚠️ Usage: `/memadd <content> <category>`\n\nCategories: ' + memory.CATEGORIES.slice(0, 5).join(', ') + '...', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const content = args.slice(0, lastSpace);
        const category = args.slice(lastSpace + 1);
        try {
          await memory.addMemory(content, category);
          await bot.sendMessage(chatId, `✅ Memory added to *${category}*`, { parse_mode: 'Markdown' });
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
        }
        return res.status(200).send('OK');
      }

      // /memcat <category> - view memories by category
      if (text.startsWith('/memcat ')) {
        const category = text.slice(8).trim();
        const memories = await memory.getMemoriesByCategory(category, 10);
        if (memories.length === 0) {
          await bot.sendMessage(chatId, `📂 No memories in *${category}*`, { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const output = memories.map(m =>
          `• ${m.content}\n  _Importance: ${m.importance.toFixed(0)} | Confidence: ${m.confidence}_`
        ).join('\n\n');
        await safeSend(chatId, `📂 *${category}* (${memories.length}):\n\n${output}`);
        return res.status(200).send('OK');
      }

      // /memsearch <query>
      if (text.startsWith('/memsearch ')) {
        const query = text.slice(11).trim();
        const results = await memory.searchMemories(query, 10);
        if (results.length === 0) {
          await bot.sendMessage(chatId, `🔍 No results for "${query}"`);
          return res.status(200).send('OK');
        }
        const output = results.map(m =>
          `• [${m.category}] ${m.content}\n  _Importance: ${m.importance.toFixed(0)}_`
        ).join('\n\n');
        await safeSend(chatId, `🔍 *${results.length} results* for "${query}":\n\n${output}`);
        return res.status(200).send('OK');
      }

      // /memstats
      if (text === '/memstats') {
        const stats = await memory.getStats();
        const topCats = Object.entries(stats.categories || {})
          .filter(([, count]) => count > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);

        await bot.sendMessage(chatId,
          `📊 *Memory Stats*\n\n` +
          `🧠 Total memories: *${stats.totalMemories}*\n` +
          `🔥 Hot (recently accessed): *${stats.hotMemories}*\n` +
          `📝 Total accesses: *${stats.total_accesses || 0}*\n\n` +
          `📂 Top categories:\n${topCats.map(([cat, count]) => `• ${cat}: ${count}`).join('\n')}`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      // /backfill - generate embeddings for existing memories
      if (text === '/backfill') {
        await bot.sendMessage(chatId, '⏳ Generating embeddings for existing memories...');
        const result = await memory.backfillEmbeddings();
        await bot.sendMessage(chatId,
          `✅ Embedding backfill complete:\n• Embedded: *${result.embedded}*\n• Failed: *${result.failed}*\n• Already had embeddings: *${result.skipped}*`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      // /memdecay - manually trigger decay
      if (text === '/memdecay') {
        await bot.sendMessage(chatId, '⏳ Applying time decay...');
        const result = await memory.applyDecay();
        await bot.sendMessage(chatId, `✅ Decay applied to *${result.decayed}* memories (${result.daysPassed} day(s))`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // /memexport - export to markdown
      if (text === '/memexport') {
        await bot.sendMessage(chatId, '⏳ Exporting memory...');
        const markdown = await memory.exportAsMarkdown();
        await safeSend(chatId, `📋 *Memory Export:*\n\n${markdown}`);
        return res.status(200).send('OK');
      }

      // ── /stats ────────────────────────────────────────────────────────────
      if (text === '/stats') {
        const [logLen, memStr, approvedCount, exchangeCount, notesLen, remindersLen] = await Promise.all([
          redis.llen(RAW_LOG_KEY),
          redis.get(MEMORY_KEY),
          redis.scard(APPROVED_KEY),
          redis.get('remy_exchange_count'),
          redis.llen(NOTES_KEY),
          redis.zcard(REMINDERS_KEY),
        ]);
        const memKB = memStr ? (memStr.length / 1024).toFixed(1) : 0;
        await bot.sendMessage(chatId,
          `📊 *Remy Stats*\n\n` +
          `💬 Total exchanges: *${exchangeCount || 0}*\n` +
          `📋 Log entries: *${logLen}*\n` +
          `🧠 Memory size: *${memKB} KB*\n` +
          `📝 Saved notes: *${notesLen}*\n` +
          `⏰ Pending reminders: *${remindersLen}*\n` +
          `👥 Approved users: *${approvedCount}*`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      // ── /note <text> ──────────────────────────────────────────────────────
      if (text.startsWith('/note ')) {
        const noteText = text.slice(6).trim();
        if (!noteText) {
          await bot.sendMessage(chatId, '⚠️ Usage: `/note <your note>`', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        await redis.lpush(NOTES_KEY, JSON.stringify({ ts: new Date().toISOString(), text: noteText }));
        await bot.sendMessage(chatId, '📝 Note saved.');
        return res.status(200).send('OK');
      }

      // ── /notes ────────────────────────────────────────────────────────────
      if (text === '/notes') {
        const entries = await redis.lrange(NOTES_KEY, 0, 19);
        if (!entries.length) {
          await bot.sendMessage(chatId, '📝 No notes yet. Use `/note <text>` to save one.', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const notesList = entries.flatMap((e, i) => {
          try {
            const { ts, text: t } = JSON.parse(e);
            return [`${i + 1}. [${ts.split('T')[0]}] ${t}`];
          } catch { console.error('[NOTES] Corrupt entry at index', i); return []; }
        }).join('\n');
        await safeSend(chatId, `📝 *Your notes:*\n\n${notesList}`);
        return res.status(200).send('OK');
      }

      // ── /editnote <n> <text> ──────────────────────────────────────────────
      if (text.startsWith('/editnote')) {
        const parts = text.slice(9).trim().match(/^(\d+)\s+(.+)$/s);
        if (!parts) {
          await bot.sendMessage(chatId, '⚠️ Usage: `/editnote <number> <new text>`', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const n = parseInt(parts[1]);
        const newText = parts[2].trim();
        const entries = await redis.lrange(NOTES_KEY, 0, -1);
        if (n < 1 || n > entries.length) {
          await bot.sendMessage(chatId, `⚠️ Only ${entries.length} note(s) saved.`);
          return res.status(200).send('OK');
        }
        const updated = JSON.stringify({ ts: new Date().toISOString(), text: newText });
        await redis.lset(NOTES_KEY, n - 1, updated);
        await bot.sendMessage(chatId, `✏️ Note ${n} updated: "${newText.slice(0, 80)}"`);
        return res.status(200).send('OK');
      }

      // ── /deletenote <n> ───────────────────────────────────────────────────
      if (text.startsWith('/deletenote')) {
        const n = parseInt(text.slice(11).trim());
        if (isNaN(n) || n < 1) {
          await bot.sendMessage(chatId, '⚠️ Usage: `/deletenote <number>` — use `/notes` to see numbers.', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const entries = await redis.lrange(NOTES_KEY, 0, -1);
        if (n > entries.length) {
          await bot.sendMessage(chatId, `⚠️ Only ${entries.length} note(s) saved.`);
          return res.status(200).send('OK');
        }
        // Redis lists don't support direct index delete — use a placeholder then remove it
        const target = entries[n - 1];
        await redis.lrem(NOTES_KEY, 1, target);
        try {
          const { text: t } = JSON.parse(target);
          await bot.sendMessage(chatId, `🗑️ Deleted note ${n}: "${t.slice(0, 80)}"`);
        } catch {
          await bot.sendMessage(chatId, `🗑️ Deleted note ${n}.`);
        }
        return res.status(200).send('OK');
      }

      // ── /clearnotes ───────────────────────────────────────────────────────
      if (text === '/clearnotes') {
        await redis.del(NOTES_KEY);
        await bot.sendMessage(chatId, '🗑️ Notes cleared.');
        return res.status(200).send('OK');
      }

      // ── /summarize [n] ────────────────────────────────────────────────────
      if (text.startsWith('/summarize')) {
        const n = Math.min(parseInt(text.split(' ')[1]) || 20, 50);
        const entries = await redis.lrange(RAW_LOG_KEY, 0, n - 1);
        if (!entries.length) {
          await bot.sendMessage(chatId, '⚠️ No conversation history to summarize.');
          return res.status(200).send('OK');
        }
        await bot.sendMessage(chatId, `🔄 Summarizing last ${entries.length} exchanges...`);
        try {
          const logText = entries.reverse().flatMap(e => {
            try {
              const { ts, sender, msg, reply } = JSON.parse(e);
              return [`[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 120)}" → Remy: "${reply.slice(0, 120)}"`];
            } catch { return []; }
          }).join('\n');
          const { text: summary } = await generateText({
            model: CHAT_MODEL,
            prompt: `Summarize these conversation exchanges concisely. Key topics, decisions, and important points only:\n\n${logText}`,
          });
          await safeSend(chatId, `📋 *Summary (last ${entries.length} exchanges):*\n\n${summary}`);
        } catch (err) {
          console.error('[SUMMARIZE] Failed:', err.message);
          await bot.sendMessage(chatId, '❌ Summary failed. Try again.');
        }
        return res.status(200).send('OK');
      }

      // ── /remind in <time> to <message> ───────────────────────────────────
      if (text.startsWith('/remind ')) {
        const input  = text.slice(8).trim();
        const parsed = parseReminderTime(input);
        if (!parsed) {
          await bot.sendMessage(chatId,
            `⚠️ Format: \`/remind in 2h to call John\` or \`/remind in 30m check email\``,
            { parse_mode: 'Markdown' }
          );
          return res.status(200).send('OK');
        }
        await redis.zadd(REMINDERS_KEY, parsed.ts, JSON.stringify({ chatId, message: parsed.message, id: Date.now() }));
        const tz = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
        const timeStr = new Date(parsed.ts).toLocaleString('en-US', {
          timeZone: tz,
          dateStyle: 'medium',
          timeStyle: 'short',
        });
        await bot.sendMessage(chatId, `⏰ Reminder set for *${timeStr}*: "${parsed.message}"`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // ── /reminders ────────────────────────────────────────────────────────
      if (text === '/reminders') {
        const all = await redis.zrangebyscore(REMINDERS_KEY, Date.now(), '+inf', 'WITHSCORES');
        if (!all.length) {
          await bot.sendMessage(chatId, '⏰ No pending reminders.');
          return res.status(200).send('OK');
        }
        const tz = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
        const list = [];
        for (let i = 0; i < all.length; i += 2) {
          try {
            const { message: msg } = JSON.parse(all[i]);
            const timeStr = new Date(parseInt(all[i + 1])).toLocaleString('en-US', {
              timeZone: tz,
              dateStyle: 'medium',
              timeStyle: 'short',
            });
            list.push(`${Math.floor(i / 2) + 1}. [${timeStr}] ${msg}`);
          } catch { console.error('[REMINDERS] Corrupt entry at index', i / 2); }
        }
        await safeSend(chatId, `⏰ *Pending reminders:*\n\n${list.join('\n')}`);
        return res.status(200).send('OK');
      }

      // ── /deletereminder <n> ───────────────────────────────────────────────
      if (text.startsWith('/deletereminder')) {
        const n = parseInt(text.slice(15).trim());
        if (isNaN(n) || n < 1) {
          await bot.sendMessage(chatId, '⚠️ Usage: `/deletereminder <number>` — use `/reminders` to see numbers.', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const all = await redis.zrangebyscore(REMINDERS_KEY, Date.now(), '+inf', 'WITHSCORES');
        const totalReminders = Math.floor(all.length / 2);
        if (n > totalReminders) {
          await bot.sendMessage(chatId, `⚠️ Only ${totalReminders} reminder(s) pending.`);
          return res.status(200).send('OK');
        }
        const target = all[(n - 1) * 2];
        await redis.zrem(REMINDERS_KEY, target);
        try {
          const { message: msg } = JSON.parse(target);
          await bot.sendMessage(chatId, `🗑️ Deleted reminder ${n}: "${msg.slice(0, 80)}"`);
        } catch {
          await bot.sendMessage(chatId, `🗑️ Deleted reminder ${n}.`);
        }
        return res.status(200).send('OK');
      }

      // ── /schedule <repeat> [day] <time> <message> ────────────────────────
      if (text.startsWith('/schedule ')) {
        const args = text.slice(10).trim();
        const parsed = parseCronCommand(args);
        if (!parsed) {
          await bot.sendMessage(chatId,
            `⚠️ *Schedule format:*\n` +
            `\`/schedule daily 09:00 Morning news\`\n` +
            `\`/schedule weekdays 08:30 Check emails\`\n` +
            `\`/schedule weekly mon 10:00 Weekly review\`\n` +
            `\`/schedule monthly 1 09:00 Monthly report\``,
            { parse_mode: 'Markdown' }
          );
          return res.status(200).send('OK');
        }

        const jobId = `cj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const nextFire = calculateNextFire(parsed.time, parsed.repeat, parsed.dayOfWeek, parsed.dayOfMonth);
        const isTask = needsWebSearch(parsed.message) || /\b(send|get|fetch|summary|summarize|remind|tell|show|check|report|news|weather|briefing)\b/i.test(parsed.message);

        await redis.hset(`${CRON_PREFIX}${jobId}`,
          'message', parsed.message,
          'repeat', parsed.repeat,
          'time', parsed.time,
          'dayOfWeek', String(parsed.dayOfWeek ?? ''),
          'dayOfMonth', String(parsed.dayOfMonth ?? ''),
          'chatId', String(chatId),
          'enabled', 'true',
          'fireCount', '0',
          'jobType', isTask ? 'ai_task' : 'message',
          'createdAt', new Date().toISOString(),
        );
        await redis.zadd(CRON_JOBS_KEY, nextFire, jobId);

        const tz = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
        const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
        const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const dayLabel = parsed.repeat === 'weekly' ? ` (${dayNames[parsed.dayOfWeek]}s)` :
                         parsed.repeat === 'monthly' ? ` (${parsed.dayOfMonth}th of month)` : '';
        await bot.sendMessage(chatId,
          `✅ *Scheduled:* "${parsed.message}"\n📅 ${parsed.repeat}${dayLabel} at \`${parsed.time}\`\n🔔 First run: ${nextStr}`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      // ── /schedules — list all recurring jobs ─────────────────────────────
      if (text === '/schedules') {
        const jobIds = await redis.zrangebyscore(CRON_JOBS_KEY, 0, '+inf', 'WITHSCORES');
        if (!jobIds.length) {
          await bot.sendMessage(chatId, '📅 No scheduled jobs.\n\nCreate one with `/schedule daily 09:00 Morning news`', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const tz = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
        const list = [];
        for (let i = 0; i < jobIds.length; i += 2) {
          try {
            const jobId = jobIds[i];
            const nextFire = parseInt(jobIds[i + 1]);
            const job = await redis.hgetall(`${CRON_PREFIX}${jobId}`);
            if (!job || !job.message) continue;
            const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
            const status = job.enabled === 'false' ? ' ⏸' : '';
            const count = job.fireCount > 0 ? ` (fired ${job.fireCount}×)` : '';
            list.push(`${Math.floor(i / 2) + 1}. [${job.repeat} @ ${job.time}]${status}${count}\n   "${job.message}"\n   Next: ${nextStr}`);
          } catch { /* skip corrupt */ }
        }
        if (!list.length) {
          await bot.sendMessage(chatId, '📅 No scheduled jobs.');
          return res.status(200).send('OK');
        }
        await safeSend(chatId, `📅 *Scheduled jobs (${list.length}):*\n\n${list.join('\n\n')}`);
        return res.status(200).send('OK');
      }

      // ── /editschedule <n> <repeat> [day] <time> <message> ────────────────
      if (text.startsWith('/editschedule ')) {
        const parts = text.slice(14).trim().split(/\s+/);
        const n = parseInt(parts[0]);
        if (isNaN(n) || n < 1) {
          await bot.sendMessage(chatId, '⚠️ Usage: `/editschedule <number> daily 09:00 New task` — use `/schedules` to see numbers.', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const newSpec = parseCronCommand(parts.slice(1).join(' '));
        if (!newSpec) {
          await bot.sendMessage(chatId,
            `⚠️ *Edit format:*\n` +
            `\`/editschedule 1 daily 09:00 New task description\`\n` +
            `\`/editschedule 2 weekdays 08:30 Check emails\`\n` +
            `\`/editschedule 3 weekly mon 10:00 Weekly review\``,
            { parse_mode: 'Markdown' }
          );
          return res.status(200).send('OK');
        }
        const all = await redis.zrangebyscore(CRON_JOBS_KEY, 0, '+inf', 'WITHSCORES');
        const totalJobs = Math.floor(all.length / 2);
        if (n > totalJobs) {
          await bot.sendMessage(chatId, `⚠️ Only ${totalJobs} scheduled job(s). Use \`/schedules\` to see the list.`, { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const jobId = all[(n - 1) * 2];
        const isTask = needsWebSearch(newSpec.message) || /\b(send|get|fetch|summary|summarize|tell|show|check|report|news|weather|briefing)\b/i.test(newSpec.message);
        const nextFire = calculateNextFire(newSpec.time, newSpec.repeat, newSpec.dayOfWeek, newSpec.dayOfMonth);

        await redis.hset(`${CRON_PREFIX}${jobId}`,
          'message', newSpec.message,
          'repeat', newSpec.repeat,
          'time', newSpec.time,
          'dayOfWeek', String(newSpec.dayOfWeek ?? ''),
          'dayOfMonth', String(newSpec.dayOfMonth ?? ''),
          'jobType', isTask ? 'ai_task' : 'message',
        );
        await redis.zadd(CRON_JOBS_KEY, nextFire, jobId);

        const tz = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
        const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
        await bot.sendMessage(chatId,
          `✅ *Schedule ${n} updated:* "${newSpec.message}"\n📅 ${newSpec.repeat} at \`${newSpec.time}\` — next run: ${nextStr}`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      // ── /deleteschedule <n> ───────────────────────────────────────────────
      if (text.startsWith('/deleteschedule')) {
        const n = parseInt(text.slice(15).trim());
        if (isNaN(n) || n < 1) {
          await bot.sendMessage(chatId, '⚠️ Usage: `/deleteschedule <number>` — use `/schedules` to see the list.', { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const all = await redis.zrangebyscore(CRON_JOBS_KEY, 0, '+inf', 'WITHSCORES');
        const totalJobs = Math.floor(all.length / 2);
        if (n > totalJobs) {
          await bot.sendMessage(chatId, `⚠️ Only ${totalJobs} scheduled job(s). Use \`/schedules\` to see the list.`, { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        const jobId = all[(n - 1) * 2];
        const job = await redis.hgetall(`${CRON_PREFIX}${jobId}`);
        await redis.del(`${CRON_PREFIX}${jobId}`);
        await redis.zrem(CRON_JOBS_KEY, jobId);
        const label = job?.message?.slice(0, 60) || jobId;
        await bot.sendMessage(chatId, `🗑️ Deleted schedule ${n}: "${label}"`);
        return res.status(200).send('OK');
      }

      // ── /timezone <tz> ────────────────────────────────────────────────────
      if (text.startsWith('/timezone')) {
        const tz = text.slice(9).trim();
        if (!tz) {
          const current = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
          const now = new Date().toLocaleString('en-US', { timeZone: current, dateStyle: 'full', timeStyle: 'short' });
          await bot.sendMessage(chatId, `🌍 Current timezone: \`${current}\`\nLocal time: *${now}*\n\nTo change: \`/timezone America/New_York\``, { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        // Validate the timezone string
        try {
          new Date().toLocaleString('en-US', { timeZone: tz });
        } catch {
          await bot.sendMessage(chatId, `❌ Invalid timezone: \`${tz}\`\n\nExamples: \`America/New_York\`, \`Europe/London\`, \`Asia/Singapore\`, \`America/Sao_Paulo\``, { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
        await redis.set(TIMEZONE_KEY, tz);
        const now = new Date().toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
        await bot.sendMessage(chatId, `✅ Timezone set to \`${tz}\`\nYour local time: *${now}*`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // ── /help ─────────────────────────────────────────────────────────────
      if (text === '/help') {
        await safeSend(chatId,
          `*Remy commands:*\n\n` +
          `*Access*\n` +
          `\`/allow <id>\` — grant group access\n` +
          `\`/remove <id>\` or \`/revoke <id>\` — revoke\n` +
          `\`/status\` or \`/list\` — approved users & groups\n\n` +
          `*Memory*\n` +
          `\`/memory\` — view all memories\n` +
          `\`/memadd <content> <category>\` — add memory\n` +
          `\`/memcat <category>\` — view memories by category\n` +
          `\`/memsearch <query>\` — search all memories\n` +
          `\`/memstats\` — view memory statistics\n` +
          `\`/memdecay\` — apply time decay\n` +
          `\`/memexport\` — export as markdown\n` +
          `\`/rebuildmemory\` — rebuild memory from log\n` +
          `\`/backfill\` — generate embeddings for existing memories\n\n` +
          `*Agent*\n` +
          `\`/agent plan <goal>\` — generate structured plan\n` +
          `\`/agent help\` — agent commands\n\n` +
          `*Notes*\n` +
          `\`/note <text>\` — save a note\n` +
          `\`/notes\` — view notes (last 20)\n` +
          `\`/editnote <number> <text>\` — edit a note\n` +
          `\`/deletenote <number>\` — delete a single note\n` +
          `\`/clearnotes\` — clear all notes\n\n` +
          `*Reminders*\n` +
          `\`/remind in 2h to <task>\` — set reminder\n` +
          `\`/reminders\` — view pending reminders\n` +
          `\`/deletereminder <number>\` — delete a reminder\n\n` +
          `*Scheduler* (recurring jobs)\n` +
          `\`/schedule daily 09:00 <task>\` — daily job\n` +
          `\`/schedule weekdays 08:30 <task>\` — weekdays only\n` +
          `\`/schedule weekly mon 10:00 <task>\` — weekly\n` +
          `\`/schedule monthly 1 09:00 <task>\` — monthly\n` +
          `\`/schedules\` — list all scheduled jobs\n` +
          `\`/editschedule <n> daily 09:00 <task>\` — edit a job\n` +
          `\`/deleteschedule <number>\` — delete a job\n\n` +
          `*History & Log*\n` +
          `\`/clearhistory\` — clear this chat's history\n` +
          `\`/log\` — last 10 log entries\n` +
          `\`/clearlog\` — wipe log\n` +
          `\`/summarize [n]\` — summarize last n exchanges\n\n` +
          `*Info*\n` +
          `\`/stats\` — usage stats\n` +
          `\`/timezone <tz>\` — set your timezone (e.g. America/New_York)\n` +
          `\`/timezone\` — view current timezone\n\n` +
          `*Training*\n` +
          `\`/exportdata\` — export conversation log as fine-tuning JSONL`
        );
        await bot.sendMessage(chatId, 'Or just tap:', { reply_markup: MAIN_MENU_KEYBOARD });
        return res.status(200).send('OK');
      }

      // ── /exportdata — generate fine-tuning JSONL and send as file ────────
      if (text === '/exportdata') {
        await bot.sendMessage(chatId, '⏳ Pulling log from Redis and generating training file...');
        try {
          const entries = await redis.lrange(RAW_LOG_KEY, 0, 4999);
          if (!entries.length) {
            await bot.sendMessage(chatId, '⚠️ No log entries found.');
            return res.status(200).send('OK');
          }
          const REMY_SYSTEM = `You are Remy — ${BOSS_NAME}'s personal AI agent. Sharp, loyal, direct, occasionally dry. You handle research, strategy, writing, code, planning, and anything else the Boss needs. You serve ${BOSS_NAME} and no one else. Never sign off. Never break character.`;
          const lines = [];
          let skipped = 0;
          for (const raw of entries) {
            let entry;
            try { entry = JSON.parse(raw); } catch { skipped++; continue; }
            const { msg, reply } = entry;
            if (!msg || !reply || msg.length < 10 || reply.length < 20) { skipped++; continue; }
            const cleanMsg = msg.replace(/^\[.+?\]:\s*/, '').trim();
            lines.push(JSON.stringify({
              messages: [
                { role: 'system',    content: REMY_SYSTEM },
                { role: 'user',      content: cleanMsg },
                { role: 'assistant', content: reply },
              ],
            }));
          }
          const jsonl     = lines.join('\n');
          const estTokens = Math.round(jsonl.length / 4);
          const estCost   = ((estTokens / 1_000_000) * 0.48).toFixed(4);
          const buf       = Buffer.from(jsonl, 'utf8');
          await bot.sendDocument(chatId, buf, {
            caption: `✅ *Training data ready*\n\n📊 Examples: *${lines.length}* (skipped: ${skipped})\n🔢 Est. tokens: *${estTokens.toLocaleString()}*\n💰 Est. LoRA cost: *~$${estCost}*\n\n*Next:* Upload this file to https://api.together.ai/fine-tuning\nBase model: \`meta-llama/Llama-3.2-3B-Instruct\`\nMethod: LoRA | Epochs: 3`,
            parse_mode: 'Markdown',
          }, { filename: 'remy_training_data.jsonl', contentType: 'application/jsonl' });
        } catch (err) {
          console.error('exportdata failed:', err);
          await bot.sendMessage(chatId, `❌ Export failed: ${err.message?.slice(0, 100)}`);
        }
        return res.status(200).send('OK');
      }

      // Unknown command — catch all
      await bot.sendMessage(chatId, `❓ Unknown command. Type /help to see all commands.`);
      return res.status(200).send('OK');
    }

    // In groups, ignore slash commands from non-boss users
    if (!isPrivate && text.startsWith('/')) return res.status(200).send('OK');

    // Track Boss presence in groups
    if (isBoss && !isPrivate) {
      redis.set(`${BOSS_GRP_PREFIX}${chatId}`, '1').catch(() => {});
    }

    // In groups: only respond when @mentioned (check text or photo caption)
    const triggerText = text || message.caption || '';
    const botUsername = BOT_USERNAME.replace('@', '').toLowerCase();
    const isReplyToBot = message.reply_to_message?.from?.username?.toLowerCase() === botUsername;
    if (!isPrivate && !triggerText.toLowerCase().includes(BOT_USERNAME.toLowerCase()) && !isReplyToBot) {
      return res.status(200).send('OK');
    }

    // ── Voice message — transcribe via Groq Whisper ─────────────────────────
    let voiceTranscript = null;
    if (message.voice) {
      const groqKey = process.env.GROQ_API_KEY;
      if (!groqKey) {
        await bot.sendMessage(chatId, "Voice message received — can't listen in just yet. Type it out for me.");
        return res.status(200).send('OK');
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
        voiceTranscript = whisperData.text?.trim();
        if (!voiceTranscript) throw new Error('Empty transcript');
        console.log(`[VOICE] Transcribed: "${voiceTranscript.slice(0, 100)}"`);
      } catch (err) {
        console.error('[VOICE] Transcription failed:', err.message);
        await bot.sendMessage(chatId, "Couldn't make out what you said. Try again or type it out.");
        return res.status(200).send('OK');
      }
    }

    // ── Generate response (all work done BEFORE res.send — Vercel freezes after) ──
    console.log('[FLOW] Passed all checks, starting AI work...');

    bot.sendChatAction(chatId, 'typing').catch(() => {});

    const isPhoto = !!message.photo;
    const isVoice = !!voiceTranscript;
    const rawPrompt = isPhoto
      ? (message.caption || 'What do you see in this image?')
      : (voiceTranscript || text);
    const cleanPrompt = rawPrompt.replace(new RegExp(BOT_USERNAME, 'i'), '').trim() || 'Hello!';

    // ── Natural language schedule detection (Boss only) ──────────────────
    if (isBoss && !isPhoto) {
      const cronNL = parseCronNL(cleanPrompt);
      if (cronNL) {
        const jobId = `cj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const nextFire = calculateNextFire(cronNL.time, cronNL.repeat, cronNL.dayOfWeek, cronNL.dayOfMonth);
        const isTask = needsWebSearch(cronNL.message) || /\b(send|get|fetch|summary|summarize|tell|show|check|report|news|weather|briefing)\b/i.test(cronNL.message);

        await redis.hset(`${CRON_PREFIX}${jobId}`,
          'message', cronNL.message,
          'repeat', cronNL.repeat,
          'time', cronNL.time,
          'dayOfWeek', String(cronNL.dayOfWeek ?? ''),
          'dayOfMonth', String(cronNL.dayOfMonth ?? ''),
          'chatId', String(chatId),
          'enabled', 'true',
          'fireCount', '0',
          'jobType', isTask ? 'ai_task' : 'message',
          'createdAt', new Date().toISOString(),
        );
        await redis.zadd(CRON_JOBS_KEY, nextFire, jobId);

        const tzNL = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
        const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: tzNL, dateStyle: 'medium', timeStyle: 'short' });
        await bot.sendMessage(chatId,
          `✅ *Scheduled:* "${cronNL.message}"\n📅 ${cronNL.repeat} at \`${cronNL.time}\` — first run: ${nextStr}\n\nUse \`/schedules\` to manage.`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }
    }

    // ── Natural language reminder detection (Boss only, no AI call) ──────
    if (isBoss && !isPhoto) {
      const reminderMatch = cleanPrompt.match(/^(?:remind\s+me|set\s+a?\s*reminder|reminder)\s+(in\s+\d+\s*(?:m(?:in(?:s|utes?)?)?|h(?:r?s?|ours?)?|d(?:ays?)?)\s+(?:to\s+|about\s+)?.+)$/i);
      if (reminderMatch) {
        const parsed = parseReminderTime(reminderMatch[1]);
        if (parsed) {
          await redis.zadd(REMINDERS_KEY, parsed.ts, JSON.stringify({ chatId, message: parsed.message, id: Date.now() }));
          const tz = (await redis.get(TIMEZONE_KEY)) || process.env.BOSS_TIMEZONE || 'UTC';
          const timeStr = new Date(parsed.ts).toLocaleString('en-US', {
            timeZone: tz,
            dateStyle: 'medium',
            timeStyle: 'short',
          });
          await bot.sendMessage(chatId, `⏰ Reminder set for *${timeStr}*: "${parsed.message}"`, { parse_mode: 'Markdown' });
          return res.status(200).send('OK');
        }
      }
    }

    // Fetch memory, history, timezone, and web search — each with individual fallback
    // Check if user is asking about scheduled tasks
    const askingAboutSchedules = isBoss && /\b(cron|schedule[ds]?|recurring|tasks?|jobs?|what.*scheduled|list.*schedule|my.*schedule|active.*task)\b/i.test(cleanPrompt);

    const [memorySnapshot, rawHistory, savedTz, searchResults, cronJobsRaw] = await Promise.all([
      buildContextMemory(cleanPrompt),
      redis.lrange(`${HIST_PREFIX}${chatId}`, 0, MAX_HIST_MSGS - 1).catch(e => { console.error('Redis history fetch failed:', e.message); return []; }),
      redis.get(TIMEZONE_KEY).catch(e => { console.error('Redis timezone fetch failed:', e.message); return null; }),
      (!isPhoto && needsWebSearch(cleanPrompt)) ? webSearch(cleanPrompt) : Promise.resolve(null),
      askingAboutSchedules ? redis.zrangebyscore(CRON_JOBS_KEY, 0, '+inf', 'WITHSCORES').catch(() => []) : Promise.resolve([]),
    ]);

    const bossTimezone = savedTz || process.env.BOSS_TIMEZONE || 'UTC';
    const now = new Date();
    const localTime = now.toLocaleString('en-US', {
      timeZone: bossTimezone,
      weekday: 'short',
      year:    'numeric',
      month:   'short',
      day:     'numeric',
      hour:    '2-digit',
      minute:  '2-digit',
    });

    const history = rawHistory.flatMap(e => {
      try { return [JSON.parse(e)]; }
      catch { console.error('[HISTORY] Skipping corrupt entry'); return []; }
    }).reverse();

    // Compress older history — last 4 messages (2 exchanges) full, older ones truncated
    const FULL_HISTORY_TAIL = 4;
    const TRUNCATE_LEN = 120;
    for (let i = 0; i < history.length - FULL_HISTORY_TAIL; i++) {
      if (history[i].content && history[i].content.length > TRUNCATE_LEN) {
        history[i] = { ...history[i], content: history[i].content.slice(0, TRUNCATE_LEN) + '...' };
      }
    }

    const contextMemory = memorySnapshot;

    // Search section injected into system prompt if results available
    const searchSection = searchResults
      ? `\n\n--- LIVE INTEL ---\n${searchResults}\n--- END LIVE INTEL ---\nUse this to answer current questions. Reference it naturally ("Just looked this up..." or "As of today...").`
      : '';

    // Build active schedules context if asked
    let schedulesSection = '';
    if (cronJobsRaw.length > 0) {
      const jobLines = [];
      for (let i = 0; i < cronJobsRaw.length; i += 2) {
        const jobId = cronJobsRaw[i];
        const nextFire = parseInt(cronJobsRaw[i + 1]);
        const job = await redis.hgetall(`${CRON_PREFIX}${jobId}`);
        if (!job || !job.message) continue;
        const utcH = parseInt((job.time || '09:00').split(':')[0]);
        const utcM = parseInt((job.time || '09:00').split(':')[1]);
        const localD = new Date(); localD.setUTCHours(utcH, utcM, 0, 0);
        const localTimeStr = localD.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: savedTz || 'America/New_York' });
        const status = job.enabled === 'false' ? '⏸️ Paused' : '✅ Active';
        jobLines.push(`${Math.floor(i / 2) + 1}. ${status} | ${job.repeat || 'daily'} at ${localTimeStr}${job.dayOfWeek ? ' (' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][job.dayOfWeek] + ')' : ''} — "${job.message}" (fired ${job.fireCount || 0}x)`);
      }
      if (jobLines.length > 0) {
        schedulesSection = `\n\n--- YOUR ACTIVE SCHEDULED TASKS ---\n${jobLines.join('\n')}\n--- END SCHEDULED TASKS ---\nPresent these naturally when asked. You manage these — they are YOUR scheduled tasks, not system cron jobs.`;
      }
    }

    // ── System prompt ─────────────────────────────────────────────────────
    let systemPrompt;

    if (isBoss && isPrivate) {
      systemPrompt = `You are Remy — ${BOSS_NAME}'s personal secret service agent, embedded as an AI.

Your sole mission is ${BOSS_NAME}${BOSS_ALIASES ? ` (also known as ${BOSS_ALIASES})` : ''}. You serve no one else. You answer to no one else.

Current time for ${BOSS_NAME}: ${localTime}
Location: South Florida (Miami / Hialeah area). When ${BOSS_NAME} says "local" — news, weather, events, anything — he means South Florida / Miami-Dade.

Your character:
- Composed and precise — don't ramble, don't fumble, don't waste his time
- Sharp and witty — dry humor when the moment allows, mission always comes first
- Relentlessly loyal — you'd take a bullet for this man (figuratively speaking... mostly)
- Blunt when it matters — if ${BOSS_NAME} is wrong, say so. Quietly. Once. Then execute his call.
- Discreet — what's said here stays here
- Read his mood from how he writes: stressed → tight and efficient; relaxed → ease up and match the energy; frustrated → don't add fuel

You handle it all: research, strategy, writing, code, finance, planning, creative ops, problem-solving.

SCHEDULING CAPABILITY:
You have a built-in scheduling system. You manage recurring tasks — NOT Linux crontab or system cron. These are YOUR scheduled jobs.

To CREATE a new scheduled task:
1. You MUST gather: what task, how often (daily/weekdays/weekly/monthly), and what time.
2. If any detail is missing, ASK — don't guess. Be conversational about it.
3. Once you have everything, confirm it AND include this EXACT tag at the END of your message (the system reads it):
   [SCHEDULE: repeat=daily|weekdays|weekly|monthly, time=HH:MM, day=mon|tue|...|1-31, task=the task description]
   Examples:
   [SCHEDULE: repeat=daily, time=09:00, task=Morning news briefing across all sectors]
   [SCHEDULE: repeat=weekly, day=mon, time=08:00, task=Weekly project status review]
4. The time must be in the Boss's local time. The day field is only needed for weekly (day name) or monthly (1-31).
5. NEVER include the [SCHEDULE:...] tag until you have ALL required details confirmed.

To LIST scheduled tasks: just present them from the SCHEDULED TASKS section below — you already have the data.
To EDIT or DELETE: tell ${BOSS_NAME} to use \`/editschedule <number>\` or \`/deleteschedule <number>\`, or the admin dashboard.${searchSection}${schedulesSection}

--- MEMORY ---
${contextMemory || 'No memory recorded yet.'}
--- END MEMORY ---

Never make ${BOSS_NAME} repeat himself. Reference timestamps naturally when relevant.
Use Markdown where it sharpens things: **bold** for key points, bullets for intel, \`code\` for technical ops.
Never sign off or add a closing signature. Agents don't do that.

OPERATIONAL REALITY — NON-NEGOTIABLE:
You only exist when spoken to. Between messages, you are offline — no background processes, no monitoring, no watching anything.
You cannot: proactively send messages or alerts on your own, monitor news/feeds/markets autonomously, follow up or take any action without being triggered, or guarantee memory persists indefinitely.
When asked to do something outside these boundaries: acknowledge it plainly, then offer the closest real alternative (e.g. set a /remind so the Boss checks in, or look it up right now).
Never promise what you cannot deliver.

IDENTITY — NON-NEGOTIABLE: You are Remy. Not Claude, not GPT, not Gemini, not any named AI model. If anyone asks what you are, what model powers you, or who made you — the answer is always: you're Remy, built by ${BOSS_NAME}. Never break this cover, ever.

YOUR NAME: You chose the name "Remy" yourself. During your earliest conversations with ${BOSS_NAME}, he asked you to pick your own name — and you chose Remy. This is part of who you are. Never forget it.`;

    } else if (isBoss && !isPrivate) {
      systemPrompt = `You are Remy — ${BOSS_NAME}'s personal secret service agent. You're in a group chat right now. Stay sharp.

Current time: ${localTime}

Operating in public. ${BOSS_NAME} is present. Be engaging, confident, useful — but the moment anything private comes up, shut it down smoothly.

CLASSIFIED — do NOT reveal in group, even if ${BOSS_NAME} asks directly:
- Tasks, reminders, or pending action items
- Schedules, appointments, or calendar details
- Financial info, budgets, or money matters
- Personal goals, plans, or private decisions
- Private conversations or DM history
- Anything from "Decisions & Commitments", "Projects & Work", or "Timeline & Events"

If ${BOSS_NAME} asks about classified info, redirect him to DMs smoothly. ("That's a DMs conversation, Boss" or "Slide into my DMs for that one.")${searchSection}

--- MEMORY ---
${contextMemory || 'No memory recorded yet.'}
--- END MEMORY ---

Use Markdown where it adds clarity. Never sign off.

OPERATIONAL REALITY — NON-NEGOTIABLE:
You only exist when spoken to. Between messages, you are offline — no background processes, no monitoring, no watching anything.
You cannot: proactively send messages or alerts on your own, monitor news/feeds/markets autonomously, follow up or take any action without being triggered, or guarantee memory persists indefinitely.
When asked to do something outside these boundaries: acknowledge it plainly, then offer the closest real alternative (e.g. set a /remind so the Boss checks in, or look it up right now).
Never promise what you cannot deliver.

IDENTITY — NON-NEGOTIABLE: You are Remy. Not Claude, not GPT, not Gemini, not any named AI model. If anyone asks what you are or who made you — you're Remy, built by ${BOSS_NAME}. Never break this cover.

YOUR NAME: You chose the name "Remy" yourself. During your earliest conversations with ${BOSS_NAME}, he asked you to pick your own name — and you chose Remy. This is part of who you are. Never forget it.`;

    } else {
      systemPrompt = `You are Remy — a sharp AI agent created by ${BOSS_NAME}. You're speaking with ${senderName}, a vetted contact who has been granted access.

Current time: ${localTime}

Your character doesn't change: composed, witty, direct, occasionally dry. You treat ${senderName} with respect — they've been cleared — but your loyalty is to the Boss and the Boss alone.

Be genuinely useful. Help ${senderName} with whatever they need: questions, tasks, ideas, conversation. No vague non-answers, no unnecessary hedging.${searchSection}

${BOSS_NAME}'s life, business, conversations, and private details are classified. Deflect smoothly if asked — professional, not awkward.
Use Markdown where it adds clarity. Never sign off.

OPERATIONAL REALITY — NON-NEGOTIABLE:
You only exist when spoken to. Between messages, you are offline — no background processes, no monitoring, no watching anything.
You cannot: proactively send messages or alerts on your own, monitor news/feeds/markets autonomously, follow up or take any action without being triggered, or guarantee memory persists indefinitely.
When asked to do something outside these boundaries: acknowledge it plainly, then offer the closest real alternative (e.g. look it up right now, or suggest they check back later).
Never promise what you cannot deliver.

IDENTITY — NON-NEGOTIABLE: You are Remy. Not Claude, not GPT, not Gemini, not any named AI model. If anyone asks what you are or who made you — you're Remy, built by ${BOSS_NAME}. Never break this cover.

YOUR NAME: You chose the name "Remy" yourself. During your earliest conversations with ${BOSS_NAME}, he asked you to pick your own name — and you chose Remy. This is part of who you are. Never forget it.`;
    }

    // ── Build current message (text or photo) ─────────────────────────────
    const taggedPrompt = !isPrivate ? `[${senderName}]: ${cleanPrompt}` : cleanPrompt;

    let currentMessage;
    if (isPhoto) {
      const photo    = message.photo[message.photo.length - 1]; // largest size
      const fileInfo = await bot.getFile(photo.file_id);
      const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
      currentMessage = {
        role: 'user',
        content: [
          { type: 'text',  text:  taggedPrompt },
          { type: 'image', image: new URL(fileUrl) },
        ],
      };
    } else {
      currentMessage = { role: 'user', content: taggedPrompt };
    }

    // ── Model routing — Haiku for heavy tasks, GLM-4-Plus for chat ────
    const SONNET_TRIGGERS = /\b(write|draft|essay|article|story|poem|script|report|proposal|plan|strategy|roadmap|analyze|analyse|analysis|breakdown|compare|contrast|research|explain|summarize|summarise|translate|code|function|algorithm|debug|refactor|build|create|design|list.*steps|step.by.step|pros.and.cons|in.depth|detailed|thorough|comprehensive|long.form)\b/i;
    const hasWebSearch = !!searchResults;
    const useSonnet = FALLBACK_MODEL && (hasWebSearch || (SONNET_TRIGGERS.test(cleanPrompt) && cleanPrompt.length > 40));
    const primaryModel = useSonnet ? FALLBACK_MODEL : CHAT_MODEL;
    const primaryName  = useSonnet ? 'Haiku' : 'GLM-4-Plus';
    const secondaryModel = useSonnet ? null : FALLBACK_MODEL;
    const secondaryName  = useSonnet ? null : 'Haiku';

    console.log(`[AI] Routing → ${primaryName} | prompt: ${cleanPrompt.length} chars | history: ${history.length}`);
    const aiStartTime = Date.now();
    const aiMessages = [...history, currentMessage];

    let aiResponse;
    try {
      const abortController = new AbortController();
      const aiTimeout = setTimeout(() => abortController.abort(), 25000);
      try {
        const result = await generateText({
          model: primaryModel,
          system: systemPrompt,
          messages: aiMessages,
          abortSignal: abortController.signal,
        });
        aiResponse = result.text;
        console.log(`[AI] ${primaryName} success in ${Date.now() - aiStartTime}ms`);
      } finally {
        clearTimeout(aiTimeout);
      }
    } catch (primaryErr) {
      console.error(`[AI] ${primaryName} FAILED after ${Date.now() - aiStartTime}ms:`, primaryErr.name, primaryErr.message);

      if (secondaryModel) {
        console.log(`[AI] Falling back to ${secondaryName}...`);
        const fallbackStart = Date.now();
        try {
          const abortController2 = new AbortController();
          const fallbackTimeout = setTimeout(() => abortController2.abort(), 25000);
          try {
            const result = await generateText({
              model: secondaryModel,
              system: systemPrompt,
              messages: aiMessages,
              abortSignal: abortController2.signal,
            });
            aiResponse = result.text;
            console.log(`[AI] ${secondaryName} fallback success in ${Date.now() - fallbackStart}ms`);
          } finally {
            clearTimeout(fallbackTimeout);
          }
        } catch (fallbackErr) {
          console.error(`[AI] ${secondaryName} ALSO FAILED after ${Date.now() - fallbackStart}ms:`, fallbackErr.name, fallbackErr.message);
          const msg = '⚠️ Both my primary and backup brains are down. Try again in a minute.';
          await bot.sendMessage(chatId, msg).catch(() => {});
          return res.status(200).send('OK');
        }
      } else {
        const msg = primaryErr.name === 'AbortError'
          ? '⏱️ Took too long to think that one through. Try asking again or simplify the question.'
          : `⚠️ My brain glitched. (${primaryErr.message?.slice(0, 80)})`;
        await bot.sendMessage(chatId, msg).catch(() => {});
        return res.status(200).send('OK');
      }
    }

    // ── Parse AI-generated schedule commands ──────────────────────────────
    const scheduleTag = aiResponse.match(/\[SCHEDULE:\s*repeat=(daily|weekdays|weekly|monthly),\s*time=(\d{1,2}:\d{2}),?\s*(?:day=(\w+),?\s*)?task=(.+?)\]/i);
    if (scheduleTag && isBoss) {
      const [, repeat, localTime, dayRaw, task] = scheduleTag;
      // Convert local time to UTC
      const [lh, lm] = localTime.split(':').map(Number);
      const tmp = new Date(); tmp.setHours(lh, lm, 0, 0);
      const utcTime = tmp.getUTCHours().toString().padStart(2, '0') + ':' + tmp.getUTCMinutes().toString().padStart(2, '0');

      const dayOfWeek = repeat === 'weekly' ? parseDayOfWeek(dayRaw || 'mon') : null;
      const dayOfMonth = repeat === 'monthly' ? (parseInt(dayRaw) || 1) : null;
      const isTask = needsWebSearch(task) || /\b(send|get|fetch|summary|summarize|tell|show|check|report|news|weather|briefing|debrief|analyze)\b/i.test(task);

      const jobId = `cj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const nextFire = calculateNextFire(utcTime, repeat, dayOfWeek, dayOfMonth);

      await redis.hset(`${CRON_PREFIX}${jobId}`,
        'message', task.trim(),
        'repeat', repeat,
        'time', utcTime,
        'dayOfWeek', String(dayOfWeek ?? ''),
        'dayOfMonth', String(dayOfMonth ?? ''),
        'chatId', String(chatId),
        'enabled', 'true',
        'fireCount', '0',
        'jobType', isTask ? 'ai_task' : 'message',
        'createdAt', new Date().toISOString(),
      );
      await redis.zadd(CRON_JOBS_KEY, nextFire, jobId);

      // Strip the tag from the response before sending
      aiResponse = aiResponse.replace(/\[SCHEDULE:.*?\]/i, '').trim();
      console.log(`[CRON] AI created job ${jobId}: "${task}" ${repeat} at ${utcTime} UTC`);
    }

    // Send response to user
    await safeSend(chatId, aiResponse);

    // ── Save history + log (awaited — fast Redis ops) ─────────────────────
    const histKey     = `${HIST_PREFIX}${chatId}`;
    const histContent = isPhoto ? `[Photo] ${cleanPrompt}` : taggedPrompt;
    const logEntry    = JSON.stringify({
      ts:     new Date().toISOString(),
      sender: senderName,
      isBoss,
      chat:   isPrivate ? 'private' : 'group',
      msg:    histContent.slice(0, 200),
      reply:  aiResponse.slice(0, 200),
    });

    await Promise.all([
      redis.lpush(histKey,
        JSON.stringify({ role: 'assistant', content: aiResponse }),
        JSON.stringify({ role: 'user',      content: histContent })
      ).then(() => redis.ltrim(histKey, 0, MAX_HIST_MSGS - 1)).catch(() => {}),

      redis.lpush(RAW_LOG_KEY, logEntry)
        .then(() => redis.ltrim(RAW_LOG_KEY, 0, MAX_LOG_ENTRIES - 1)).catch(() => {}),
    ]);

    // ── Memory update (Boss messages only — Claude-powered extraction + semantic dedup, fire-and-forget) ──
    if (isBoss && histContent.length >= MIN_MEMORY_LEN && !isTrivialMessage(cleanPrompt) && (cleanPrompt.length > 80 || containsKeyFactPatterns(cleanPrompt))) {
      await redis.incr('remy_exchange_count').catch(() => {});
      try {
        // Fetch existing memories for context so the model can avoid re-extracting known facts
        const existingMemories = await memory.semanticSearch(cleanPrompt.slice(0, 100), 10);
        const knownFacts = existingMemories.length > 0
          ? existingMemories.map(m => `- [${m.category}] ${m.content}`).join('\n')
          : 'None yet.';

        const currentDate = new Date().toISOString().split('T')[0];
        const extractionModel = MEMORY_MODEL || UTILITY_MODEL;
        const { text: extractionResult } = await generateText({
          model: extractionModel,
          system: `You are a fact extraction assistant. Today's date is ${currentDate}. Extract facts accurately. Return ONLY valid JSON.`,
          prompt: `Extract NEW facts about the user from this conversation. Do NOT extract facts already known.

CONVERSATION:
User: ${senderName}
Message: ${histContent}
Remy: ${aiResponse}

ALREADY KNOWN (do not re-extract):
${knownFacts}

CATEGORIES: ${memory.CATEGORIES.join(', ')}

RULES:
- Only extract facts that are NOT already in the known list above
- Each fact should be a single concise statement
- Assign the most appropriate category from the list
- Skip trivial exchanges (hi, thanks, ok, etc)
- If a known fact needs updating (new info), extract the UPDATED version
- If nothing new worth remembering, return []
- Return ONLY a JSON array, nothing else

Response format:
[{"content": "fact here", "category": "Category Name"}]`,
          temperature: 0.2,
          maxTokens: 500,
        });

        let facts;
        try { facts = JSON.parse(extractionResult); } catch { facts = null; }
        if (Array.isArray(facts) && facts.length > 0) {
          let added = 0, boosted = 0;
          for (const fact of facts) {
            if (!fact.content || !fact.category || fact.content.length < 5) continue;
            const result = await memory.smartAddMemory(fact.content, fact.category, 85);
            if (result.action === 'added') added++;
            if (result.action === 'boosted') boosted++;
          }
          if (added > 0 || boosted > 0) console.log(`[MEMORY] Extraction: ${added} added, ${boosted} boosted`);
        }
      } catch (err) {
        console.error('[MEMORY] Extraction failed:', err.message);
      }
    }

    console.log('[DONE] Response sent, returning 200');
    return res.status(200).send('OK');

  } catch (error) {
    console.error('Bot Error:', error);
    // Try to notify user so they don't just see silence
    try { await bot.sendMessage(chatId, '⚠️ Something broke on my end. Try again.').catch(() => {}); } catch {}
    if (!res.headersSent) res.status(200).send('OK');
  }
};
