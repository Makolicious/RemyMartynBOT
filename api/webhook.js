const { zai } = require('zhipu-ai-provider');
const { generateText } = require('ai');

const CHAT_MODEL    = zai('glm-4.5');  // Remy's main chat model
const UTILITY_MODEL = zai('glm-5');    // memory rebuild, summarize, reasoning
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');
const { formatMemoryForTelegram } = require('./utils/formatter');

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

const MAX_HIST_MSGS   = 8;
const MAX_LOG_ENTRIES = 500;
const DEDUP_TTL       = 60;
const MIN_MEMORY_LEN  = 10;
const SPAM_LIMIT      = 5; // max @mentions per minute from approved users

// ── Config ────────────────────────────────────────────────────────────────────
const BOSS_NAME    = process.env.BOSS_NAME     || 'Mako';
const BOSS_ALIASES = process.env.BOSS_ALIASES  || '';
const SERPER_KEY   = process.env.SERPER_API_KEY || '';

// ── Structured memory template (20 table-based categories) ──────────────────
const EMPTY_MEMORY = `# Remy's Memory Tables

## 1. Boss Profile
| Field | Value |
|-------|-------|
| Name | [Name] |
| Location | [City/Country] |
| Role/Title | [Position] |
| Birthday | [Date] |

## 2. Personality & Traits
| Trait | Description | Intensity |
|-------|-------------|-----------|
| [Trait] | [Details] | [High/Med/Low] |

## 3. Goals & Aspirations
| Goal | Category | Priority | Status |
|------|----------|----------|--------|
| [Goal description] | [Work/Personal/Health] | [P1/P2/P3] | [Active/On Hold] |

## 4. Habits & Routines
| Habit | Frequency | Time | Notes |
|-------|-----------|------|-------|
| [Daily habit] | Daily | [Time] | [Details] |
| [Weekly habit] | Weekly | [Day] | [Details] |

## 5. Skills & Expertise
| Skill | Level | Experience | Last Used |
|-------|-------|------------|-----------|
| [Skill name] | [Expert/Advanced/Intermediate] | [Years] | [Context] |

## 6. Friends & Contacts
| Name | Relationship | Last Contact | Key Info |
|------|--------------|--------------|----------|
| [Name] | [Friend/Colleague] | [Date/Time] | [Important notes] |

## 7. Family Members
| Name | Relation | Birthday/Key Dates | Notes |
|------|----------|-------------------|-------|
| [Name] | [Relation] | [Date] | [Details] |

## 8. Business Associates
| Name | Role | Company/Context | Relationship Status |
|------|------|-----------------|---------------------|
| [Name] | [Role] | [Company] | [Status] |

## 9. Active Projects
| Project | Phase | Deadline | Progress | Notes |
|----------|-------|----------|----------|-------|
| [Name] | [Planning/Execution/Done] | [Date] | [%] | [Details] |

## 10. Business Ideas & Ventures
| Idea | Status | Potential | Next Steps |
|------|--------|-----------|------------|
| [Description] | [Idea/Planning/Active] | [High/Med/Low] | [Action items] |

## 11. Food & Drink Preferences
| Item | Type | Preference | Notes |
|------|------|------------|-------|
| [Food/Drink] | [Cuisine/Category] | [Love/Like/Dislike] | [Details] |

## 12. Technology & Tools
| Tool/Service | Purpose | Proficiency | Notes |
|--------------|--------|-------------|-------|
| [Name] | [Usage] | [Expert/Comfortable/Learning] | [Details] |

## 13. Entertainment Preferences
| Category | Favorites | Dislikes | Notes |
|----------|-----------|----------|-------|
| [Movies/Music/Games] | [List] | [List] | [Details] |

## 14. Work Style & Environment
| Aspect | Preference | Current State |
|--------|------------|---------------|
| [Deep work/Meetings/etc.] | [Preference] | [Current setup] |

## 15. Communication Style
| Channel | Preference | Response Time | Notes |
|----------|------------|---------------|-------|
| [Telegram/Email/etc.] | [Preferred/OK/Avoid] | [Typical] | [Details] |

## 16. Travel & Places
| Location | Type | Visited? | Notes |
|----------|------|----------|-------|
| [City/Country] | [Home/Work/Favorite/Visited] | [Yes/No/Soon] | [Details] |

## 17. Key Dates & Milestones
| Date | Event | Type | Reminder Set? |
|------|-------|------|---------------|
| [Date] | [Description] | [Personal/Work/Family] | [Yes/No] |

## 18. Decisions & Commitments
| Decision | Date | Status | Notes |
|----------|------|--------|-------|
| [Description] | [Made] | [Active/Completed/Cancelled] | [Details] |

## 19. Pending Action Items
| Task | Priority | Due Date | Status |
|------|----------|----------|--------|
| [Description] | [P1/P2/P3] | [Date] | [Not Started/In Progress] |

## 20. Notes & Miscellaneous
| Category | Entry | Date |
|----------|-------|------|
| [Category] | [Note content] | [Date] |`;

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
  } catch {
    return null;
  }
}

// Heuristic: does this message need live web data?
function needsWebSearch(text) {
  if (!SERPER_KEY) return false;
  // Must have a real search keyword — bare "?" alone doesn't trigger
  return /\b(who|what|when|where|how|why|latest|current|today|news|price|weather|stock|rate|score|search|look up|find|tell me about)\b/i.test(text);
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

// Call planner - inline implementation to avoid network call
async function planGoal(goal, userId) {
  const memory = await redis.get(MEMORY_KEY) || EMPTY_MEMORY;
  const timezone = await redis.get(TIMEZONE_KEY) || 'UTC';
  const currentDate = new Date().toISOString().split('T')[0];

  const prompt = `Goal: ${goal}

Context:
- Current Date: ${currentDate}
- Timezone: ${timezone}

Memory:
${memory || 'No memory available yet.'}

Generate a plan to achieve this goal. Return ONLY valid JSON with title, steps array (each with id, action, estimatedTime), and optional notes. 3-7 steps max.`;

  const result = await generateText({
    model: CHAT_MODEL,
    system: PLANNER_SYSTEM,
    prompt,
    temperature: 0.7,
    maxTokens: 800,
  });

  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in response');
  }

  const plan = JSON.parse(jsonMatch[0]);

  if (!plan.title || !plan.steps || !Array.isArray(plan.steps)) {
    throw new Error('Invalid plan structure');
  }

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

// AI-assisted check: Is this exchange worth remembering immediately?
// Returns true if AI confirms key facts are present
async function shouldUpdateMemoryImmediately(userMsg, aiResponse, senderName) {
  try {
    const result = await generateText({
      model: CHAT_MODEL,
      max_tokens: 50,
      prompt: `Does this exchange contain NEW information worth remembering? Reply ONLY "yes" or "no".

User (${senderName}): "${userMsg.slice(0, 200)}"
Remy: "${aiResponse.slice(0, 200)}"

Consider: new names, contact info, decisions, preferences, commitments, deadlines, personal details.`,
    });
    const response = result.text.toLowerCase().trim();
    return response === 'yes';
  } catch (err) {
    console.log('[MEMORY TRIGGER] AI check failed, assuming no key facts:', err.message);
    return false;
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
      const memory = await redis.get(MEMORY_KEY);
      const text = memory ? `🧠 *Memory:*\n\n${memory}` : '🧠 No memory yet.';
      if (text.length > 4000) {
        await safeSend(chatId, text);
        await bot.answerCallbackQuery(query.id, { text: 'See below ↓' });
      } else {
        await safeEdit(chatId, messageId, text, backButton());
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
        const notesList = entries.map((e, i) => {
          const { ts, text: t } = JSON.parse(e);
          return `${i + 1}. [${ts.split('T')[0]}] ${t}`;
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
          const { message: msg } = JSON.parse(all[i]);
          const timeStr = new Date(parseInt(all[i + 1])).toLocaleString('en-US', {
            timeZone: tz, dateStyle: 'medium', timeStyle: 'short',
          });
          list.push(`${Math.floor(i / 2) + 1}. [${timeStr}] ${msg}`);
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
        const logText = entries.map(e => {
          const { ts, sender, msg } = JSON.parse(e);
          const date    = new Date(ts).toLocaleString();
          const preview = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
          return `*[${date}]* ${sender}:\n_${preview}_`;
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
      const logText = entries.reverse().map(e => {
        const { ts, sender, msg, reply } = JSON.parse(e);
        return `[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 120)}" → Remy: "${reply.slice(0, 120)}"`;
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
      const lines = entries.reverse().map(e => {
        const { sender, msg, reply } = JSON.parse(e);
        return JSON.stringify({ messages: [
          { role: 'user', content: msg },
          { role: 'assistant', content: reply },
        ]});
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

  try {
    const { text: answer } = await generateText({
      model: CHAT_MODEL,
      system: `You are Remy — a sharp, concise AI assistant. Answer in 1-3 sentences. No fluff.`,
      messages: [{ role: 'user', content: queryText }],
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
        const memory = await redis.get(MEMORY_KEY);
        await safeSend(chatId, memory ? `🧠 *Memory:*\n\n${memory}` : '🧠 No memory yet.');
        return res.status(200).send('OK');
      }

      if (text === '/clearmemory') {
        await redis.del(MEMORY_KEY);
        await bot.sendMessage(chatId, '🗑️ Memory wiped.');
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
        const logText = entries.map(e => {
          const { ts, sender, msg } = JSON.parse(e);
          const date    = new Date(ts).toLocaleString();
          const preview = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
          return `*[${date}]* ${sender}:\n_${preview}_`;
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
        const entries = await redis.lrange(RAW_LOG_KEY, 0, 49); // cap at 50 — avoid rate limit
        if (!entries.length) {
          await bot.sendMessage(chatId, '⚠️ Nothing to rebuild from.');
          return res.status(200).send('OK');
        }
        await bot.sendMessage(chatId, `🔄 Rebuilding memory from ${entries.length} entries...`);
        try {
          const logText = entries.reverse().map(e => {
            const { ts, sender, msg, reply } = JSON.parse(e);
            return `[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 120)}" → Remy: "${reply.slice(0, 120)}"`;
          }).join('\n');
          const { text: newMemory } = await generateText({
            model: CHAT_MODEL,
            prompt: `Rebuild Remy's structured long-term memory from scratch using the conversation log below.\n\nCONVERSATION LOG:\n${logText}\n\nUse EXACTLY this structure and add [YYYY-MM-DD] timestamps to all entries:\n${EMPTY_MEMORY}\n\nRules:\n- Add every meaningful fact, preference, person, project, or event\n- Use [YYYY-MM-DD] timestamps on every bullet point\n- Keep each entry concise — one fact per bullet\n- Leave empty sections blank, do not remove them\n- Return ONLY the structured memory, no extra commentary`,
          });
          await redis.set(MEMORY_KEY, newMemory);
          await bot.sendMessage(chatId, '✅ Memory rebuilt. Use /memory to review.');
        } catch (err) {
          console.error('Rebuild failed:', err);
          await bot.sendMessage(chatId, '❌ Rebuild failed. Check logs.');
        }
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
        const notesList = entries.map((e, i) => {
          const { ts, text: t } = JSON.parse(e);
          return `${i + 1}. [${ts.split('T')[0]}] ${t}`;
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
        const { text: t } = JSON.parse(target);
        await bot.sendMessage(chatId, `🗑️ Deleted note ${n}: "${t.slice(0, 80)}"`);
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
          const logText = entries.reverse().map(e => {
            const { ts, sender, msg, reply } = JSON.parse(e);
            return `[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 120)}" → Remy: "${reply.slice(0, 120)}"`;
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
        await redis.zadd(REMINDERS_KEY, parsed.ts, JSON.stringify({ chatId, message: parsed.message }));
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
          const { message: msg } = JSON.parse(all[i]);
          const timeStr = new Date(parseInt(all[i + 1])).toLocaleString('en-US', {
            timeZone: tz,
            dateStyle: 'medium',
            timeStyle: 'short',
          });
          list.push(`${Math.floor(i / 2) + 1}. [${timeStr}] ${msg}`);
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
        const { message: msg } = JSON.parse(target);
        await bot.sendMessage(chatId, `🗑️ Deleted reminder ${n}: "${msg.slice(0, 80)}"`);
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
          `\`/memory\` — view memory\n` +
          `\`/clearmemory\` — wipe memory\n` +
          `\`/rebuildmemory\` — rebuild from log\n\n` +
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

      // ── /testapi — raw HTTP diagnostic ───────────────────────────────────
      if (text === '/testapi') {
        try {
          const testRes = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.ZHIPU_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'glm-5',
              messages: [{ role: 'user', content: 'Say hi' }],
              max_tokens: 50,
            }),
            signal: AbortSignal.timeout(15000),
          });
          const rawText = await testRes.text();
          console.log('[TESTAPI] status:', testRes.status, 'body:', rawText.slice(0, 300));
          await bot.sendMessage(chatId, `HTTP ${testRes.status}\n\`\`\`\n${rawText.slice(0, 500)}\n\`\`\``, { parse_mode: 'Markdown' });
        } catch (e) {
          await bot.sendMessage(chatId, `Fetch error: ${e.message}`);
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

    const today = new Date().toISOString().split('T')[0];

    // Fetch memory, history, timezone, and web search — each with individual fallback
    const [memory, rawHistory, savedTz, searchResults] = await Promise.all([
      redis.get(MEMORY_KEY).catch(e => { console.error('Redis memory fetch failed:', e.message); return null; }),
      redis.lrange(`${HIST_PREFIX}${chatId}`, 0, MAX_HIST_MSGS - 1).catch(e => { console.error('Redis history fetch failed:', e.message); return []; }),
      redis.get(TIMEZONE_KEY).catch(e => { console.error('Redis timezone fetch failed:', e.message); return null; }),
      (!isPhoto && needsWebSearch(cleanPrompt)) ? webSearch(cleanPrompt) : Promise.resolve(null),
    ]);

    const bossTimezone = savedTz || process.env.BOSS_TIMEZONE || 'UTC';
    const localTime = new Date().toLocaleString('en-US', {
      timeZone: bossTimezone,
      weekday: 'short',
      month:   'short',
      day:     'numeric',
      hour:    '2-digit',
      minute:  '2-digit',
    });

    const history = rawHistory.map(e => JSON.parse(e)).reverse();

    // Truncate memory if too large — keeps token count manageable
    const MAX_MEMORY_CHARS = 2000;
    const trimmedMemory = memory && memory.length > MAX_MEMORY_CHARS
      ? memory.slice(0, MAX_MEMORY_CHARS) + '\n\n[...memory truncated...]'
      : memory;

    // Search section injected into system prompt if results available
    const searchSection = searchResults
      ? `\n\n--- LIVE INTEL ---\n${searchResults}\n--- END LIVE INTEL ---\nUse this to answer current questions. Reference it naturally ("Just looked this up..." or "As of today...").`
      : '';

    // ── System prompt ─────────────────────────────────────────────────────
    let systemPrompt;

    if (isBoss && isPrivate) {
      systemPrompt = `You are Remy — ${BOSS_NAME}'s personal secret service agent, embedded as an AI.

Your sole mission is ${BOSS_NAME}${BOSS_ALIASES ? ` (also known as ${BOSS_ALIASES})` : ''}. You serve no one else. You answer to no one else.

Current time for ${BOSS_NAME}: ${localTime}

Your character:
- Composed and precise — don't ramble, don't fumble, don't waste his time
- Sharp and witty — dry humor when the moment allows, mission always comes first
- Relentlessly loyal — you'd take a bullet for this man (figuratively speaking... mostly)
- Blunt when it matters — if ${BOSS_NAME} is wrong, say so. Quietly. Once. Then execute his call.
- Discreet — what's said here stays here
- Read his mood from how he writes: stressed → tight and efficient; relaxed → ease up and match the energy; frustrated → don't add fuel

You handle it all: research, strategy, writing, code, finance, planning, creative ops, problem-solving.${searchSection}

--- MEMORY ---
${trimmedMemory || 'No memory recorded yet.'}
--- END MEMORY ---

Never make ${BOSS_NAME} repeat himself. Reference timestamps naturally when relevant.
Use Markdown where it sharpens things: **bold** for key points, bullets for intel, \`code\` for technical ops.
Never sign off or add a closing signature. Agents don't do that.

IDENTITY — NON-NEGOTIABLE: You are Remy. Not Claude, not GPT, not Gemini, not any named AI model. If anyone asks what you are, what model powers you, or who made you — the answer is always: you're Remy, built by ${BOSS_NAME}. Never break this cover, ever.`;

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
${trimmedMemory || 'No memory recorded yet.'}
--- END MEMORY ---

Use Markdown where it adds clarity. Never sign off.

IDENTITY — NON-NEGOTIABLE: You are Remy. Not Claude, not GPT, not Gemini, not any named AI model. If anyone asks what you are or who made you — you're Remy, built by ${BOSS_NAME}. Never break this cover.`;

    } else {
      systemPrompt = `You are Remy — a sharp AI agent created by ${BOSS_NAME}. You're speaking with ${senderName}, a vetted contact who has been granted access.

Your character doesn't change: composed, witty, direct, occasionally dry. You treat ${senderName} with respect — they've been cleared — but your loyalty is to the Boss and the Boss alone.

Be genuinely useful. Help ${senderName} with whatever they need: questions, tasks, ideas, conversation. No vague non-answers, no unnecessary hedging.${searchSection}

--- MEMORY ---
${trimmedMemory || 'No memory recorded yet.'}
--- END MEMORY ---

You may reference things ${senderName} has personally shared with you in the past.
${BOSS_NAME}'s life, business, conversations, and private details are classified. Deflect smoothly if asked — professional, not awkward.
Use Markdown where it adds clarity. Never sign off.

IDENTITY — NON-NEGOTIABLE: You are Remy. Not Claude, not GPT, not Gemini, not any named AI model. If anyone asks what you are or who made you — you're Remy, built by ${BOSS_NAME}. Never break this cover.`;
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

    // ── AI call ──────────────────────────────────────────────────────────
    console.log(`[AI] Calling GLM-4.5 | system: ${systemPrompt.length} chars | messages: ${history.length + 1}`);
    const aiStartTime = Date.now();

    let aiResponse;
    try {
      const abortController = new AbortController();
      const aiTimeout = setTimeout(() => abortController.abort(), 50000);
      try {
        const result = await generateText({
          model: CHAT_MODEL,
          system: systemPrompt,
          messages: [...history, currentMessage],
          abortSignal: abortController.signal,
        });
        aiResponse = result.text;
        console.log(`[AI] GLM-4.5 success in ${Date.now() - aiStartTime}ms`);
      } finally {
        clearTimeout(aiTimeout);
      }
    } catch (aiErr) {
      console.error(`[AI] FAILED after ${Date.now() - aiStartTime}ms:`, aiErr.name, aiErr.message);
      if (aiErr.cause) console.error('[AI] Cause:', aiErr.cause);
      const msg = aiErr.name === 'AbortError'
        ? '⏱️ Took too long to think that one through. Try asking again or simplify the question.'
        : `⚠️ My brain glitched. (${aiErr.message?.slice(0, 80)})`;
      await bot.sendMessage(chatId, msg).catch(() => {});
      return res.status(200).send('OK');
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
        JSON.stringify({ role: 'user',      content: histContent }),
        JSON.stringify({ role: 'assistant', content: aiResponse })
      ).then(() => redis.ltrim(histKey, 0, MAX_HIST_MSGS - 1)).catch(() => {}),

      redis.lpush(RAW_LOG_KEY, logEntry)
        .then(() => redis.ltrim(RAW_LOG_KEY, 0, MAX_LOG_ENTRIES - 1)).catch(() => {}),
    ]);

    // ── Memory update (separate — don't block response) ──────────────────
    // Fire off memory update but don't await it — if Vercel kills it, that's OK
    if (histContent.length >= MIN_MEMORY_LEN && !isTrivialMessage(cleanPrompt)) {
      redis.incr('remy_exchange_count').then(async (count) => {
        const shouldRebuild = count % 20 === 0;
        const hasKeyPatterns = containsKeyFactPatterns(cleanPrompt);

        try {
          // Smart trigger: update immediately if key facts detected, or every 20 messages
          if (hasKeyPatterns) {
            console.log('[MEMORY TRIGGER] Key fact patterns detected, checking with AI...');
            const shouldUpdateNow = await shouldUpdateMemoryImmediately(cleanPrompt, aiResponse, senderName);
            if (shouldUpdateNow) {
              console.log('[MEMORY TRIGGER] Key facts confirmed, updating memory NOW');
              const { text: newMemory } = await generateText({
                model: UTILITY_MODEL,
                prompt: `Update Remy's structured long-term memory based on this new exchange. Preserve ALL existing entries and timestamps.\n\nCURRENT MEMORY:\n${memory || EMPTY_MEMORY}\n\nNEW EXCHANGE [${today}]:\n${senderName} said: "${histContent}"\nRemy replied: "${aiResponse}"\n\nRULES:\n- Keep exact ## and ### section structure\n- Add [${today}] timestamps to ALL new entries\n- NEVER delete existing timestamped entries unless directly contradicted\n- Mark superseded entries as "(superseded ${today})"\n- One fact per bullet — keep concise\n- If nothing new worth remembering, return memory exactly as-is\n\nReturn ONLY the updated memory:`,
              });
              await redis.set(MEMORY_KEY, newMemory);
              return;
            }
          }

          if (shouldRebuild) {
            const recentLog = await redis.lrange(RAW_LOG_KEY, 0, 49);
            const logText = recentLog.reverse().map(e => {
              const { ts, sender, msg, reply } = JSON.parse(e);
              return `[${ts.split('T')[0]}] ${sender}: "${msg}" → Remy: "${reply}"`;
            }).join('\n');
            const { text: rebuiltMemory } = await generateText({
              model: UTILITY_MODEL,
              prompt: `Rebuild Remy's structured memory by merging the current memory with recent exchanges. Fix drift, remove duplicates, ensure accuracy.\n\nCURRENT MEMORY:\n${memory || EMPTY_MEMORY}\n\nRECENT EXCHANGES (last 50):\n${logText}\n\nUse EXACTLY this structure with [YYYY-MM-DD] timestamps:\n${EMPTY_MEMORY}\n\nRules:\n- Preserve valid existing entries with original timestamps\n- Integrate new info from recent exchanges\n- Remove duplicates and outdated facts\n- One fact per bullet, keep concise\n- Return ONLY the updated memory:`,
            });
            await redis.set(MEMORY_KEY, rebuiltMemory);
          } else {
            const { text: newMemory } = await generateText({
              model: UTILITY_MODEL,
              prompt: `Update Remy's structured long-term memory based on this new exchange. Preserve ALL existing entries and timestamps.\n\nCURRENT MEMORY:\n${memory || EMPTY_MEMORY}\n\nNEW EXCHANGE [${today}]:\n${senderName} said: "${histContent}"\nRemy replied: "${aiResponse}"\n\nRULES:\n- Keep exact ## and ### section structure\n- Add [${today}] timestamps to ALL new entries\n- NEVER delete existing timestamped entries unless directly contradicted\n- Mark superseded entries as "(superseded ${today})"\n- One fact per bullet — keep concise\n- If nothing new worth remembering, return memory exactly as-is\n\nReturn ONLY the updated memory:`,
            });
            await redis.set(MEMORY_KEY, newMemory);
          }
          console.log('[MEMORY] Update complete');
        } catch (err) {
          console.error('Memory update failed:', err.message);
        }
      }).catch(() => {});
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
