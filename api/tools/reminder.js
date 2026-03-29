const { z } = require('zod');
const { redis, KEYS } = require('../lib/redis');

// ── Tool definition for AI SDK ────────────────────────────────────────────────
const setReminderTool = {
  description: 'Set a one-time reminder for the user. Use when they ask to be reminded of something at a specific time. Supports relative times (e.g., "in 2 hours") or absolute timestamps.',
  parameters: z.object({
    message: z.string().describe('What to remind about'),
    minutes_from_now: z.number().describe('Minutes from now to fire the reminder. E.g., 120 for "in 2 hours", 1440 for "tomorrow"'),
  }),
  execute: async ({ message, minutes_from_now }, { chatId, timezone }) => {
    const ts = Date.now() + minutes_from_now * 60000;
    await redis.zadd(KEYS.REMINDERS, ts, JSON.stringify({ chatId, message, id: Date.now() }));
    const timeStr = new Date(ts).toLocaleString('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return { success: true, time: timeStr, message };
  },
};

// ── Tool to list current reminders ────────────────────────────────────────────
const listRemindersTool = {
  description: 'List all pending one-time reminders. Use when the user asks to see their reminders.',
  parameters: z.object({}),
  execute: async (_, { chatId, timezone }) => {
    const all = await redis.zrangebyscore(KEYS.REMINDERS, Date.now(), '+inf', 'WITHSCORES');
    if (!all.length) return { reminders: [], count: 0 };
    const reminders = [];
    for (let i = 0; i < all.length; i += 2) {
      try {
        const { message } = JSON.parse(all[i]);
        const time = new Date(parseInt(all[i + 1])).toLocaleString('en-US', {
          timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
        });
        reminders.push({ message, time });
      } catch {}
    }
    return { reminders, count: reminders.length };
  },
};

module.exports = { setReminderTool, listRemindersTool };
