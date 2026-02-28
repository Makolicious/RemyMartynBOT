# Agent Planner & Enhanced Memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add AI planning capability (`/agent plan <goal>`) and enhance memory with 20 table-based categories plus Telegram formatter.

**Architecture:** Incremental approach - Planner agent as Vercel API endpoint, table-based memory stored in Redis, Telegram formatter converts tables to readable text. No orchestrator, queue, or worker initially.

**Tech Stack:** Node.js (Vercel serverless), Zhipu AI (GLM-4.5), Redis (ioredis), node-telegram-bot-api, ai SDK

---

## Task 1: Create api/utils directory

**Files:**
- Create: `api/utils/.gitkeep`

**Step 1: Create utils directory**

```bash
mkdir -p api/utils
touch api/utils/.gitkeep
```

**Step 2: Commit**

```bash
git add api/utils/.gitkeep
git commit -m "chore: create api/utils directory"
```

---

## Task 2: Create Telegram Table Formatter

**Files:**
- Create: `api/utils/formatter.js`

**Step 1: Write the formatter module**

```javascript
/**
 * Telegram Table Formatter
 * Converts markdown tables to emoji-decorated text for Telegram display
 */

const TABLE_ICONS = {
  'Boss Profile': '👤',
  'Personality & Traits': '🧠',
  'Goals & Aspirations': '🎯',
  'Habits & Routines': '⏰',
  'Skills & Expertise': '⚡',
  'Friends & Contacts': '👥',
  'Family Members': '👨‍👩‍👧‍👦',
  'Business Associates': '💼',
  'Active Projects': '📁',
  'Business Ideas & Ventures': '💡',
  'Food & Drink Preferences': '🍽️',
  'Technology & Tools': '🛠️',
  'Entertainment Preferences': '🎬',
  'Work Style & Environment': '🏢',
  'Communication Style': '💬',
  'Travel & Places': '🌍',
  'Key Dates & Milestones': '📅',
  'Decisions & Commitments': '✅',
  'Pending Action Items': '📋',
  'Notes & Miscellaneous': '📝'
};

/**
 * Parse markdown tables from memory string
 * Returns array of { title, headers, rows }
 */
function parseTables(memory) {
  const tables = [];
  const lines = memory.split('\n');
  let currentTable = null;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Table header (starts with |)
    if (line.match(/^\|.+?\|/)) {
      if (!currentTable) {
        // New table - get title from previous line
        const titleLine = lines[i - 1] || '';
        const titleMatch = titleLine.match(/^##?\s*(.+)/);
        currentTable = {
          title: titleMatch ? titleMatch[1].trim() : 'Table',
          headers: parseTableRow(line),
          rows: []
        };
      } else if (!line.match(/^\|[-|\s]+\|$/)) {
        // Skip separator row, add data row
        const row = parseTableRow(line);
        if (row.length === currentTable.headers.length) {
          currentTable.rows.push(row);
        }
      }
    } else if (currentTable) {
      // End of table
      if (currentTable.rows.length > 0) {
        tables.push(currentTable);
      }
      currentTable = null;
    }
  }

  // Don't forget the last table
  if (currentTable && currentTable.rows.length > 0) {
    tables.push(currentTable);
  }

  return tables;
}

/**
 * Parse a single table row (remove pipes, trim cells)
 */
function parseTableRow(line) {
  return line.split('|')
    .map(cell => cell.trim())
    .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1); // Skip empty first/last
}

/**
 * Get emoji icon for table title
 */
function getTableIcon(title) {
  return TABLE_ICONS[title] || '📊';
}

/**
 * Format a table for Telegram display
 */
function formatTable(table) {
  if (!table || !table.rows || table.rows.length === 0) {
    return '';
  }

  const icon = getTableIcon(table.title);
  const lines = [`${icon} ${table.title}`];
  lines.push('┌' + '─'.repeat(45) + '┐');

  // Format each row
  for (const row of table.rows) {
    // Skip rows with all placeholders like [Field] or ---
    const isEmpty = row.every(cell =>
      cell.match(/^\[.*?\]$/) || cell === '' || cell === '---'
    );
    if (isEmpty) continue;

    const formattedRow = formatTableRow(row, table.headers);
    lines.push(`│ ${formattedRow.padEnd(43)}│`);
  }

  lines.push('└' + '─'.repeat(45) + '┘');
  return lines.join('\n');
}

/**
 * Format a single table row for display
 */
function formatTableRow(row, headers) {
  if (headers.length >= 4) {
    // Multi-column table: show first 3 columns with bullet
    const cells = row.slice(0, 3).map(cell => truncateCell(cell, 12));
    return `▫️ ${cells.join('  •  ')}`;
  } else if (headers.length >= 2) {
    // Two-column table
    return `${row[0]}: ${row.slice(1).join(' ')}`;
  }
  return row.join(' ');
}

/**
 * Truncate cell if too long
 */
function truncateCell(cell, maxLength) {
  if (cell.length <= maxLength) return cell;
  return cell.substring(0, maxLength - 2) + '..';
}

/**
 * Format entire memory for Telegram
 * Options: { paginate: boolean, sections: string[], limit: number }
 */
function formatMemoryForTelegram(memory, options = {}) {
  const tables = parseTables(memory);

  if (tables.length === 0) {
    return '📊 No memory data found.';
  }

  let result = '';

  // Filter by sections if specified
  let displayTables = tables;
  if (options.sections && options.sections.length > 0) {
    displayTables = tables.filter(t =>
      options.sections.some(s => t.title.toLowerCase().includes(s.toLowerCase()))
    );
  }

  // Limit number of tables
  const limit = options.limit || displayTables.length;
  displayTables = displayTables.slice(0, limit);

  // Format each table
  for (const table of displayTables) {
    const formatted = formatTable(table);
    if (formatted) {
      result += formatted + '\n\n';
    }
  }

  if (options.limit && tables.length > limit) {
    result += `\n... and ${tables.length - limit} more sections.\n`;
    result += `Use /memory view [section] to see specific sections.`;
  }

  return result.trim() || '📊 No memory data to display.';
}

module.exports = {
  formatMemoryForTelegram,
  parseTables,
  formatTable
};
```

**Step 2: Commit**

```bash
git add api/utils/formatter.js
git commit -m "feat: add Telegram table formatter"
```

---

## Task 3: Update EMPTY_MEMORY with 20 Tables

**Files:**
- Modify: `api/webhook.js:53-105`

**Step 1: Replace EMPTY_MEMORY constant**

Find the `EMPTY_MEMORY` constant (around line 54) and replace with:

```javascript
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
```

**Step 2: Commit**

```bash
git add api/webhook.js
git commit -m "feat: update memory to 20 table-based categories"
```

---

## Task 4: Create Planner Agent Endpoint

**Files:**
- Create: `api/agent/planner.js`

**Step 1: Write the planner endpoint**

```javascript
const { zai } = require('zhipu-ai-provider');
const { generateText } = require('ai');

const PLANNER_MODEL = zai('glm-4.5');

const PLANNER_SYSTEM = `You are a planning agent for Remy, a personal AI assistant.

Your job: break down user goals into clear, actionable steps.
Use the provided memory for context about projects, goals, and preferences.

Return ONLY a valid JSON response with this structure:
{
  "title": "Short descriptive title",
  "steps": [
    { "id": 1, "action": "Specific action to take", "estimatedTime": "e.g., 15min" }
  ],
  "notes": "Optional helpful advice or context"
}

Rules:
- 3-7 steps max
- Each step must be specific and actionable
- Estimate realistic time (5min, 15min, 30min, 1hr, etc.)
- Keep steps in logical order
- Steps should build toward the goal
- If goal is vague, make reasonable assumptions`;

/**
 * Generate a plan from a user goal
 */
async function generatePlan(goal, context = {}) {
  const { memory = '', timezone = 'UTC', currentDate = '' } = context;

  const prompt = `Goal: ${goal}

Context:
- Current Date: ${currentDate}
- Timezone: ${timezone}

Memory:
${memory || 'No memory available yet.'}

Generate a plan to achieve this goal. Return ONLY valid JSON.`;

  try {
    const result = await generateText({
      model: PLANNER_MODEL,
      system: PLANNER_SYSTEM,
      prompt,
      temperature: 0.7,
      maxTokens: 800,
    });

    // Parse and validate JSON response
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const plan = JSON.parse(jsonMatch[0]);

    // Validate structure
    if (!plan.title || !plan.steps || !Array.isArray(plan.steps)) {
      throw new Error('Invalid plan structure');
    }

    // Ensure steps have required fields
    plan.steps = plan.steps.map((step, idx) => ({
      id: step.id || idx + 1,
      action: step.action || 'Action not specified',
      estimatedTime: step.estimatedTime || '15min'
    }));

    return plan;

  } catch (error) {
    console.error('Planner error:', error.message);
    throw error;
  }
}

// Vercel serverless handler
module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { goal, context = {} } = req.body;

    if (!goal || typeof goal !== 'string' || goal.trim().length < 3) {
      return res.status(400).json({ error: 'Invalid goal. Please provide a clear goal.' });
    }

    const plan = await generatePlan(goal, context);

    res.status(200).json(plan);

  } catch (error) {
    console.error('Planner endpoint error:', error);
    res.status(500).json({
      error: 'Failed to generate plan',
      message: error.message
    });
  }
};
```

**Step 2: Commit**

```bash
git add api/agent/planner.js
git commit -m "feat: add planner agent endpoint"
```

---

## Task 5: Add /agent plan Command to Webhook

**Files:**
- Modify: `api/webhook.js`

**Step 1: Add formatter import**

Add at top of file after other imports (around line 7-8):

```javascript
const { formatMemoryForTelegram } = require('./utils/formatter');
```

**Step 2: Add plan formatter function**

Add after helper functions section (around line 160):

```javascript
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

// Call planner endpoint (internal)
async function planGoal(goal, userId) {
  // Get context from Redis
  const memory = await redis.get(MEMORY_KEY) || EMPTY_MEMORY;
  const timezone = await redis.get(TIMEZONE_KEY) || 'UTC';
  const currentDate = new Date().toISOString().split('T')[0];

  // Call planner endpoint internally
  const response = await fetch(new URL('/api/agent/planner', req.url).href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, context: { memory, timezone, currentDate } })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to generate plan');
  }

  return response.json();
}
```

**Step 3: Add command detection in message handler**

Find the message handling section (search for `/notes` command handling) and add before other commands (around line 600+ where command detection happens):

```javascript
// Agent planning command
if (msg.text?.startsWith('/agent plan ')) {
  const goal = msg.text.substring('/agent plan '.length).trim();
  if (goal.length < 3) {
    await bot.sendMessage(chatId, 'Please provide a clear goal after /agent plan\nExample: /agent plan my productive week');
    return;
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const plan = await planGoal(goal, msg.from.id);
    await bot.sendMessage(chatId, formatPlanForTelegram(plan), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Plan generation error:', error);
    await bot.sendMessage(chatId, `Sorry, I couldn't generate a plan. Error: ${error.message}`);
  }
  return;
}

// /agent help
if (msg.text?.startsWith('/agent') || msg.text?.startsWith('/agent ')) {
  await bot.sendMessage(chatId, `*Agent Commands*\n\n/agent plan <goal> - Generate a structured plan\n\nExample: /agent plan my productive week`, { parse_mode: 'Markdown' });
  return;
}
```

**Note:** You'll need to add `req` parameter to the handler function or adjust the URL construction. Alternatively, use environment variable for base URL.

**Alternative for Step 2 (better approach):**

Replace the `planGoal` function with:

```javascript
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
```

And add `PLANNER_SYSTEM` constant near top of file:

```javascript
const PLANNER_SYSTEM = `You are a planning agent for Remy.

Break down user goals into 3-7 clear, actionable steps.
Use memory for context about projects, goals, preferences.

Return ONLY JSON:
{
  "title": "Short title",
  "steps": [
    { "id": 1, "action": "Specific action", "estimatedTime": "15min" }
  ],
  "notes": "Optional advice"
}`;
```

**Step 4: Commit**

```bash
git add api/webhook.js
git commit -m "feat: add /agent plan command to webhook"
```

---

## Task 6: Update Admin Memory Display with Formatter

**Files:**
- Modify: `api/admin.js`

**Step 1: Add formatter import**

At top of file after other imports:

```javascript
const { formatMemoryForTelegram } = require('./utils/formatter');
```

**Step 2: Find memory display endpoint**

Find the endpoint that returns memory (search for `MEMORY_KEY` usage in admin.js). Modify the response to use formatter.

**Step 3: Commit**

```bash
git add api/admin.js
git commit -m "feat: use table formatter in admin memory display"
```

---

## Task 7: Test Planner Endpoint Locally

**Files:**
- Test: Manual test

**Step 1: Test the planner endpoint**

```bash
curl -X POST http://localhost:3000/api/agent/planner \
  -H "Content-Type: application/json" \
  -d '{"goal":"Plan my week for productivity","context":{"memory":"No memory yet","timezone":"UTC","currentDate":"2026-02-27"}}'
```

**Expected output:** JSON with title, steps array, optional notes

**Step 2: Verify JSON structure**

Check response has:
- `title` (string)
- `steps` (array)
- Each step has: `id`, `action`, `estimatedTime`

---

## Task 8: Test Telegram Formatter

**Files:**
- Test: Create test file

**Step 1: Create test file**

```bash
cat > test-formatter.js << 'EOF'
const { formatMemoryForTelegram, parseTables } = require('./api/utils/formatter');

const testMemory = `# Test Memory

## Active Projects
| Project | Phase | Deadline | Progress | Notes |
|----------|-------|----------|----------|-------|
| Project A | Planning | Q2 | 0% | Initial research |
| Project B | Execution | Q3 | 60% | On track |

## Friends & Contacts
| Name | Relationship | Last Contact | Key Info |
|------|--------------|--------------|----------|
| John | Friend | Yesterday | Working on startup |
`;

console.log('=== Parsed Tables ===');
const tables = parseTables(testMemory);
console.log(JSON.stringify(tables, null, 2));

console.log('\n=== Formatted for Telegram ===');
console.log(formatMemoryForTelegram(testMemory));
EOF

node test-formatter.js
```

**Expected output:** Parsed tables array + formatted text with emojis and box drawing

**Step 3: Cleanup test file**

```bash
rm test-formatter.js
```

---

## Task 9: Deploy and Test /agent plan Command

**Files:**
- Deploy: Vercel

**Step 1: Deploy to Vercel**

```bash
vercel --prod
```

**Step 2: Test in Telegram**

1. Open Telegram bot
2. Send: `/agent plan my productive week`
3. Verify response:
   - Plan title displayed
   - 3-7 steps with estimated times
   - Each step is actionable
   - Optional notes section

**Step 3: Verify memory is being used**

1. Add some project data to memory
2. Run `/agent plan something related`
3. Check if plan references your projects

---

## Task 10: Verify Token Usage

**Files:**
- Verify: Check API logs

**Step 1: Check Vercel logs**

```bash
vercel logs
```

**Step 2: Verify AI call count**

Each `/agent plan` should make:
- 1 AI call to GLM-4.5 (same as normal chat)

**Step 3: Compare with normal chat**

- Send normal message: 1 AI call
- Send `/agent plan`: 1 AI call

**Expected:** Same number of AI calls, same token cost

---

## Task 11: Update Admin Dashboard for New Memory

**Files:**
- Modify: `public/admin.html`

**Step 1: Update memory editor section**

Find the memory editor section and update to support table-based display.

**Note:** This is a nice-to-have. The existing memory editor should still work with the new format (it's just markdown).

**Step 2: Commit**

```bash
git add public/admin.html
git commit -m "feat: update admin for table-based memory"
```

---

## Task 12: Final Verification

**Files:**
- Verify: All features

**Step 1: Complete checklist**

- [ ] `/agent plan <goal>` returns structured steps
- [ ] Steps are relevant and actionable (test various goals)
- [ ] No token cost increase vs normal chat
- [ ] Tables display cleanly in Telegram
- [ ] Memory can be updated with new structure
- [ ] Admin dashboard renders tables correctly

**Step 2: Document changes**

Update `docs/plans/2026-02-27-agent-planner-memory-design.md` with "Completed" status.

**Step 3: Commit final documentation**

```bash
git add docs/plans/2026-02-27-agent-planner-memory-design.md
git commit -m "docs: mark design as completed"
```

---

## Summary

**New files created:**
- `api/utils/formatter.js` - Telegram table formatter
- `api/agent/planner.js` - Planner endpoint

**Files modified:**
- `api/webhook.js` - Added `/agent plan` command, updated EMPTY_MEMORY
- `api/admin.js` - Updated memory display with formatter
- `public/admin.html` - Updated for table-based memory (optional)

**Total estimated time:** 2-3 hours

**Success criteria:**
- `/agent plan <goal>` generates 3-7 actionable steps
- Token cost equals normal chat (1 AI call)
- 20 table categories stored in memory
- Tables display cleanly in Telegram with emojis
