// ── Time parsing and timezone utilities ───────────────────────────────────────

// Parse "in 2h to call John" format
function parseReminderTime(text) {
  const match = text.match(/^in\s+(\d+)\s*(m(?:in(?:s|utes?)?)?|h(?:r?s?|ours?)?|d(?:ays?)?)\s+(?:to\s+|about\s+)?(.+)$/i);
  if (!match) return null;
  const amount = parseInt(match[1]);
  const unit   = match[2][0].toLowerCase();
  const msg    = match[3].trim();
  const ms     = { m: 60000, h: 3600000, d: 86400000 }[unit] || 60000;
  return { ts: Date.now() + amount * ms, message: msg };
}

// Convert local time string (HH:MM) in a given timezone to UTC (HH:MM)
function localTimeToUTC(timeStr, timezone) {
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
  const localStr = now.toLocaleString('en-US', { timeZone: timezone, hour12: false });
  const utcDate = new Date(utcStr);
  const localDate = new Date(localStr);
  const offsetMs = utcDate.getTime() - localDate.getTime();
  const totalMinutes = h * 60 + m + Math.round(offsetMs / 60000);
  const utcH = ((totalMinutes % 1440) + 1440) % 1440;
  return String(Math.floor(utcH / 60)).padStart(2, '0') + ':' + String(utcH % 60).padStart(2, '0');
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

// Parse day name or number (0=Sun ... 6=Sat) for weekly jobs
function parseDayOfWeek(input) {
  const days = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
                 wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5,
                 sat: 6, saturday: 6 };
  const n = parseInt(input);
  if (!isNaN(n) && n >= 0 && n <= 6) return n;
  return days[input.toLowerCase()] ?? null;
}

// Calculate next fire timestamp (UTC-aware)
function calculateNextFire(time, repeat, dayOfWeek, dayOfMonth) {
  const [hours, minutes] = time.split(':').map(Number);
  const now = new Date();
  let next = new Date(now);
  next.setUTCHours(hours, minutes, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  switch (repeat) {
    case 'daily':
      return next.getTime();
    case 'weekdays':
      while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
      return next.getTime();
    case 'weekly':
      const targetDay = parseInt(dayOfWeek) || 1;
      while (next.getUTCDay() !== targetDay) next.setUTCDate(next.getUTCDate() + 1);
      return next.getTime();
    case 'monthly':
      const targetDate = parseInt(dayOfMonth) || 1;
      if (next.getUTCDate() > targetDate) {
        next.setUTCDate(1);
        next.setUTCMonth(next.getUTCMonth() + 1);
      }
      const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
      next.setUTCDate(Math.min(targetDate, lastDay));
      return next.getTime();
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

// Get boss timezone from Redis (cached per request)
async function getBossTimezone(redis, TIMEZONE_KEY) {
  const saved = await redis.get(TIMEZONE_KEY).catch(() => null);
  return saved || process.env.BOSS_TIMEZONE || 'America/New_York';
}

// Format current time for system prompt
function formatLocalTime(timezone) {
  return new Date().toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

module.exports = {
  parseReminderTime,
  localTimeToUTC,
  parseTimeStr,
  parseDayOfWeek,
  calculateNextFire,
  parseCronCommand,
  parseCronNL,
  getBossTimezone,
  formatLocalTime,
};
