# Design: Smarter Conversations

**Date:** 2026-03-02

## Problem

Two sources of token waste in every Remy message:

1. **History bloat** — 8 raw messages sent verbatim to the AI. A 500-char assistant response from 4 exchanges ago takes the same token space as the latest reply.
2. **False-positive web searches** — `needsWebSearch()` triggers on bare "how", "what", "why", "where", causing Serper API calls on conversational messages like "how are you?" or "what do you think?"

## Feature 1: History Compression

**Approach:** No AI calls. Pure string truncation at parse time.

- Last 4 messages (2 exchanges) — full length, untouched
- Older 4 messages (indices 0-3 after reverse) — truncated to first 120 chars, suffixed with `...`
- Applied right after `const history = rawHistory.map(e => JSON.parse(e)).reverse()`

**Token impact:** ~40-50% reduction in history tokens on average.

## Feature 2: Smarter Web Search Triggers

**Approach:** Replace the broad single regex with a tighter pattern that requires factual follow-up words for common question words.

**Current triggers (too broad):**
`who|what|when|where|how|why|latest|current|today|news|price|weather|stock|rate|score|search|look up|find|tell me about`

**New triggers:**
- Factual patterns: `who is|who was|what is|what are|what was|when did|when is|when was|where is|where can|how to|how much|how many|how does|how do|why did|why does|why is`
- Direct search intents: `latest|current|today|news|price|weather|stock|rate|score|search|look up|find|tell me about`

**Conversational blocklist** (never triggers search even if regex matches):
`how are you|what's up|what do you think|why not|where were we|what about you|how's it going|how come you|what should i`

## Files Changed

- `api/webhook.js`
  - Add history compression pass after `rawHistory.map().reverse()`
  - Replace `needsWebSearch()` regex with tighter patterns + blocklist

## Impact

- History tokens: ~40-50% reduction
- Web search: fewer false-positive Serper calls
- AI calls: 0 new calls added
