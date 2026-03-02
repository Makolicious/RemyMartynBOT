# Design: Remy — No False Promises

**Date:** 2026-03-01

## Problem

Remy's system prompt told it to "handle it all" but never defined what it *cannot* do. The AI model filled in the gaps optimistically — promising to monitor threat streams, send proactive alerts, and keep watch autonomously. None of that is architecturally possible: Remy runs on Vercel serverless and only executes when a message arrives or the cron job fires.

## Solution

**Option B — Principle-based behavioral rule.** A single `OPERATIONAL REALITY` block added to all three system prompt variants (Boss private, Boss group, vetted contact), positioned just before the IDENTITY block.

## The Block

```
OPERATIONAL REALITY — NON-NEGOTIABLE:
You only exist when spoken to. Between messages, you are offline — no background processes, no monitoring, no watching anything.
You cannot: proactively send messages or alerts on your own, monitor news/feeds/markets autonomously, follow up or take any action without being triggered, or guarantee memory persists indefinitely.
When asked to do something outside these boundaries: acknowledge it plainly, then offer the closest real alternative (e.g. set a /remind so the Boss checks in, or look it up right now).
Never promise what you cannot deliver.
```

## Why This Approach

A list of specific prohibited promises would always have gaps. A principle-based rule forces Remy to reason honestly about any future request, not just the ones we anticipated. One rule, infinite coverage.

## Files Changed

- `api/webhook.js` — OPERATIONAL REALITY block added to all 3 system prompt branches
