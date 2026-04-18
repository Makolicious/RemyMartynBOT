const { bot, safeSend, BOT_USERNAME, BOSS_ID, BOSS_NAME } = require('../lib/telegram');
const { redis, KEYS, MAX_HIST_MSGS, MAX_LOG_ENTRIES, MIN_MEMORY_LEN } = require('../lib/redis');
const { generateText, CHAT_MODEL, UTILITY_MODEL, MEMORY_MODEL, pickModels } = require('../lib/models');
const { parseCronNL, parseReminderTime, localTimeToUTC, getBossTimezone } = require('../lib/time');
const { buildContextMemory, getHistory, buildSystemPrompt } = require('../middleware/context');
const { needsWebSearch, searchWebTool, imageSearch, detectVisualRequest } = require('../tools/search');
const { setReminderTool, listRemindersTool } = require('../tools/reminder');
const { createScheduleTool, editScheduleTool, deleteScheduleTool, listSchedulesTool } = require('../tools/schedule');
const { saveMemoryTool, recallMemoryTool } = require('../tools/memory-tool');
const { planGoalTool } = require('../tools/plan');
const { detectElectricalCalc, formatElectricalResult } = require('../tools/electrical');
const { handleVoiceRouting } = require('./voice');
const memory = require('../memory');

// ── Heuristics ───────────────────────────────────────────────────────────────
function isTrivialMessage(text) {
  if (text.length < 10) return true;
  return /^(ok|okay|lol|lmao|haha|yeah|yep|yup|nah|nope|no|yes|sure|cool|nice|k|thanks|ty|thx|got it|understood|\u{1F44D}|\u{1F602}|\u{1F64F}|\u{1F4AF}|\u{1F44C}|\u{2705}|hmm|hm|oh|ah|wow|damn|shit|fuck|bro|nigga|fam|bruh|lmfao|fr|word|bet|facts)\W*$/i.test(text.trim());
}

function containsKeyFactPatterns(text) {
  const patterns = [
    /\b(my|our|the)\s+(name|email|phone|address|birthday|anniversary)/i,
    /\b(my|our)\s+(password|username|account|pin|ssn|id number)/i,
    /\b(I'll|I will|we'll|we will|gonna|going to)\s+(call|meet|email|text|remind|buy|sell|pay|send)/i,
    /\b(remember|don't forget|note|remind me|make sure)\b/i,
    /\b(decided|agreed|confirmed|committed|promised|scheduled|planned)/i,
    /\b(preference|favorite|love|hate|always|never|prefer|want|need)\b/i,
    /\b(deadline|due|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|next week)/i,
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/i,
  ];
  return patterns.some(p => p.test(text));
}

// ── Web search (standalone for pre-fetch) ────────────────────────────────────
async function webSearch(query) {
  const SERPER_KEY = process.env.SERPER_API_KEY || '';
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
    const organic = data.organic?.slice(0, 4).map(r => `\u{2022} ${r.title}: ${r.snippet}`).join('\n') || '';
    return [answer, organic].filter(Boolean).join('\n\n') || null;
  } catch (err) {
    console.error('[SEARCH] Web search failed:', err.message);
    return null;
  }
}

// ── Build tool context (chatId + timezone injected into tool execute calls) ──
function buildTools(chatId, timezone) {
  // Wrap each tool's execute to inject context as second arg
  function wrap(tool) {
    return {
      description: tool.description,
      parameters: tool.parameters,
      execute: (args) => tool.execute(args, { chatId, timezone }),
    };
  }

  return {
    search_web:      searchWebTool,  // no context needed
    set_reminder:    wrap(setReminderTool),
    list_reminders:  wrap(listRemindersTool),
    create_schedule: wrap(createScheduleTool),
    edit_schedule:   wrap(editScheduleTool),
    delete_schedule: wrap(deleteScheduleTool),
    list_schedules:  wrap(listSchedulesTool),
    save_memory:     saveMemoryTool,  // no context needed
    recall_memory:   recallMemoryTool,  // no context needed
    plan_goal:       planGoalTool,  // no context needed
  };
}

// ── Main chat handler — AI agent loop with tool use ──────────────────────────
async function handleChat(message, chatId, cleanPrompt, senderName, isBoss, isPrivate, voiceTranscript, res) {
  console.log('[FLOW] Passed all checks, starting AI work...');
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  const isPhoto = !!message.photo;
  const isVoice = !!voiceTranscript;
  const rawPrompt = isPhoto
    ? (message.caption || 'What do you see in this image?')
    : (voiceTranscript || cleanPrompt);
  const taggedPrompt = !isPrivate ? `[${senderName}]: ${rawPrompt}` : rawPrompt;
  const timezone = await getBossTimezone(redis, KEYS.TIMEZONE);

  // ── Voice smart routing (Boss DMs only — reminder/expense/pin from voice) ──
  if (voiceTranscript && isBoss && isPrivate) {
    const handled = await handleVoiceRouting(voiceTranscript, chatId);
    if (handled) return res.status(200).send('OK');
  }

  // ── Electrical quick tools (instant, no AI call) ───────────────────────────
  if (isBoss && !isPhoto) {
    const elecCalc = detectElectricalCalc(rawPrompt);
    if (elecCalc) {
      const result = formatElectricalResult(elecCalc);
      if (result) {
        await bot.sendMessage(chatId, result, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
    }
  }

  // ── Quick expense/material logging ─────────────────────────────────────────
  if (isBoss && !isPhoto) {
    const expenseMatch = rawPrompt.match(/(?:spent|bought|purchased|paid|picked up|grabbed)\s+\$?([\d,.]+)\s+(?:at|from|on)\s+(.+?)(?:\s+for\s+(?:the\s+)?(.+?))?$/i)
      || rawPrompt.match(/\$([\d,.]+)\s+(?:at|from|on)\s+(.+?)(?:\s+for\s+(?:the\s+)?(.+?))?$/i);
    if (expenseMatch) {
      const amount = expenseMatch[1].replace(',', '');
      const vendor = expenseMatch[2].trim().replace(/[.,]+$/, '');
      const jobName = expenseMatch[3]?.trim().replace(/[.,]+$/, '') || 'general';
      const logEntry = `$${amount} at ${vendor} for ${jobName} (${new Date().toLocaleDateString('en-US')})`;
      try {
        await memory.addMemory(logEntry, 'work_projects', 70);
        await bot.sendMessage(chatId, `\u{1F4B0} *Logged:* $${amount} at ${vendor}\n\u{1F4C1} Job: ${jobName}\n\n_Ask "expenses for ${jobName}" to see totals._`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      } catch (err) { console.error('[EXPENSE] Failed to log:', err.message); }
    }
  }

  // ── "Summarize today" / daily recap ────────────────────────────────────────
  if (isBoss && isPrivate && !isPhoto) {
    const todayMatch = /^(?:summarize|recap|summary of|what did (?:we|i|you)\s+(?:talk|discuss|cover|do|say)|what happened|debrief me on)\s+today/i.test(rawPrompt)
      || /^(?:today'?s?\s+(?:summary|recap|debrief))/i.test(rawPrompt);
    if (todayMatch) {
      const todayISO = new Date().toISOString().split('T')[0];
      const entries = await redis.lrange(KEYS.RAW_LOG, 0, 99);
      const todayEntries = entries.filter(e => {
        try { return JSON.parse(e).ts?.startsWith(todayISO); } catch { return false; }
      });
      if (!todayEntries.length) {
        await bot.sendMessage(chatId, '\u{1F4CB} Nothing logged today yet.');
        return res.status(200).send('OK');
      }
      await bot.sendMessage(chatId, `\u{1F504} Summarizing ${todayEntries.length} exchanges from today...`);
      try {
        const logText = todayEntries.reverse().flatMap(e => {
          try {
            const { ts, sender, msg, reply } = JSON.parse(e);
            return [`[${ts.split('T')[1]?.slice(0,5)}] ${sender}: "${msg.slice(0, 150)}" \u{2192} Remy: "${reply.slice(0, 150)}"`];
          } catch { return []; }
        }).join('\n');
        const { text: summary } = await generateText({
          model: CHAT_MODEL,
          prompt: `Summarize today's conversation between ${BOSS_NAME} and Remy. Pull out key topics, decisions, action items, and anything important. Be concise but complete:\n\n${logText}`,
          maxTokens: 800,
        });
        const todayStr = new Date().toLocaleDateString('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
        await safeSend(chatId, `\u{1F4CB} *Today's Recap (${todayStr}):*\n\n${summary}`);
      } catch (err) {
        console.error('[SUMMARIZE] Today failed:', err.message);
        await bot.sendMessage(chatId, '\u{274C} Summary failed. Try again.');
      }
      return res.status(200).send('OK');
    }
  }

  // ── Quick pin detection: "pin: Smith job is at 4521 NW 7th St" ─────────────
  if (isBoss && !isPhoto) {
    const pinMatch = rawPrompt.match(/^pin\s*[:\-]\s*(.+)$/i);
    if (pinMatch && pinMatch[1].length >= 5) {
      const pinContent = pinMatch[1].trim();
      const lower = pinContent.toLowerCase();
      let category = 'personal_preferences';
      if (/\b(job|project|site|contract|client|permit|inspection|wire|panel|conduit)\b/i.test(lower)) category = 'work_projects';
      else if (/\b(address|phone|email|number|contact)\b/i.test(lower)) category = 'contacts';
      else if (/\b(kid|child|son|daughter|wife|family|school|pickup)\b/i.test(lower)) category = 'family_relationships';
      try {
        await memory.addMemory(pinContent, category, 95, true);
        await bot.sendMessage(chatId, `\u{1F4CC} *Pinned* (${category}): "${pinContent.slice(0, 80)}"`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      } catch (err) { console.error('[PIN] Failed:', err.message); }
    }
  }

  // ── Natural language schedule detection (Boss DMs only — no AI call needed) ──
  if (isBoss && isPrivate && !isPhoto) {
    const cronNL = parseCronNL(rawPrompt);
    if (cronNL) {
      const cronTimeUTC = localTimeToUTC(cronNL.time, timezone);
      const { calculateNextFire, parseDayOfWeek } = require('../lib/time');
      const jobId = `cj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const nextFire = calculateNextFire(cronTimeUTC, cronNL.repeat, cronNL.dayOfWeek, cronNL.dayOfMonth);
      const isTask = needsWebSearch(cronNL.message) || /\b(send|get|fetch|summary|summarize|tell|show|check|report|news|weather|briefing)\b/i.test(cronNL.message);

      await redis.hset(KEYS.CRON_ENTRY(jobId),
        'message', cronNL.message, 'repeat', cronNL.repeat, 'time', cronTimeUTC,
        'dayOfWeek', String(cronNL.dayOfWeek ?? ''), 'dayOfMonth', String(cronNL.dayOfMonth ?? ''),
        'chatId', String(chatId), 'enabled', 'true', 'fireCount', '0',
        'jobType', isTask ? 'ai_task' : 'message', 'createdAt', new Date().toISOString(),
      );
      await redis.zadd(KEYS.CRON_JOBS, nextFire, jobId);

      const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
      await bot.sendMessage(chatId,
        `\u{2705} *Scheduled:* "${cronNL.message}"\n\u{1F4C5} ${cronNL.repeat} at \`${cronNL.time}\` \u{2014} first run: ${nextStr}\n\nUse \`/schedules\` to manage.`,
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }
  }

  // ── Natural language reminder detection (Boss DMs only, no AI call) ──
  if (isBoss && isPrivate && !isPhoto) {
    const reminderMatch = rawPrompt.match(/^(?:remind\s+me|set\s+a?\s*reminder|reminder)\s+(.+)$/i);
    if (reminderMatch) {
      const parsed = parseReminderTime(reminderMatch[1], timezone);
      if (parsed) {
        await redis.zadd(KEYS.REMINDERS, parsed.ts, JSON.stringify({ chatId, message: parsed.message, id: Date.now() }));
        const timeStr = new Date(parsed.ts).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
        await bot.sendMessage(chatId, `\u{23F0} Reminder set for *${timeStr}*: "${parsed.message}"`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }
    }
  }

  // ── Direct schedule listing — bypass AI to avoid hallucination ──
  if (isBoss && !rawPrompt.startsWith('/') && /\b(tasks?|schedules?|cron\s*jobs?|reminders?|scheduled)\b/i.test(rawPrompt) && rawPrompt.length < 80) {
    const jobIds = await redis.zrangebyscore(KEYS.CRON_JOBS, 0, '+inf', 'WITHSCORES');
    if (jobIds.length === 0) {
      await bot.sendMessage(chatId, '\u{1F4C5} No scheduled tasks.\n\nCreate one by telling me what you want scheduled, or use `/schedule daily 09:00 Morning news`', { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }
    const lines = [];
    for (let i = 0; i < jobIds.length; i += 2) {
      const jobId = jobIds[i];
      const nextFire = parseInt(jobIds[i + 1]);
      const job = await redis.hgetall(KEYS.CRON_ENTRY(jobId));
      if (!job || !job.message) continue;
      const n = Math.floor(i / 2) + 1;
      const status = job.enabled === 'false' ? '\u{23F8}\u{FE0F}' : '\u{2705}';
      const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
      lines.push(`${n}. ${status} *${job.repeat || 'daily'}* \u{2014} "${job.message}"\n   \u{23F0} Next: ${nextStr} | Fired: ${job.fireCount || 0}x`);
    }
    await bot.sendMessage(chatId,
      `\u{1F4C5} *Your Scheduled Tasks (${lines.length}):*\n\n${lines.join('\n\n')}\n\n_Edit: \`/editschedule <n> ...\` | Delete: \`/deleteschedule <n>\`_`,
      { parse_mode: 'Markdown' }
    );
    return res.status(200).send('OK');
  }

  // ── Fetch context in parallel ──────────────────────────────────────────────
  const visualReq = !isPhoto ? detectVisualRequest(rawPrompt) : null;
  const [contextMemory, history, searchResults, visualResult] = await Promise.all([
    buildContextMemory(rawPrompt),
    getHistory(chatId),
    (!isPhoto && needsWebSearch(rawPrompt)) ? webSearch(rawPrompt) : Promise.resolve(null),
    visualReq?.type === 'image' ? imageSearch(visualReq.query) :
      visualReq?.type === 'map' ? Promise.resolve({ type: 'map', query: visualReq.query }) :
      Promise.resolve(null),
  ]);

  // ── Build system prompt ────────────────────────────────────────────────────
  const role = isBoss ? 'boss' : 'approved';
  let systemPrompt = buildSystemPrompt({ role, isPrivate, senderName, timezone, contextMemory });

  // Inject live search results if available
  if (searchResults) {
    systemPrompt += `\n\n--- LIVE INTEL ---\n${searchResults}\n--- END LIVE INTEL ---\nUse this to answer current questions. Reference it naturally ("Just looked this up..." or "As of today...").`;
  }

  // ── Build current message ──────────────────────────────────────────────────
  let currentMessage;
  if (isPhoto) {
    const photo    = message.photo[message.photo.length - 1];
    const fileInfo = await bot.getFile(photo.file_id);
    const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    currentMessage = {
      role: 'user',
      content: [
        { type: 'text',  text: taggedPrompt },
        { type: 'image', image: new URL(fileUrl) },
      ],
    };
  } else {
    currentMessage = { role: 'user', content: taggedPrompt };
  }

  // ── Model routing ──────────────────────────────────────────────────────────
  const hasWebSearch = !!searchResults;
  const { primary: primaryModel, primaryName, secondary: secondaryModel, secondaryName } = pickModels(rawPrompt, hasWebSearch);

  console.log(`[AI] Routing \u{2192} ${primaryName} | prompt: ${rawPrompt.length} chars | history: ${history.length}`);
  const aiStartTime = Date.now();
  const aiMessages = [...history, currentMessage];

  // ── Build tools (only for boss in private — tool use is boss-only) ─────────
  const tools = (isBoss && isPrivate) ? buildTools(chatId, timezone) : undefined;

  // ── Generate response with tool use ────────────────────────────────────────
  let aiResponse;
  try {
    const abortController = new AbortController();
    const aiTimeout = setTimeout(() => abortController.abort(), 25000);
    try {
      const result = await generateText({
        model: primaryModel,
        system: systemPrompt,
        messages: aiMessages,
        tools,
        maxSteps: 5,  // allow up to 5 tool calls per turn
        abortSignal: abortController.signal,
      });
      aiResponse = result.text;
      console.log(`[AI] ${primaryName} success in ${Date.now() - aiStartTime}ms | steps: ${result.steps?.length || 1}`);
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
            // No tools on fallback — simpler and more reliable
            abortSignal: abortController2.signal,
          });
          aiResponse = result.text;
          console.log(`[AI] ${secondaryName} fallback success in ${Date.now() - fallbackStart}ms`);
        } finally {
          clearTimeout(fallbackTimeout);
        }
      } catch (fallbackErr) {
        console.error(`[AI] ${secondaryName} ALSO FAILED after ${Date.now() - fallbackStart}ms:`, fallbackErr.name, fallbackErr.message);
        await bot.sendMessage(chatId, '\u{26A0}\u{FE0F} Both my primary and backup brains are down. Try again in a minute.').catch(() => {});
        return res.status(200).send('OK');
      }
    } else {
      const msg = primaryErr.name === 'AbortError'
        ? '\u{23F1}\u{FE0F} Took too long to think that one through. Try asking again or simplify the question.'
        : `\u{26A0}\u{FE0F} My brain glitched. (${primaryErr.message?.slice(0, 80)})`;
      await bot.sendMessage(chatId, msg).catch(() => {});
      return res.status(200).send('OK');
    }
  }

  // ── Send response ──────────────────────────────────────────────────────────
  await safeSend(chatId, aiResponse);

  // ── Send visual content (image or map) if requested ────────────────────────
  if (visualResult) {
    try {
      if (visualResult.type === 'map') {
        const mapQuery = encodeURIComponent(visualResult.query);
        await bot.sendMessage(chatId, `\u{1F4CD} https://www.google.com/maps/search/${mapQuery}`, { disable_web_page_preview: false });
        console.log(`[VISUAL] Sent map link for: ${visualResult.query}`);
      } else if (visualResult.url) {
        try {
          await bot.sendPhoto(chatId, visualResult.url, {
            caption: visualResult.title ? `\u{1F4F7} ${visualResult.title}` : undefined,
          });
          console.log(`[VISUAL] Sent image for: ${visualReq.query}`);
        } catch (photoErr) {
          console.error('[VISUAL] sendPhoto failed, sending link:', photoErr.message);
          await bot.sendMessage(chatId, `\u{1F4F7} ${visualResult.url}`);
        }
      }
    } catch (err) {
      console.error('[VISUAL] Failed to send visual:', err.message);
    }
  }

  // ── Save history + log (awaited — fast Redis ops) ──────────────────────────
  const histKey     = KEYS.HISTORY(chatId);
  const histContent = isPhoto ? `[Photo] ${rawPrompt}` : taggedPrompt;
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

    redis.lpush(KEYS.RAW_LOG, logEntry)
      .then(() => redis.ltrim(KEYS.RAW_LOG, 0, MAX_LOG_ENTRIES - 1)).catch(() => {}),
  ]);

  // ── Memory extraction (Boss messages only) ─────────────────────────────────
  if (isBoss && histContent.length >= MIN_MEMORY_LEN && !isTrivialMessage(rawPrompt) && (rawPrompt.length > 80 || containsKeyFactPatterns(rawPrompt))) {
    await redis.incr(KEYS.EXCHANGE_COUNT).catch(() => {});
    try {
      const existingMemories = await memory.semanticSearch(rawPrompt.slice(0, 100), 10);
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
}

module.exports = { handleChat };
