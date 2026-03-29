const { z } = require('zod');
const { redis, KEYS } = require('../lib/redis');
const { localTimeToUTC, calculateNextFire, parseDayOfWeek } = require('../lib/time');
const { needsWebSearch } = require('./search');

// ── Create a recurring scheduled task ─────────────────────────────────────────
const createScheduleTool = {
  description: 'Create a recurring scheduled task. Use when the user wants something done daily, on weekdays, weekly, or monthly. Always confirm the details first.',
  parameters: z.object({
    task: z.string().describe('What the task should do'),
    repeat: z.enum(['daily', 'weekdays', 'weekly', 'monthly']).describe('How often'),
    time: z.string().describe('Time in HH:MM format (user local time)'),
    day: z.string().optional().describe('Day name for weekly (e.g., "monday") or day number for monthly (e.g., "15")'),
  }),
  execute: async ({ task, repeat, time, day }, { chatId, timezone }) => {
    const utcTime = localTimeToUTC(time, timezone);
    const dayOfWeek = repeat === 'weekly' ? parseDayOfWeek(day || 'mon') : null;
    const dayOfMonth = repeat === 'monthly' ? (parseInt(day) || 1) : null;
    const isTask = needsWebSearch(task) || /\b(send|get|fetch|summary|summarize|tell|show|check|report|news|weather|briefing|debrief|analyze)\b/i.test(task);

    const jobId = `cj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nextFire = calculateNextFire(utcTime, repeat, dayOfWeek, dayOfMonth);

    await redis.hset(KEYS.CRON_ENTRY(jobId),
      'message', task, 'repeat', repeat, 'time', utcTime,
      'dayOfWeek', String(dayOfWeek ?? ''), 'dayOfMonth', String(dayOfMonth ?? ''),
      'chatId', String(chatId), 'enabled', 'true', 'fireCount', '0',
      'jobType', isTask ? 'ai_task' : 'message', 'createdAt', new Date().toISOString(),
    );
    await redis.zadd(KEYS.CRON_JOBS, nextFire, jobId);

    const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
    return { success: true, jobId, repeat, time, task, nextRun: nextStr };
  },
};

// ── Edit a recurring scheduled task ───────────────────────────────────────────
const editScheduleTool = {
  description: 'Edit an existing recurring scheduled task by its number. Use when the user wants to change the time, frequency, or description of a task.',
  parameters: z.object({
    number: z.number().describe('The task number from the schedule list'),
    task: z.string().optional().describe('New task description'),
    repeat: z.enum(['daily', 'weekdays', 'weekly', 'monthly']).optional().describe('New frequency'),
    time: z.string().optional().describe('New time in HH:MM format (user local time)'),
    day: z.string().optional().describe('New day for weekly/monthly'),
  }),
  execute: async ({ number, task, repeat, time, day }, { timezone }) => {
    const all = await redis.zrangebyscore(KEYS.CRON_JOBS, 0, '+inf', 'WITHSCORES');
    const idx = (number - 1) * 2;
    if (idx >= all.length || idx < 0) return { error: `Task ${number} not found` };
    const jobId = all[idx];

    const updates = {};
    if (task) updates.message = task;
    if (repeat) updates.repeat = repeat;
    if (time) updates.time = localTimeToUTC(time, timezone);
    if (day && (repeat === 'weekly' || !repeat)) updates.dayOfWeek = String(parseDayOfWeek(day) ?? '');
    if (day && repeat === 'monthly') updates.dayOfMonth = day;

    for (const [k, v] of Object.entries(updates)) {
      await redis.hset(KEYS.CRON_ENTRY(jobId), k, v);
    }

    const jobData = await redis.hgetall(KEYS.CRON_ENTRY(jobId));
    const nextFire = calculateNextFire(jobData.time, jobData.repeat, jobData.dayOfWeek, jobData.dayOfMonth);
    await redis.zadd(KEYS.CRON_JOBS, nextFire, jobId);

    const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
    return { success: true, updated: updates, nextRun: nextStr };
  },
};

// ── Delete a recurring scheduled task ─────────────────────────────────────────
const deleteScheduleTool = {
  description: 'Delete a recurring scheduled task by its number. Use when the user wants to remove a task.',
  parameters: z.object({
    number: z.number().describe('The task number to delete'),
  }),
  execute: async ({ number }) => {
    const all = await redis.zrangebyscore(KEYS.CRON_JOBS, 0, '+inf', 'WITHSCORES');
    const idx = (number - 1) * 2;
    if (idx >= all.length || idx < 0) return { error: `Task ${number} not found` };
    const jobId = all[idx];
    const job = await redis.hgetall(KEYS.CRON_ENTRY(jobId));
    await redis.del(KEYS.CRON_ENTRY(jobId));
    await redis.zrem(KEYS.CRON_JOBS, jobId);
    return { success: true, deleted: job?.message || jobId };
  },
};

// ── List all scheduled tasks ──────────────────────────────────────────────────
const listSchedulesTool = {
  description: 'List all recurring scheduled tasks. Use when the user asks about their schedules, tasks, or cron jobs.',
  parameters: z.object({}),
  execute: async (_, { timezone }) => {
    const all = await redis.zrangebyscore(KEYS.CRON_JOBS, 0, '+inf', 'WITHSCORES');
    if (!all.length) return { tasks: [], count: 0 };
    const tasks = [];
    for (let i = 0; i < all.length; i += 2) {
      const jobId = all[i];
      const nextFire = parseInt(all[i + 1]);
      const job = await redis.hgetall(KEYS.CRON_ENTRY(jobId));
      if (!job || !job.message) continue;
      const nextStr = new Date(nextFire).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
      tasks.push({
        number: Math.floor(i / 2) + 1,
        task: job.message,
        repeat: job.repeat || 'daily',
        enabled: job.enabled !== 'false',
        nextRun: nextStr,
        fireCount: parseInt(job.fireCount) || 0,
      });
    }
    return { tasks, count: tasks.length };
  },
};

module.exports = { createScheduleTool, editScheduleTool, deleteScheduleTool, listSchedulesTool };
