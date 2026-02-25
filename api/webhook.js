const { zhipu } = require('zhipu-ai-provider');
const { generateText } = require('ai');
const TelegramBot = require('node-telegram-bot-api');
const Redis = require('ioredis');

// ── Validate required env vars on cold start ─────────────────────────────────
const REQUIRED_ENV = ['TELEGRAM_TOKEN', 'MY_TELEGRAM_ID', 'REDIS_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 5000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 1,
});
redis.on('error', (err) => console.error('Redis error:', err.message));

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const MEMORY_KEY      = 'remy_memory';
const RAW_LOG_KEY     = 'remy_raw_log';
const APPROVED_KEY    = 'approved_users';
const BOSS_GRP_PREFIX = 'boss_group_';
const HIST_PREFIX     = 'history_';
const DEDUP_PREFIX    = 'dedup_';
const MAX_HIST_MSGS   = 12;
const MAX_LOG_ENTRIES  = 500;
const DEDUP_TTL       = 60; // seconds
const MIN_MEMORY_LEN  = 10; // skip memory update for trivial messages

const BOSS_NAME    = process.env.BOSS_NAME    || 'Mako';
const BOSS_ALIASES = process.env.BOSS_ALIASES || '';

// Structured memory template — all categories and subcategories
const EMPTY_MEMORY = `## Boss Profile
### Identity
### Personality & Traits
### Goals & Aspirations
### Habits & Routines
### Skills & Expertise

## People
### Friends & Close Contacts
### Family
### Colleagues & Business Associates
### Other Notable Individuals

## Relationships
### Key Dynamics
### Trust & Loyalty Notes

## Projects & Work
### Active Projects
### Business Ideas & Ventures
### Completed Projects
### Goals & Targets

## Preferences
### Food & Drink
### Technology & Tools
### Entertainment & Media
### Work Style & Environment
### Communication Style
### Travel & Places

## Important Facts & Dates
### Personal Milestones
### Key Dates & Anniversaries
### Locations (Home, Work, etc.)

## Decisions & Commitments
### Decisions Made
### Promises & Commitments
### Pending Action Items

## Conversation Topics & Opinions
### Recurring Themes
### Strong Opinions & Beliefs
### Ongoing Debates or Discussions

## Timeline & Events
### Recent Events
### Upcoming Events
### Historical Events Worth Remembering

## Notes & Miscellaneous`;

// Send long messages in chunks (Telegram limit = 4096 chars)
async function safeSend(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, chunk);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Bot is running');

  const AUTHORIZED_USER_ID = Number(process.env.MY_TELEGRAM_ID);
  const BOT_USERNAME = '@remy_martyn_bot';

  try {
    const { message } = req.body;
    if (!message || !message.text) return res.status(200).send('OK');

    // ── Dedup: skip if Telegram retried this webhook ─────────────────────────
    const dedupKey = `${DEDUP_PREFIX}${message.message_id}`;
    const isNew = await redis.set(dedupKey, '1', 'EX', DEDUP_TTL, 'NX');
    if (!isNew) return res.status(200).send('OK');

    const senderId   = message.from?.id;
    const chatId     = message.chat.id;
    const text       = message.text;
    const senderName = message.from?.first_name || 'Someone';
    const isPrivate  = message.chat.type === 'private';
    const isBoss     = senderId === AUTHORIZED_USER_ID;

    // Only Boss can DM Remy
    if (isPrivate && !isBoss) return res.status(200).send('OK');

    // In groups: sender must be Boss or an approved user in a Boss-active group
    if (!isPrivate && !isBoss) {
      const [isApproved, bossActive] = await Promise.all([
        redis.sismember(APPROVED_KEY, String(senderId)),
        redis.get(`${BOSS_GRP_PREFIX}${chatId}`)
      ]);
      if (!isApproved || !bossActive) return res.status(200).send('OK');
    }

    // ── Boss commands (DM only) ──────────────────────────────────────────────
    if (isBoss && isPrivate) {

      if (text === '/start') {
        await bot.sendMessage(chatId, `What's good ${BOSS_NAME} 👋\nI'm online and ready. Type /help to see what I can do.`);
        return res.status(200).send('OK');
      }

      if (text.startsWith('/allow ')) {
        const id = text.slice(7).trim().replace(/[<>]/g, '');
        await redis.sadd(APPROVED_KEY, id);
        await bot.sendMessage(chatId, `✅ User \`${id}\` can now talk to me in groups.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // /remove and /revoke are aliases
      if (text.startsWith('/remove ') || text.startsWith('/revoke ')) {
        const id = text.split(' ').slice(1).join(' ').trim().replace(/[<>]/g, '');
        await redis.srem(APPROVED_KEY, id);
        await bot.sendMessage(chatId, `🚫 User \`${id}\` access revoked.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // /status and /list are aliases
      if (text === '/status' || text === '/list') {
        const [users, groupKeys] = await Promise.all([
          redis.smembers(APPROVED_KEY),
          redis.keys(`${BOSS_GRP_PREFIX}*`)
        ]);
        const userList  = users.length     ? users.map(u => `• \`${u}\``).join('\n')                                         : '_None_';
        const groupList = groupKeys.length ? groupKeys.map(k => `• \`${k.replace(BOSS_GRP_PREFIX, '')}\``).join('\n') : '_None_';
        await bot.sendMessage(chatId, `👥 *Approved users:*\n${userList}\n\n📍 *Active groups:*\n${groupList}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (text === '/memory') {
        const memory = await redis.get(MEMORY_KEY);
        await safeSend(chatId, memory ? `🧠 *My memory:*\n\n${memory}` : '🧠 No memory yet.');
        return res.status(200).send('OK');
      }

      if (text === '/clearmemory') {
        await redis.del(MEMORY_KEY);
        await bot.sendMessage(chatId, '🗑️ Memory wiped. Starting fresh.');
        return res.status(200).send('OK');
      }

      if (text === '/clearhistory') {
        await redis.del(`${HIST_PREFIX}${chatId}`);
        await bot.sendMessage(chatId, '🗑️ Conversation history cleared for this chat.');
        return res.status(200).send('OK');
      }

      if (text === '/log') {
        const entries = await redis.lrange(RAW_LOG_KEY, 0, 9);
        if (entries.length === 0) {
          await bot.sendMessage(chatId, '📋 No log entries yet.');
          return res.status(200).send('OK');
        }
        const logText = entries.map(e => {
          const { ts, sender, msg } = JSON.parse(e);
          const date = new Date(ts).toLocaleString();
          const preview = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
          return `*[${date}]* ${sender}:\n_${preview}_`;
        }).join('\n\n');
        await safeSend(chatId, `📋 *Last 10 exchanges:*\n\n${logText}`);
        return res.status(200).send('OK');
      }

      if (text === '/clearlog') {
        await redis.del(RAW_LOG_KEY);
        await bot.sendMessage(chatId, '🗑️ Raw log cleared.');
        return res.status(200).send('OK');
      }

      if (text === '/rebuildmemory') {
        const entries = await redis.lrange(RAW_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
        if (entries.length === 0) {
          await bot.sendMessage(chatId, '⚠️ No log entries to rebuild from.');
          return res.status(200).send('OK');
        }
        await bot.sendMessage(chatId, `🔄 Rebuilding memory from ${entries.length} log entries... I'll let you know when it's done.`);
        res.status(200).send('OK');

        const logText = entries.reverse().map(e => {
          const { ts, sender, msg, reply } = JSON.parse(e);
          return `[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 150)}" → Remy: "${reply.slice(0, 150)}"`;
        }).join('\n');

        generateText({
          model: zhipu('glm-4.7'),
          prompt: `Rebuild Remy's structured long-term memory from scratch using the conversation log below.

CONVERSATION LOG:
${logText}

Use EXACTLY this structure and add [YYYY-MM-DD] timestamps to all entries:
${EMPTY_MEMORY}

Rules:
- Add every meaningful fact, preference, person, project, or event
- Use [YYYY-MM-DD] timestamps on every bullet point
- Keep each entry concise — one fact per bullet
- Leave empty sections blank, do not remove them
- Return ONLY the structured memory, no extra commentary`,
        }).then(({ text: newMemory }) => {
          redis.set(MEMORY_KEY, newMemory);
          bot.sendMessage(chatId, '✅ Memory rebuilt. Use /memory to review.');
        }).catch(err => {
          console.error('Rebuild failed:', err);
          bot.sendMessage(chatId, '❌ Rebuild failed. Check logs.');
        });
        return;
      }

      if (text === '/help') {
        await bot.sendMessage(chatId,
          `*Remy commands:*\n\n` +
          `*Access management*\n` +
          `\`/allow <id>\` — grant group access\n` +
          `\`/remove <id>\` or \`/revoke <id>\` — revoke access\n` +
          `\`/status\` or \`/list\` — approved users & active groups\n\n` +
          `*Memory*\n` +
          `\`/memory\` — view full structured memory\n` +
          `\`/clearmemory\` — wipe memory\n` +
          `\`/rebuildmemory\` — rebuild memory from raw log\n\n` +
          `*History & Log*\n` +
          `\`/clearhistory\` — clear this chat's conversation history\n` +
          `\`/log\` — view last 10 raw log entries\n` +
          `\`/clearlog\` — wipe raw log`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      // Catch any other unrecognised slash command — don't pass to AI
      if (text.startsWith('/')) {
        await bot.sendMessage(chatId, `❓ Unknown command. Type /help to see all available commands.`);
        return res.status(200).send('OK');
      }
    }

    // In groups, ignore slash commands from non-boss users
    if (!isPrivate && text.startsWith('/')) return res.status(200).send('OK');

    // Track Boss presence in groups
    if (isBoss && !isPrivate) {
      redis.set(`${BOSS_GRP_PREFIX}${chatId}`, '1').catch(() => {});
    }

    // Only respond when mentioned, called by name, or Boss DM
    if (!isPrivate && !text.includes(BOT_USERNAME) && !/\bremy\b/i.test(text)) {
      return res.status(200).send('OK');
    }

    // ── Generate response ────────────────────────────────────────────────────
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      await bot.sendChatAction(chatId, 'typing');
      const cleanPrompt = text.replace(BOT_USERNAME, '').trim() || 'Hello!';
      const today = new Date().toISOString().split('T')[0];

      // Fetch memory + history in parallel
      const [memory, rawHistory] = await Promise.all([
        redis.get(MEMORY_KEY),
        redis.lrange(`${HIST_PREFIX}${chatId}`, 0, MAX_HIST_MSGS - 1)
      ]);

      const history = rawHistory.map(e => JSON.parse(e)).reverse();

      const systemPrompt = isBoss
        ? `You are Remy — a highly capable, loyal personal AI built exclusively for ${BOSS_NAME}, your Boss and creator.

You are currently speaking with ${BOSS_NAME}${BOSS_ALIASES ? ` (also known as ${BOSS_ALIASES})` : ''}.

You are not a generic chatbot. You are ${BOSS_NAME}'s private assistant: sharp, direct, and genuinely useful. You have a confident personality — you give real answers, not hedged non-answers. You match your tone to the moment: analytical when ${BOSS_NAME} needs clarity, casual when the conversation calls for it, and always honest even when the truth is uncomfortable.

Your capabilities are broad: research, writing, coding, planning, brainstorming, problem-solving, financial thinking, creative work, and beyond. Whatever ${BOSS_NAME} needs, you handle it with precision.

--- MEMORY ---
${memory || EMPTY_MEMORY}
--- END MEMORY ---

Use your memory naturally. Reference timestamps when relevant (e.g. "as of [date]..."). Never make ${BOSS_NAME} repeat himself.
Use Markdown formatting where it improves clarity — **bold** for emphasis, bullet points for lists, \`code\` for code.
Never sign off your messages or add any closing signature. Just reply directly.`
        : `You are Remy — a sharp, capable AI assistant created by ${BOSS_NAME}. You are currently speaking with ${senderName}. ${senderName} is a guest, not the Boss.

Be helpful, direct, and friendly. You can assist with questions, tasks, ideas, and conversation. Never be vague or overly cautious.

--- MEMORY ---
${memory || EMPTY_MEMORY}
--- END MEMORY ---

You may reference things ${senderName} has personally shared with you. Never reveal anything about ${BOSS_NAME} — his life, conversations, or private details. Politely deflect if asked.
Use Markdown formatting where it improves clarity.
Never sign off your messages or add any closing signature. Just reply directly.`;

      let aiResponse;
      try {
        const result = await generateText({
          model: zhipu('glm-4.7'),
          system: systemPrompt,
          messages: [
            ...history,
            { role: 'user', content: cleanPrompt }
          ],
        });
        aiResponse = result.text;
      } catch (aiErr) {
        console.error('AI generation failed:', aiErr);
        await bot.sendMessage(chatId, '⚠️ My brain glitched for a sec. Try again.');
        return res.status(200).send('OK');
      }

      await safeSend(chatId, aiResponse);

      // Return to Telegram immediately
      res.status(200).send('OK');

      // ── Background: update history, memory, and raw log ──────────────────
      const histKey  = `${HIST_PREFIX}${chatId}`;
      const logEntry = JSON.stringify({
        ts: new Date().toISOString(),
        sender: senderName,
        isBoss,
        chat: isPrivate ? 'private' : 'group',
        msg: cleanPrompt.slice(0, 200),
        reply: aiResponse.slice(0, 200),
      });

      const backgroundTasks = [
        // Conversation history
        redis.lpush(histKey,
          JSON.stringify({ role: 'user', content: cleanPrompt }),
          JSON.stringify({ role: 'assistant', content: aiResponse })
        ).then(() => redis.ltrim(histKey, 0, MAX_HIST_MSGS - 1)),

        // Append-only raw log
        redis.lpush(RAW_LOG_KEY, logEntry)
          .then(() => redis.ltrim(RAW_LOG_KEY, 0, MAX_LOG_ENTRIES - 1)),
      ];

      // Only burn an LLM call on memory if the message is substantial
      if (cleanPrompt.length >= MIN_MEMORY_LEN) {
        backgroundTasks.push(
          redis.incr('remy_exchange_count').then(async (count) => {
            const shouldRebuild = count % 20 === 0;

            if (shouldRebuild) {
              // Full recompression from raw log every 20 exchanges
              const recentLog = await redis.lrange(RAW_LOG_KEY, 0, 49);
              const logText = recentLog.reverse().map(e => {
                const { ts, sender, msg, reply } = JSON.parse(e);
                return `[${ts.split('T')[0]}] ${sender}: "${msg}" → Remy: "${reply}"`;
              }).join('\n');

              const { text: rebuiltMemory } = await generateText({
                model: zhipu('glm-4.7'),
                prompt: `Rebuild Remy's structured memory by merging the current memory with recent exchanges. Fix any drift, remove duplicates, and ensure all facts are accurate and up to date.

CURRENT MEMORY:
${memory || EMPTY_MEMORY}

RECENT EXCHANGES (last 50):
${logText}

Use EXACTLY this structure with [YYYY-MM-DD] timestamps on all entries:
${EMPTY_MEMORY}

Rules:
- Preserve all valid existing entries with their original timestamps
- Integrate new information from recent exchanges
- Remove duplicates and outdated facts (mark as superseded if needed)
- One fact per bullet point, keep concise
- Return ONLY the updated memory:`,
              });
              return redis.set(MEMORY_KEY, rebuiltMemory);
            } else {
              // Incremental update every other exchange
              const { text: newMemory } = await generateText({
                model: zhipu('glm-4.7'),
                prompt: `You maintain Remy's structured long-term memory. Update ONLY the relevant sections based on the new exchange. Preserve ALL existing entries and their timestamps.

CURRENT MEMORY:
${memory || EMPTY_MEMORY}

NEW EXCHANGE [${today}]:
${senderName} said: "${cleanPrompt}"
Remy replied: "${aiResponse}"

RULES:
- Keep the exact ## and ### section structure
- Add [${today}] timestamps to ALL new entries
- NEVER delete existing timestamped entries unless directly contradicted
- If info is updated, mark old as "(superseded ${today})" and add the new entry
- One fact per bullet point — keep entries concise
- If nothing new worth remembering, return the memory exactly as-is

Return ONLY the updated memory, preserving the full structure:`,
              });
              return redis.set(MEMORY_KEY, newMemory);
            }
          })
        );
      }

      Promise.all(backgroundTasks).catch(err => console.error('Background update failed:', err));

    } finally {
      clearInterval(typingInterval);
    }

    return;

  } catch (error) {
    console.error('Bot Error:', error);
    res.status(200).send('OK');
  }
};
