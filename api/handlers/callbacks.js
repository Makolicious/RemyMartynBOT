const { bot, safeSend, safeEdit, BOSS_ID, BOSS_NAME, MAIN_MENU_KEYBOARD, backButton } = require('../lib/telegram');
const { redis, KEYS } = require('../lib/redis');
const { generateText, CHAT_MODEL, FALLBACK_MODEL } = require('../lib/models');
const memory = require('../memory');

async function handleCallbackQuery(query, res) {
  const chatId    = query.message.chat.id;
  const senderId  = query.from.id;
  const messageId = query.message.message_id;
  const data      = query.data;

  if (senderId !== BOSS_ID) {
    await bot.answerCallbackQuery(query.id, { text: 'Not authorized.' });
    return res.status(200).send('OK');
  }

  try {
    if (data === 'back_main') {
      await safeEdit(chatId, messageId, `What do you need, ${BOSS_NAME}?`, MAIN_MENU_KEYBOARD);
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

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

    if (data === 'menu_reminders') {
      const tz = (await redis.get(KEYS.TIMEZONE)) || process.env.BOSS_TIMEZONE || 'America/New_York';
      const sections = [];

      const oneTime = await redis.zrangebyscore(KEYS.REMINDERS, Date.now(), '+inf', 'WITHSCORES');
      if (oneTime.length) {
        const lines = [];
        for (let i = 0; i < oneTime.length; i += 2) {
          try {
            const { message: msg } = JSON.parse(oneTime[i]);
            const timeStr = new Date(parseInt(oneTime[i + 1])).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
            lines.push(`${lines.length + 1}. ⏰ [${timeStr}] ${msg}`);
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
          const status = job.enabled === 'false' ? '⏸️' : '✅';
          const nextStr = new Date(parseInt(cronAll[i + 1])).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
          lines.push(`${lines.length + 1}. ${status} ${job.repeat || 'daily'} — "${job.message}"\n   Next: ${nextStr}`);
        }
        if (lines.length) sections.push(`*Recurring Tasks:*\n${lines.join('\n')}`);
      }

      if (!sections.length) {
        await safeEdit(chatId, messageId, '📅 No reminders or scheduled tasks.', backButton());
      } else {
        await safeEdit(chatId, messageId, `📅 *All Scheduled Items:*\n\n${sections.join('\n\n')}`, backButton());
      }
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    if (data === 'menu_stats') {
      const [logLen, memStr, approvedCount, exchangeCount, remindersLen] = await Promise.all([
        redis.llen(KEYS.RAW_LOG), redis.get(KEYS.MEMORY), redis.scard(KEYS.APPROVED),
        redis.get(KEYS.EXCHANGE_COUNT), redis.zcard(KEYS.REMINDERS),
      ]);
      const memKB = memStr ? (memStr.length / 1024).toFixed(1) : 0;
      const text = `📊 *Remy Stats*\n\n` +
        `💬 Total exchanges: *${exchangeCount || 0}*\n` +
        `📋 Log entries: *${logLen}*\n` +
        `🧠 Memory size: *${memKB} KB*\n` +
        `⏰ Pending reminders: *${remindersLen}*\n` +
        `👥 Approved users: *${approvedCount}*`;
      await safeEdit(chatId, messageId, text, backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    if (data === 'menu_log') {
      const entries = await redis.lrange(KEYS.RAW_LOG, 0, 9);
      if (!entries.length) {
        await safeEdit(chatId, messageId, '📋 No log entries yet.', backButton());
      } else {
        const logText = entries.flatMap(e => {
          try {
            const { ts, sender, msg } = JSON.parse(e);
            const date = new Date(ts).toLocaleString();
            const preview = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
            return [`*[${date}]* ${sender}:\n_${preview}_`];
          } catch { return []; }
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

    if (data === 'menu_status') {
      const [users, groupKeys] = await Promise.all([
        redis.smembers(KEYS.APPROVED), redis.keys('boss_group_*'),
      ]);
      const userList  = users.length     ? users.map(u => `• \`${u}\``).join('\n') : '_None_';
      const groupList = groupKeys.length ? groupKeys.map(k => `• \`${k.replace('boss_group_', '')}\``).join('\n') : '_None_';
      await safeEdit(chatId, messageId, `👥 *Approved:*\n${userList}\n\n📍 *Active groups:*\n${groupList}`, backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    if (data === 'menu_timezone') {
      const tz = (await redis.get(KEYS.TIMEZONE)) || process.env.BOSS_TIMEZONE || 'America/New_York';
      const now = new Date().toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
      await safeEdit(chatId, messageId, `🌍 Timezone: \`${tz}\`\nLocal time: *${now}*\n\nTo change: \`/timezone America/New_York\``, backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    if (data === 'menu_summarize') {
      await bot.answerCallbackQuery(query.id, { text: 'Summarizing...' });
      const entries = await redis.lrange(KEYS.RAW_LOG, 0, 19);
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
        model: FALLBACK_MODEL || CHAT_MODEL,
        prompt: `Summarize these conversation exchanges concisely. Key topics, decisions, and important points only:\n\n${logText}`,
      });
      await safeSend(chatId, `📰 *Summary (last ${entries.length} exchanges):*\n\n${summary}`);
      return res.status(200).send('OK');
    }

    if (data === 'menu_exportdata') {
      await bot.answerCallbackQuery(query.id, { text: 'Exporting...' });
      const entries = await redis.lrange(KEYS.RAW_LOG, 0, 4999);
      if (!entries.length) {
        await safeEdit(chatId, messageId, '⚠️ No log to export.', backButton());
        return res.status(200).send('OK');
      }
      const lines = entries.reverse().flatMap(e => {
        try {
          const { msg, reply } = JSON.parse(e);
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

    if (data === 'menu_help') {
      await bot.answerCallbackQuery(query.id, { text: 'See below ↓' });
      await safeSend(chatId,
        `*Remy commands:*\n\n` +
        `*General*\n\`/start\` — wake Remy up\n\`/help\` — show commands\n\`/stats\` — usage stats\n\n` +
        `*Memory*\n\`/memory\` — view memory\n\`/clearmemory\` — wipe memory\n\`/rebuildmemory\` — rebuild from log\n\n` +
        `*Reminders*\n\`/remind in 2h to <task>\` — set reminder\n\`/reminders\` — view reminders\n\`/deletereminder <n>\` — delete a reminder\n\n` +
        `*Data*\n\`/log\` — last 10 exchanges\n\`/summarize\` — summarize recent chat\n\`/exportdata\` — export as JSONL`
      );
      return res.status(200).send('OK');
    }

    // ── Destructive confirmation flows ──
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
      const allMemIds = await redis.zrange('remy_memories_all', 0, -1);
      if (allMemIds.length > 0) {
        const pipeline = redis.pipeline();
        for (const id of allMemIds) pipeline.del(`remy_mem:${id}`);
        for (const cat of memory.CATEGORIES) pipeline.del(`remy_mem_cat:${cat}`);
        pipeline.del('remy_memories_all');
        pipeline.del('remy_mem_accessed_recent');
        pipeline.del('remy_mem_embeddings');
        pipeline.del('remy_mem_stats');
        pipeline.del('remy_mem_last_decay');
        await pipeline.exec();
      }
      await redis.del(KEYS.MEMORY);
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
      await redis.del(KEYS.HISTORY(chatId));
      await safeEdit(chatId, messageId, '🗑️ History cleared.', backButton());
      await bot.answerCallbackQuery(query.id);
      return res.status(200).send('OK');
    }

    await bot.answerCallbackQuery(query.id, { text: 'Unknown action' });
    return res.status(200).send('OK');

  } catch (err) {
    console.error('[CALLBACK] Error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Error' }).catch(() => {});
    return res.status(200).send('OK');
  }
}

module.exports = { handleCallbackQuery };
