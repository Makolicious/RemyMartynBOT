# Design: Context-Aware Memory Injection

**Date:** 2026-03-01

## Problem

Every message injects a full `exportAsMarkdown()` dump — up to 2000 chars of every memory across all 20 categories — into the system prompt, regardless of what's being discussed. Most of it is irrelevant to the current conversation. This wastes tokens on every single call.

## Solution

**Hybrid injection:** always include PERMANENT_CATEGORIES (identity-critical facts) + dynamically fill the rest with `searchMemories()` results relevant to the current message. Render as compact `key: value` pairs instead of verbose markdown tables.

## Design

### New function: `buildContextMemory(currentMessage)`

Located in `api/webhook.js`. Replaces the `memory.exportAsMarkdown()` call in the main `Promise.all` fetch.

**Steps:**
1. Run two calls in parallel:
   - `getMemoriesByCategory(cat, 3)` for each of the 5 PERMANENT_CATEGORIES — top 3 per category
   - `searchMemories(currentMessage, 8)` — top 8 keyword-matched memories for the current topic
2. Merge results, deduplicate by memory ID
3. Format as compact single-line strings grouped by category
4. Cap output at 1000 chars

### Output format

```
[Boss Profile] Name: Marcos | Location: Buenos Aires | Role: Entrepreneur
[Goals & Aspirations] Scale RemyMartynBOT | Learn kitesurfing by Q3
[Family Members] Wife: Sofia | Son: Luca (3yo)
[Search match] Prefers direct communication | Hates emojis | Uses Telegram daily
```

### What stays the same

- `exportAsMarkdown()` is untouched — still used by `/memory`, `/rebuildmemory`, `/memexport`, `planGoal()`
- `searchMemories()` is untouched
- `getMemoriesByCategory()` is untouched
- All three system prompt variants use `trimmedMemory` — only the fetch + format changes

## Files Changed

- `api/webhook.js`
  - Add `buildContextMemory(message)` async function
  - Replace `memory.exportAsMarkdown()` in main `Promise.all` with `buildContextMemory(cleanPrompt)`
  - Update `MAX_MEMORY_CHARS` cap from 2000 to 1000

## Token Impact

| Before | After |
|--------|-------|
| ~2000 chars always | ~400-600 chars typical |
| All 20 categories | 5 permanent + up to 8 relevant |
| Verbose markdown tables | Compact key:value lines |
