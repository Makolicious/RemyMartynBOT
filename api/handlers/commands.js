const { bot, safeSend, BOSS_NAME, MAIN_MENU_KEYBOARD } = require('../lib/telegram');
const { redis, KEYS, MAX_LOG_ENTRIES } = require('../lib/redis');
const { generateText, CHAT_MODEL, UTILITY_MODEL, MEMORY_MODEL, FALLBACK_MODEL } = require('../lib/models');
const { parseReminderTime, parseCronCommand, localTimeToUTC, calculateNextFire, parseDayOfWeek, getBossTimezone } = require('../lib/time');
const { needsWebSearch } = require('../tools/search');
const { planGoalTool } = require('../tools/plan');
const memory = require('../memory');

// ── Format plan for Telegram display ─────────────────────────────────────────
function formatPlanForTelegram(plan) {
  let msg = `\u{1F4CB} *${plan.title}*\n\n`;
  plan.steps.forEach(step => {
    msg += `${step.id}. ${step.action} (${step.estimatedTime})\n`;
  });
  if (plan.notes) msg += `\n\u{1F4A1} ${plan.notes}`;
  return msg;
}

// ── Handle all boss slash commands (DM only) ─────────────────────────────────
// Returns true if a command was handled, false if the text is not a command
async function handleCommand(message, chatId, text, res) {

  // /agent plan <goal>
  if (text.startsWith('/agent plan ')) {
    const goal = text.substring('/agent plan '.length).trim();
    if (goal.length < 3) {
      await bot.sendMessage(chatId, 'Please provide a clear goal after /agent plan\nExample: /agent plan my productive week');
      return res.status(200).send('OK');
    }
    try {
      await bot.sendChatAction(chatId, 'typing');
      const result = await planGoalTool.execute({ goal });
      if (result.error) throw new Error(result.error);
      await bot.sendMessage(chatId, formatPlanForTelegram(result.plan), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Plan generation error:', error);
      await bot.sendMessage(chatId, `Sorry, I couldn't generate a plan. Error: ${error.message}`);
    }
    return res.status(200).send('OK');
  }

  // /agent help
  if (text.startsWith('/agent')) {
    await bot.sendMessage(chatId, `*Agent Commands*\n\n/agent plan <goal> - Generate a structured plan\n\nExample: /agent plan my productive week`, { parse_mode: 'Markdown' });
    return res.status(200).send('OK');
  }

  if (text === '/start') {
    await bot.sendMessage(chatId, `What's good ${BOSS_NAME} \u{1F44B}\nOnline and ready.`, { reply_markup: MAIN_MENU_KEYBOARD });
    return res.status(200).send('OK');
  }

  if (text.startsWith('/allow ')) {
    const id = text.slice(7).trim().replace(/[<>]/g, '');
    await redis.sadd(KEYS.APPROVED, id);
    await bot.sendMessage(chatId, `\u{2705} User \`${id}\` added.`, { parse_mode: 'Markdown' });
    return res.status(200).send('OK');
  }

  if (text.startsWith('/remove ') || text.startsWith('/revoke ')) {
    const id = text.split(' ').slice(1).join(' ').trim().replace(/[<>]/g, '');
    await redis.srem(KEYS.APPROVED, id);
    await bot.sendMessage(chatId, `\u{1F6AB} User \`${id}\` revoked.`, { parse_mode: 'Markdown' });
    return res.status(200).send('OK');
  }

  if (text === '/status' || text === '/list') {
    const [users, groupKeys] = await Promise.all([
      redis.smembers(KEYS.APPROVED),
      redis.keys('boss_group_*'),
    ]);
    const userList  = users.length     ? users.map(u => `\u{2022} \`${u}\``).join('\n') : '_None_';
    const groupList = groupKeys.length ? groupKeys.map(k => `\u{2022} \`${k.replace('boss_group_', '')}\``).join('\n') : '_None_';
    await bot.sendMessage(chatId, `\u{1F465} *Approved:*\n${userList}\n\n\u{1F4CD} *Active groups:*\n${groupList}`, { parse_mode: 'Markdown' });
    return res.status(200).send('OK');
  }

  if (text === '/memory') {
    const markdown = await memory.exportAsMarkdown();
    await safeSend(chatId, markdown ? `\u{1F9E0} *Memory:*\n\n${markdown}` : '\u{1F9E0} No memory yet. Talk to me and I\'ll remember.');
    return res.status(200).send('OK');
  }

  if (text === '/clearhistory') {
    await redis.del(KEYS.HISTORY(chatId));
    await bot.sendMessage(chatId, '\u{1F5D1}\u{FE0F} History cleared for this chat.');
    return res.status(200).send('OK');
  }

  if (text === '/log') {
    const entries = await redis.lrange(KEYS.RAW_LOG, 0, 9);
    if (!entries.length) {
      await bot.sendMessage(chatId, '\u{1F4CB} No log entries yet.');
      return res.status(200).send('OK');
    }
    const logText = entries.flatMap(e => {
      try {
        const { ts, sender, msg } = JSON.parse(e);
        const date    = new Date(ts).toLocaleString();
        const preview = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
        return [`*[${date}]* ${sender}:\n_${preview}_`];
      } catch { return []; }
    }).join('\n\n');
    await safeSend(chatId, `\u{1F4CB} *Last 10 exchanges:*\n\n${logText}`);
    return res.status(200).send('OK');
  }

  if (text === '/clearlog') {
    await redis.del(KEYS.RAW_LOG);
    await bot.sendMessage(chatId, '\u{1F5D1}\u{FE0F} Log cleared.');
    return res.status(200).send('OK');
  }

  if (text === '/rebuildmemory') {
    const entries = await redis.lrange(KEYS.RAW_LOG, 0, 49);
    if (!entries.length) {
      await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} Nothing to rebuild from.');
      return res.status(200).send('OK');
    }
    await bot.sendMessage(chatId, `\u{1F504} Rebuilding memory from ${entries.length} entries...`);
    try {
      const logText = entries.reverse().flatMap(e => {
        try {
          const { ts, sender, msg, reply } = JSON.parse(e);
          return [`[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 120)}" \u{2192} Remy: "${reply.slice(0, 120)}"`];
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
      await bot.sendMessage(chatId, `\u{2705} Memory rebuilt: ${added} new facts, ${boosted} existing boosted. Use /memstats to review.`);
    } catch (err) {
      console.error('Rebuild failed:', err);
      await bot.sendMessage(chatId, '\u{274C} Rebuild failed. Check logs.');
    }
    return res.status(200).send('OK');
  }

  // /pin <content> — save permanent memory, auto-categorized
  if (text.startsWith('/pin ')) {
    const pinContent = text.slice(5).trim();
    if (!pinContent || pinContent.length < 5) {
      await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} Usage: `/pin Smith job address is 4521 NW 7th St`', { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const lower = pinContent.toLowerCase();
    let category = 'personal_preferences';
    if (/\b(job|project|site|contract|client|permit|inspection|wire|panel|conduit)\b/i.test(lower)) category = 'work_projects';
    else if (/\b(address|phone|email|number|contact)\b/i.test(lower)) category = 'contacts';
    else if (/\b(kid|child|son|daughter|wife|family|school|pickup)\b/i.test(lower)) category = 'family_relationships';
    else if (/\b(password|login|account|pin code|ssn|license)\b/i.test(lower)) category = 'sensitive_personal';
    try {
      await memory.addMemory(pinContent, category, 95, true);
      await bot.sendMessage(chatId, `\u{1F4CC} *Pinned* (${category}): "${pinContent.slice(0, 80)}"`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `\u{274C} Pin failed: ${err.message}`);
    }
    return res.status(200).send('OK');
  }

  // /memadd <content> <category>
  if (text.startsWith('/memadd ')) {
    const args = text.slice(8).trim();
    const lastSpace = args.lastIndexOf(' ');
    if (lastSpace === -1) {
      await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} Usage: `/memadd <content> <category>`\n\nCategories: ' + memory.CATEGORIES.slice(0, 5).join(', ') + '...', { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const content = args.slice(0, lastSpace);
    const category = args.slice(lastSpace + 1);
    try {
      await memory.addMemory(content, category);
      await bot.sendMessage(chatId, `\u{2705} Memory added to *${category}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `\u{274C} Error: ${err.message}`);
    }
    return res.status(200).send('OK');
  }

  // /memcat <category>
  if (text.startsWith('/memcat ')) {
    const category = text.slice(8).trim();
    const memories = await memory.getMemoriesByCategory(category, 10);
    if (memories.length === 0) {
      await bot.sendMessage(chatId, `\u{1F4C2} No memories in *${category}*`, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const output = memories.map(m =>
      `\u{2022} ${m.content}\n  _Importance: ${m.importance.toFixed(0)} | Confidence: ${m.confidence}_`
    ).join('\n\n');
    await safeSend(chatId, `\u{1F4C2} *${category}* (${memories.length}):\n\n${output}`);
    return res.status(200).send('OK');
  }

  // /memsearch <query>
  if (text.startsWith('/memsearch ')) {
    const query = text.slice(11).trim();
    const results = await memory.searchMemories(query, 10);
    if (results.length === 0) {
      await bot.sendMessage(chatId, `\u{1F50D} No results for "${query}"`);
      return res.status(200).send('OK');
    }
    const output = results.map(m =>
      `\u{2022} [${m.category}] ${m.content}\n  _Importance: ${m.importance.toFixed(0)}_`
    ).join('\n\n');
    await safeSend(chatId, `\u{1F50D} *${results.length} results* for "${query}":\n\n${output}`);
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
      `\u{1F4CA} *Memory Stats*\n\n` +
      `\u{1F9E0} Total memories: *${stats.totalMemories}*\n` +
      `\u{1F525} Hot (recently accessed): *${stats.hotMemories}*\n` +
      `\u{1F4DD} Total accesses: *${stats.total_accesses || 0}*\n\n` +
      `\u{1F4C2} Top categories:\n${topCats.map(([cat, count]) => `\u{2022} ${cat}: ${count}`).join('\n')}`,
      { parse_mode: 'Markdown' }
    );
    return res.status(200).send('OK');
  }

  // /backfill
  if (text === '/backfill') {
    await bot.sendMessage(chatId, '\u{23F3} Generating embeddings for existing memories...');
    const result = await memory.backfillEmbeddings();
    await bot.sendMessage(chatId,
      `\u{2705} Embedding backfill complete:\n\u{2022} Embedded: *${result.embedded}*\n\u{2022} Failed: *${result.failed}*\n\u{2022} Already had embeddings: *${result.skipped}*`,
      { parse_mode: 'Markdown' }
    );
    return res.status(200).send('OK');
  }

  // /memdecay
  if (text === '/memdecay') {
    await bot.sendMessage(chatId, '\u{23F3} Applying time decay...');
    const result = await memory.applyDecay();
    await bot.sendMessage(chatId, `\u{2705} Decay applied to *${result.decayed}* memories (${result.daysPassed} day(s))`, { parse_mode: 'Markdown' });
    return res.status(200).send('OK');
  }

  // /memexport
  if (text === '/memexport') {
    await bot.sendMessage(chatId, '\u{23F3} Exporting memory...');
    const markdown = await memory.exportAsMarkdown();
    await safeSend(chatId, `\u{1F4CB} *Memory Export:*\n\n${markdown}`);
    return res.status(200).send('OK');
  }

  // /stats
  if (text === '/stats') {
    const [logLen, memStr, approvedCount, exchangeCount, remindersLen] = await Promise.all([
      redis.llen(KEYS.RAW_LOG), redis.get(KEYS.MEMORY), redis.scard(KEYS.APPROVED),
      redis.get(KEYS.EXCHANGE_COUNT), redis.zcard(KEYS.REMINDERS),
    ]);
    const memKB = memStr ? (memStr.length / 1024).toFixed(1) : 0;
    await bot.sendMessage(chatId,
      `\u{1F4CA} *Remy Stats*\n\n` +
      `\u{1F4AC} Total exchanges: *${exchangeCount || 0}*\n` +
      `\u{1F4CB} Log entries: *${logLen}*\n` +
      `\u{1F9E0} Memory size: *${memKB} KB*\n` +
      `\u{23F0} Pending reminders: *${remindersLen}*\n` +
      `\u{1F465} Approved users: *${approvedCount}*`,
      { parse_mode: 'Markdown' }
    );
    return res.status(200).send('OK');
  }

  // /summarize [n]
  if (text.startsWith('/summarize')) {
    const n = Math.min(parseInt(text.split(' ')[1]) || 20, 50);
    const entries = await redis.lrange(KEYS.RAW_LOG, 0, n - 1);
    if (!entries.length) {
      await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} No conversation history to summarize.');
      return res.status(200).send('OK');
    }
    await bot.sendMessage(chatId, `\u{1F504} Summarizing last ${entries.length} exchanges...`);
    try {
      const logText = entries.reverse().flatMap(e => {
        try {
          const { ts, sender, msg, reply } = JSON.parse(e);
          return [`[${ts.split('T')[0]}] ${sender}: "${msg.slice(0, 120)}" \u{2192} Remy: "${reply.slice(0, 120)}"`];
        } catch { return []; }
      }).join('\n');
      const { text: summary } = await generateText({
        model: FALLBACK_MODEL || CHAT_MODEL,
        prompt: `Summarize these conversation exchanges concisely. Key topics, decisions, and important points only:\n\n${logText}`,
      });
      await safeSend(chatId, `\u{1F4CB} *Summary (last ${entries.length} exchanges):*\n\n${summary}`);
    } catch (err) {
      console.error('[SUMMARIZE] Failed:', err.message);
      await bot.sendMessage(chatId, '\u{274C} Summary failed. Try again.');
    }
    return res.status(200).send('OK');
  }

  // /remind — supports many time formats
  if (text.startsWith('/remind ')) {
    const input  = text.slice(8).trim();
    const remindTz = await getBossTimezone(redis, KEYS.TIMEZONE);
    const parsed = parseReminderTime(input, remindTz);
    if (!parsed) {
      await bot.sendMessage(chatId,
        `\u{26A0}\u{FE0F} Formats:\n\`/remind in 2h to call John\`\n\`/remind tomorrow at 9am check permits\`\n\`/remind friday at 3pm pick up materials\`\n\`/remind at 5pm call inspector\``,
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }
    await redis.zadd(KEYS.REMINDERS, parsed.ts, JSON.stringify({ chatId, message: parsed.message, id: Date.now() }));
    const tz = await getBossTimezone(redis, KEYS.TIMEZONE);
    const timeStr = new Date(parsed.ts).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
    await bot.sendMessage(chatId, `\u{23F0} Reminder set for *${timeStr}*: "${parsed.message}"`, { parse_mode: 'Markdown' });
    return res.status(200).send('OK');
  }

  // /reminders or /schedules
  if (text === '/reminders' || text === '/schedules') {
    const tz = await getBossTimezone(redis, KEYS.TIMEZONE);
    const sections = [];

    const oneTime = await redis.zrangebyscore(KEYS.REMINDERS, Date.now(), '+inf', 'WITHSCORES');
    if (oneTime.length) {
      const lines = [];
      for (let i = 0; i < oneTime.length; i += 2) {
        try {
          const { message: msg } = JSON.parse(oneTime[i]);
          const timeStr = new Date(parseInt(oneTime[i + 1])).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
          lines.push(`${lines.length + 1}. \u{23F0} [${timeStr}] ${msg}`);
        } catch {}
      }
      if (lines.length) sections.push(`*One-Time Reminders:*\n${lines.join('\n')}`);
    }

    const cronAll = await redis.zrangebyscore(KEYS.CRON_JOBS, 0, '+inf', 'WITHSCORES');
    if (cronAll.length) {
      const lines = [];
      for (let i = 0; i < cronAll.length; i += 2) {
        const job = await redis.hgetall(KEYS.CRON_ENTRY(cronAll[i]));
        if (!job || !job.message) continue;
        const status = job.enabled === 'false' ? '\u{23F8}\u{FE0F}' : '\u{2705}';
        const nextStr = new Date(parseInt(cronAll[i + 1])).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
        lines.push(`${lines.length + 1}. ${status} *${job.repeat || 'daily'}* \u{2014} "${job.message}"\n   Next: ${nextStr} | Fired: ${job.fireCount || 0}x`);
      }
      if (lines.length) sections.push(`*Recurring Tasks:*\n${lines.join('\n')}`);
    }

    if (!sections.length) {
      await bot.sendMessage(chatId, '\u{1F4C5} No reminders or scheduled tasks.');
    } else {
      await safeSend(chatId, `\u{1F4C5} *All Scheduled Items:*\n\n${sections.join('\n\n')}`);
    }
    return res.status(200).send('OK');
  }

  // /deletereminder <n>
  if (text.startsWith('/deletereminder')) {
    const n = parseInt(text.slice(15).trim());
    if (isNaN(n) || n < 1) {
      await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} Usage: `/deletereminder <number>` \u{2014} use `/reminders` to see numbers.', { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const all = await redis.zrangebyscore(KEYS.REMINDERS, Date.now(), '+inf', 'WITHSCORES');
    const totalReminders = Math.floor(all.length / 2);
    if (n > totalReminders) {
      await bot.sendMessage(chatId, `\u{26A0}\u{FE0F} Only ${totalReminders} reminder(s) pending.`);
      return res.status(200).send('OK');
    }
    const target = all[(n - 1) * 2];
    await redis.zrem(KEYS.REMINDERS, target);
    try {
      const { message: msg } = JSON.parse(target);
      await bot.sendMessage(chatId, `\u{1F5D1}\u{FE0F} Deleted reminder ${n}: "${msg.slice(0, 80)}"`);
    } catch {
      await bot.sendMessage(chatId, `\u{1F5D1}\u{FE0F} Deleted reminder ${n}.`);
    }
    return res.status(200).send('OK');
  }

  // /schedule <repeat> [day] <time> <message>
  if (text.startsWith('/schedule ')) {
    const args = text.slice(10).trim();
    const parsed = parseCronCommand(args);
    if (!parsed) {
      await bot.sendMessage(chatId,
        `\u{26A0}\u{FE0F} *Schedule format:*\n` +
        `\`/schedule daily 09:00 Morning news\`\n` +
        `\`/schedule weekdays 08:30 Check emails\`\n` +
        `\`/schedule weekly mon 10:00 Weekly review\`\n` +
        `\`/schedule monthly 1 09:00 Monthly report\``,
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }

    const schedTz = await getBossTimezone(redis, KEYS.TIMEZONE);
    const schedTimeUTC = localTimeToUTC(parsed.time, schedTz);
    const jobId = `cj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nextFire = calculateNextFire(schedTimeUTC, parsed.repeat, parsed.dayOfWeek, parsed.dayOfMonth);
    const isTask = needsWebSearch(parsed.message) || /\b(send|get|fetch|summary|summarize|remind|tell|show|check|report|news|weather|briefing)\b/i.test(parsed.message);

    await redis.hset(KEYS.CRON_ENTRY(jobId),
      'message', parsed.message, 'repeat', parsed.repeat, 'time', schedTimeUTC,
      'dayOfWeek', String(parsed.dayOfWeek ?? ''), 'dayOfMonth', String(parsed.dayOfMonth ?? ''),
      'chatId', String(chatId), 'enabled', 'true', 'fireCount', '0',
      'jobType', isTask ? 'ai_task' : 'message', 'createdAt', new Date().toISOString(),
    );
    await redis.zadd(KEYS.CRON_JOBS, nextFire, jobId);

    const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: schedTz, dateStyle: 'medium', timeStyle: 'short' });
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayLabel = parsed.repeat === 'weekly' ? ` (${dayNames[parsed.dayOfWeek]}s)` :
                     parsed.repeat === 'monthly' ? ` (${parsed.dayOfMonth}th of month)` : '';
    await bot.sendMessage(chatId,
      `\u{2705} *Scheduled:* "${parsed.message}"\n\u{1F4C5} ${parsed.repeat}${dayLabel} at \`${parsed.time}\`\n\u{1F514} First run: ${nextStr}`,
      { parse_mode: 'Markdown' }
    );
    return res.status(200).send('OK');
  }

  // /editschedule <n> <repeat> [day] <time> <message>
  if (text.startsWith('/editschedule ')) {
    const parts = text.slice(14).trim().split(/\s+/);
    const n = parseInt(parts[0]);
    if (isNaN(n) || n < 1) {
      await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} Usage: `/editschedule <number> daily 09:00 New task` \u{2014} use `/schedules` to see numbers.', { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const newSpec = parseCronCommand(parts.slice(1).join(' '));
    if (!newSpec) {
      await bot.sendMessage(chatId,
        `\u{26A0}\u{FE0F} *Edit format:*\n` +
        `\`/editschedule 1 daily 09:00 New task description\`\n` +
        `\`/editschedule 2 weekdays 08:30 Check emails\`\n` +
        `\`/editschedule 3 weekly mon 10:00 Weekly review\``,
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }
    const all = await redis.zrangebyscore(KEYS.CRON_JOBS, 0, '+inf', 'WITHSCORES');
    const totalJobs = Math.floor(all.length / 2);
    if (n > totalJobs) {
      await bot.sendMessage(chatId, `\u{26A0}\u{FE0F} Only ${totalJobs} scheduled job(s). Use \`/schedules\` to see the list.`, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const jobId = all[(n - 1) * 2];
    const editTz = await getBossTimezone(redis, KEYS.TIMEZONE);
    const editTimeUTC = localTimeToUTC(newSpec.time, editTz);
    const isTask = needsWebSearch(newSpec.message) || /\b(send|get|fetch|summary|summarize|tell|show|check|report|news|weather|briefing)\b/i.test(newSpec.message);
    const nextFire = calculateNextFire(editTimeUTC, newSpec.repeat, newSpec.dayOfWeek, newSpec.dayOfMonth);

    await redis.hset(KEYS.CRON_ENTRY(jobId),
      'message', newSpec.message, 'repeat', newSpec.repeat, 'time', editTimeUTC,
      'dayOfWeek', String(newSpec.dayOfWeek ?? ''), 'dayOfMonth', String(newSpec.dayOfMonth ?? ''),
      'jobType', isTask ? 'ai_task' : 'message',
    );
    await redis.zadd(KEYS.CRON_JOBS, nextFire, jobId);

    const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: editTz, dateStyle: 'medium', timeStyle: 'short' });
    await bot.sendMessage(chatId,
      `\u{2705} *Schedule ${n} updated:* "${newSpec.message}"\n\u{1F4C5} ${newSpec.repeat} at \`${newSpec.time}\` \u{2014} next run: ${nextStr}`,
      { parse_mode: 'Markdown' }
    );
    return res.status(200).send('OK');
  }

  // /deleteschedule <n>
  if (text.startsWith('/deleteschedule')) {
    const n = parseInt(text.slice(15).trim());
    if (isNaN(n) || n < 1) {
      await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} Usage: `/deleteschedule <number>` \u{2014} use `/schedules` to see the list.', { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const all = await redis.zrangebyscore(KEYS.CRON_JOBS, 0, '+inf', 'WITHSCORES');
    const totalJobs = Math.floor(all.length / 2);
    if (n > totalJobs) {
      await bot.sendMessage(chatId, `\u{26A0}\u{FE0F} Only ${totalJobs} scheduled job(s). Use \`/schedules\` to see the list.`, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const jobId = all[(n - 1) * 2];
    const job = await redis.hgetall(KEYS.CRON_ENTRY(jobId));
    await redis.del(KEYS.CRON_ENTRY(jobId));
    await redis.zrem(KEYS.CRON_JOBS, jobId);
    const label = job?.message?.slice(0, 60) || jobId;
    await bot.sendMessage(chatId, `\u{1F5D1}\u{FE0F} Deleted schedule ${n}: "${label}"`);
    return res.status(200).send('OK');
  }

  // /timezone [tz]
  if (text.startsWith('/timezone')) {
    const tz = text.slice(9).trim();
    if (!tz) {
      const current = await getBossTimezone(redis, KEYS.TIMEZONE);
      const now = new Date().toLocaleString('en-US', { timeZone: current, dateStyle: 'full', timeStyle: 'short' });
      await bot.sendMessage(chatId, `\u{1F30D} Current timezone: \`${current}\`\nLocal time: *${now}*\n\nTo change: \`/timezone America/New_York\``, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    try {
      new Date().toLocaleString('en-US', { timeZone: tz });
    } catch {
      await bot.sendMessage(chatId, `\u{274C} Invalid timezone: \`${tz}\`\n\nExamples: \`America/New_York\`, \`Europe/London\`, \`Asia/Singapore\`, \`America/Sao_Paulo\``, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    await redis.set(KEYS.TIMEZONE, tz);
    const now = new Date().toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
    await bot.sendMessage(chatId, `\u{2705} Timezone set to \`${tz}\`\nYour local time: *${now}*`, { parse_mode: 'Markdown' });
    return res.status(200).send('OK');
  }

  // /reflect — view latest nightly reflection (or trigger one)
  if (text === '/reflect' || text === '/reflect force') {
    const force = text.endsWith('force');
    if (force) {
      await bot.sendMessage(chatId, '\u{1F504} Generating fresh reflection...');
      // Trigger reflection endpoint directly by requiring it
      try {
        const reflectHandler = require('../reflect');
        await new Promise((resolve) => {
          const fakeReq = { query: { force: 'true' } };
          const fakeRes = {
            status: () => fakeRes,
            json: (body) => { fakeRes._body = body; resolve(body); return fakeRes; },
            send: () => resolve(),
          };
          reflectHandler(fakeReq, fakeRes).catch(resolve);
        });
      } catch (err) {
        await bot.sendMessage(chatId, `\u{274C} Reflection trigger failed: ${err.message}`);
        return res.status(200).send('OK');
      }
    }
    const latest = await redis.zrevrange('remy_reflections', 0, 0);
    if (!latest.length) {
      await bot.sendMessage(chatId, '\u{1F4AD} No reflections yet. They generate nightly; run `/reflect force` to create one now.', { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    try {
      const r = JSON.parse(latest[0]);
      const parts = [`\u{1F4AD} *Reflection \u{2014} ${r.date}*\n`];
      if (r.summary) parts.push(`_${r.summary}_\n`);
      if (r.mood) parts.push(`*Mood:* ${r.mood}`);
      if (r.themes?.length) parts.push(`*Themes:*\n${r.themes.map(t => `\u{2022} ${t}`).join('\n')}`);
      if (r.key_facts?.length) parts.push(`*Key facts:*\n${r.key_facts.map(f => `\u{2022} ${f}`).join('\n')}`);
      if (r.open_loops?.length) parts.push(`*Open loops:*\n${r.open_loops.map(l => `\u{2022} ${l}`).join('\n')}`);
      await safeSend(chatId, parts.join('\n\n'));
    } catch (err) {
      await bot.sendMessage(chatId, `\u{26A0}\u{FE0F} Reflection corrupted: ${err.message}`);
    }
    return res.status(200).send('OK');
  }

  // /debug — show last turn's trace (model, tools, cache, timings)
  if (text === '/debug') {
    const raw = await redis.get(KEYS.DEBUG_LAST(chatId));
    if (!raw) {
      await bot.sendMessage(chatId, '\u{1F50D} No debug trace yet \u{2014} send a message first.');
      return res.status(200).send('OK');
    }
    let t;
    try { t = JSON.parse(raw); } catch { t = null; }
    if (!t) {
      await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} Debug trace corrupted.');
      return res.status(200).send('OK');
    }
    const cacheLine = t.cacheReadTokens > 0
      ? `\u{1F7E2} Cache HIT: ${t.cacheReadTokens} read${t.cacheCreateTokens ? `, ${t.cacheCreateTokens} created` : ''}`
      : t.cacheCreateTokens > 0
        ? `\u{1F7E1} Cache MISS: ${t.cacheCreateTokens} created (next turn should hit)`
        : '\u{26AA} Cache: N/A (fallback or non-Anthropic)';
    const toolsLine = t.toolCalls && t.toolCalls.length
      ? t.toolCalls.join(', ')
      : '_none_';
    const out =
      `\u{1F527} *Last Turn Trace*\n\n` +
      `\u{1F550} ${new Date(t.ts).toLocaleString()}\n` +
      `\u{1F9E0} Model: *${t.model || 'n/a'}*${t.usedFallback ? ' _(fallback)_' : ''}\n` +
      `\u{23F1}\u{FE0F} Duration: *${t.durationMs}ms*\n` +
      `\u{1F4CF} Steps: *${t.steps}* | Prompt: ${t.promptChars}c | History: ${t.historyLen}\n` +
      `${cacheLine}\n` +
      `\u{1F9EC} Memory in context: *${t.memoryChars}c*\n` +
      `\u{1F310} Web search: ${t.webSearch ? '\u{2705}' : '\u{274C}'}  |  Visual: ${t.visual || 'none'}\n` +
      `\u{1F6E0}\u{FE0F} Tools called: ${toolsLine}` +
      (t.error ? `\n\n\u{26A0}\u{FE0F} Error: ${t.error}` : '');
    await bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
    return res.status(200).send('OK');
  }

  // /help
  if (text === '/help') {
    await safeSend(chatId,
      `*Remy commands:*\n\n` +
      `*Access*\n` +
      `\`/allow <id>\` \u{2014} grant group access\n` +
      `\`/remove <id>\` or \`/revoke <id>\` \u{2014} revoke\n` +
      `\`/status\` or \`/list\` \u{2014} approved users & groups\n\n` +
      `*Memory*\n` +
      `\`/memory\` \u{2014} view all memories\n` +
      `\`/memadd <content> <category>\` \u{2014} add memory\n` +
      `\`/memcat <category>\` \u{2014} view memories by category\n` +
      `\`/memsearch <query>\` \u{2014} search all memories\n` +
      `\`/memstats\` \u{2014} view memory statistics\n` +
      `\`/memdecay\` \u{2014} apply time decay\n` +
      `\`/memexport\` \u{2014} export as markdown\n` +
      `\`/rebuildmemory\` \u{2014} rebuild memory from log\n` +
      `\`/backfill\` \u{2014} generate embeddings for existing memories\n\n` +
      `*Agent*\n` +
      `\`/agent plan <goal>\` \u{2014} generate structured plan\n` +
      `\`/agent help\` \u{2014} agent commands\n\n` +
      `*Reminders*\n` +
      `\`/remind in 2h to <task>\` \u{2014} set reminder\n` +
      `\`/reminders\` \u{2014} view pending reminders\n` +
      `\`/deletereminder <number>\` \u{2014} delete a reminder\n\n` +
      `*Scheduler* (recurring jobs)\n` +
      `\`/schedule daily 09:00 <task>\` \u{2014} daily job\n` +
      `\`/schedule weekdays 08:30 <task>\` \u{2014} weekdays only\n` +
      `\`/schedule weekly mon 10:00 <task>\` \u{2014} weekly\n` +
      `\`/schedule monthly 1 09:00 <task>\` \u{2014} monthly\n` +
      `\`/schedules\` \u{2014} list all scheduled jobs\n` +
      `\`/editschedule <n> daily 09:00 <task>\` \u{2014} edit a job\n` +
      `\`/deleteschedule <number>\` \u{2014} delete a job\n\n` +
      `*History & Log*\n` +
      `\`/clearhistory\` \u{2014} clear this chat's history\n` +
      `\`/log\` \u{2014} last 10 log entries\n` +
      `\`/clearlog\` \u{2014} wipe log\n` +
      `\`/summarize [n]\` \u{2014} summarize last n exchanges\n\n` +
      `*Info*\n` +
      `\`/stats\` \u{2014} usage stats\n` +
      `\`/debug\` \u{2014} inspect last turn (model, tools, cache, timings)\n` +
      `\`/reflect\` \u{2014} view latest nightly reflection (\`/reflect force\` to regenerate)\n` +
      `\`/timezone <tz>\` \u{2014} set your timezone (e.g. America/New_York)\n` +
      `\`/timezone\` \u{2014} view current timezone\n\n` +
      `*Training*\n` +
      `\`/exportdata\` \u{2014} export conversation log as fine-tuning JSONL`
    );
    await bot.sendMessage(chatId, 'Or just tap:', { reply_markup: MAIN_MENU_KEYBOARD });
    return res.status(200).send('OK');
  }

  // /exportdata
  if (text === '/exportdata') {
    await bot.sendMessage(chatId, '\u{23F3} Pulling log from Redis and generating training file...');
    try {
      const entries = await redis.lrange(KEYS.RAW_LOG, 0, 4999);
      if (!entries.length) {
        await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} No log entries found.');
        return res.status(200).send('OK');
      }
      const REMY_SYSTEM = `You are Remy \u{2014} ${BOSS_NAME}'s personal AI agent. Sharp, loyal, direct, occasionally dry. You handle research, strategy, writing, code, planning, and anything else the Boss needs. You serve ${BOSS_NAME} and no one else. Never sign off. Never break character.`;
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
        caption: `\u{2705} *Training data ready*\n\n\u{1F4CA} Examples: *${lines.length}* (skipped: ${skipped})\n\u{1F522} Est. tokens: *${estTokens.toLocaleString()}*\n\u{1F4B0} Est. LoRA cost: *~$${estCost}*\n\n*Next:* Upload this file to https://api.together.ai/fine-tuning\nBase model: \`meta-llama/Llama-3.2-3B-Instruct\`\nMethod: LoRA | Epochs: 3`,
        parse_mode: 'Markdown',
      }, { filename: 'remy_training_data.jsonl', contentType: 'application/jsonl' });
    } catch (err) {
      console.error('exportdata failed:', err);
      await bot.sendMessage(chatId, `\u{274C} Export failed: ${err.message?.slice(0, 100)}`);
    }
    return res.status(200).send('OK');
  }

  // Unknown command
  await bot.sendMessage(chatId, `\u{2753} Unknown command. Type /help to see all commands.`);
  return res.status(200).send('OK');
}

module.exports = { handleCommand };
