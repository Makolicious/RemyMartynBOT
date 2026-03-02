# Context-Aware Memory Injection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the full `exportAsMarkdown()` memory dump in the system prompt with a hybrid function that always injects PERMANENT_CATEGORIES and fills the rest with topic-relevant memories from `searchMemories()`.

**Architecture:** A new `buildContextMemory(message)` function fetches permanent category memories and keyword-matched memories in parallel, deduplicates, formats as compact `[Category] key: val | key: val` lines, and returns a string capped at 1000 chars. `exportAsMarkdown()` is untouched — still used by `/memory`, `/memexport`, `planGoal()`.

**Tech Stack:** Node.js, ioredis, `api/memory/index.js` (`getMemoriesByCategory`, `searchMemories`, `PERMANENT_CATEGORIES`), `api/webhook.js`

---

### Task 1: Export PERMANENT_CATEGORIES from memory module

**Files:**
- Modify: `api/memory/index.js` (module.exports block, last ~10 lines)

**Step 1: Open the file and locate module.exports**

```
api/memory/index.js — bottom of file, around line 409
```

**Step 2: Add PERMANENT_CATEGORIES to exports**

Find:
```js
module.exports = {
  addMemory,
  getMemory,
  getMemoriesByCategory,
  searchMemories,
  updateMemory,
  deleteMemory,
  applyDecay,
  pruneMemories,
  getStats,
  exportAsMarkdown,
  CATEGORIES
};
```

Replace with:
```js
module.exports = {
  addMemory,
  getMemory,
  getMemoriesByCategory,
  searchMemories,
  updateMemory,
  deleteMemory,
  applyDecay,
  pruneMemories,
  getStats,
  exportAsMarkdown,
  CATEGORIES,
  PERMANENT_CATEGORIES
};
```

Note: `PERMANENT_CATEGORIES` is already defined in `api/memory/schema.js` and imported at the top of `index.js`. Confirm with:
```bash
grep -n "PERMANENT_CATEGORIES" api/memory/index.js | head -5
```

**Step 3: Verify syntax**
```bash
node -c api/memory/index.js
```
Expected: `api/memory/index.js syntax OK`

**Step 4: Commit**
```bash
git add api/memory/index.js
git commit -m "feat: export PERMANENT_CATEGORIES from memory module"
```

---

### Task 2: Add buildContextMemory() to webhook.js

**Files:**
- Modify: `api/webhook.js` — add function just before the `handleCallbackQuery` function (around line 270, after `containsKeyFactPatterns`)

**Step 1: Locate the insertion point**

Find the comment `// ── Callback query handler` in webhook.js. Insert the new function immediately above it.

**Step 2: Write the function**

```js
// ── Context-aware memory builder ─────────────────────────────────────────────
// Fetches permanent category memories (always relevant) + keyword-matched
// memories for the current message. Returns compact formatted string.
async function buildContextMemory(currentMessage) {
  const MAX_CHARS = 1000;
  const PERMANENT_CATS = memory.PERMANENT_CATEGORIES;

  try {
    // Fetch permanent categories (top 3 per cat) + search in parallel
    const [permanentResults, searchResults] = await Promise.all([
      Promise.all(PERMANENT_CATS.map(cat => memory.getMemoriesByCategory(cat, 3))),
      memory.searchMemories(currentMessage.slice(0, 100), 8),
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
    return result.length > MAX_CHARS
      ? result.slice(0, MAX_CHARS) + '\n[...memory truncated...]'
      : result;

  } catch (e) {
    console.error('[MEMORY] buildContextMemory failed:', e.message);
    return null;
  }
}
```

**Step 3: Verify syntax**
```bash
node -c api/webhook.js
```
Expected: `api/webhook.js syntax OK`

**Step 4: Commit**
```bash
git add api/webhook.js
git commit -m "feat: add buildContextMemory() hybrid context-aware memory function"
```

---

### Task 3: Wire buildContextMemory() into the main message handler

**Files:**
- Modify: `api/webhook.js` — around line 1248 (the main `Promise.all` fetch block)

**Step 1: Locate the Promise.all block**

Find this exact code (around line 1248):
```js
const [memorySnapshot, rawHistory, savedTz, searchResults] = await Promise.all([
  memory.exportAsMarkdown().catch(e => { console.error('Memory export failed:', e.message); return null; }),
```

**Step 2: Replace exportAsMarkdown() with buildContextMemory()**

Old:
```js
const [memorySnapshot, rawHistory, savedTz, searchResults] = await Promise.all([
  memory.exportAsMarkdown().catch(e => { console.error('Memory export failed:', e.message); return null; }),
  redis.lrange(`${HIST_PREFIX}${chatId}`, 0, MAX_HIST_MSGS - 1).catch(e => { console.error('Redis history fetch failed:', e.message); return []; }),
  redis.get(TIMEZONE_KEY).catch(e => { console.error('Redis timezone fetch failed:', e.message); return null; }),
  (!isPhoto && needsWebSearch(cleanPrompt)) ? webSearch(cleanPrompt) : Promise.resolve(null),
]);
```

New:
```js
const [memorySnapshot, rawHistory, savedTz, searchResults] = await Promise.all([
  buildContextMemory(cleanPrompt),
  redis.lrange(`${HIST_PREFIX}${chatId}`, 0, MAX_HIST_MSGS - 1).catch(e => { console.error('Redis history fetch failed:', e.message); return []; }),
  redis.get(TIMEZONE_KEY).catch(e => { console.error('Redis timezone fetch failed:', e.message); return null; }),
  (!isPhoto && needsWebSearch(cleanPrompt)) ? webSearch(cleanPrompt) : Promise.resolve(null),
]);
```

Note: `buildContextMemory` already handles its own errors and returns null on failure — no `.catch()` needed here.

**Step 3: Remove the now-redundant MAX_MEMORY_CHARS truncation block**

Find and delete these lines (around line 1268):
```js
// Truncate memory if too large — keeps token count manageable
const MAX_MEMORY_CHARS = 2000;
const trimmedMemory = memorySnapshot && memorySnapshot.length > MAX_MEMORY_CHARS
  ? memorySnapshot.slice(0, MAX_MEMORY_CHARS) + '\n\n[...memory truncated...]'
  : memorySnapshot;
```

Replace with:
```js
const trimmedMemory = memorySnapshot;
```

The 1000-char cap is now handled inside `buildContextMemory()`.

**Step 4: Verify syntax**
```bash
node -c api/webhook.js
```
Expected: `api/webhook.js syntax OK`

**Step 5: Smoke test — send a message to Remy and check logs**

Check Vercel function logs for:
- `[MEMORY] buildContextMemory failed` — should NOT appear
- `[AI] Calling GLM-4.5 | system: X chars` — system prompt should be noticeably shorter than before

**Step 6: Commit and push**
```bash
git add api/webhook.js
git commit -m "feat: wire buildContextMemory into message handler, remove full memory dump"
git push origin main
```
