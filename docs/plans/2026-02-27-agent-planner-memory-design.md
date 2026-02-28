# Agent Planner & Enhanced Memory Design

**Date:** 2026-02-27
**Project:** RemyMartynBOT
**Status:** Draft

---

## Executive Summary

This design outlines an incremental approach to evolving Remy from a personal AI assistant into a full AI agent system, starting with a Planner agent and enhanced table-based memory organization.

### Goals
1. Add planning capability: `/agent plan <goal>` → structured steps
2. Enhance memory with 20 table-based categories (double current)
3. Add Telegram formatter for table display
4. Maintain minimal token overhead (1 AI call per plan)

### Approach
- **Incremental:** Start with Planner only, add agents later if valuable
- **Low overhead:** Same token cost as normal chat (~1 AI call)
- **Opt-in:** Agent mode only triggers on `/agent` commands
- **Future-proof:** Architecture scales to full agent system

---

## 1. Overall Architecture

```
Telegram User
    ↓
Webhook (api/webhook.js)
    - Detect `/agent plan <goal>` command
    - Extract user goal
    ↓
Planner Endpoint (api/agent/planner.js)
    - Uses GLM-4.5 to break down goal into steps
    - Returns structured plan as JSON
    ↓
Webhook formats response for Telegram
```

**Key Design Decisions:**
- No orchestrator initially (simplifies)
- No task queue initially (avoids complexity)
- No worker process (minimal infrastructure)
- One AI call per plan (same as normal chat)

---

## 2. Planner Agent

### Location
`api/agent/planner.js`

### Input
```json
{
  "goal": "Plan my week for productivity",
  "context": {
    "memory": "remy_memory from Redis",
    "timezone": "remy_boss_timezone",
    "currentDate": "2026-02-27"
  }
}
```

### Output
```json
{
  "title": "Productive Week Plan",
  "steps": [
    {
      "id": 1,
      "action": "Review and prioritize existing projects",
      "estimatedTime": "15min"
    },
    {
      "id": 2,
      "action": "Schedule focused deep work blocks",
      "estimatedTime": "30min"
    },
    {
      "id": 3,
      "action": "Set up calendar reminders for key tasks",
      "estimatedTime": "10min"
    },
    {
      "id": 4,
      "action": "Plan daily check-ins to track progress",
      "estimatedTime": "5min"
    }
  ],
  "notes": "Start with the highest-impact project first thing Monday morning."
}
```

### System Prompt
```
You are a planning agent for Remy, a personal AI assistant.
Your job: break down user goals into clear, actionable steps.
Use the provided memory for context about projects, goals, and preferences.
Return a JSON response with title, steps (with estimated time), and notes.
Keep steps practical and achievable.
```

---

## 3. Enhanced Memory System

### Table-Based Organization (20 Categories)

| # | Category | Columns |
|---|----------|---------|
| 1 | Boss Profile | Name, Location, Role/Title, Birthday |
| 2 | Personality & Traits | Trait, Description, Intensity |
| 3 | Goals & Aspirations | Goal, Category, Priority, Status |
| 4 | Habits & Routines | Habit, Frequency, Time, Notes |
| 5 | Skills & Expertise | Skill, Level, Experience, Last Used |
| 6 | Friends & Contacts | Name, Relationship, Last Contact, Key Info |
| 7 | Family Members | Name, Relation, Birthday/Key Dates, Notes |
| 8 | Business Associates | Name, Role, Company/Context, Relationship Status |
| 9 | Active Projects | Project, Phase, Deadline, Progress, Notes |
| 10 | Business Ideas & Ventures | Idea, Status, Potential, Next Steps |
| 11 | Food & Drink Preferences | Item, Type, Preference, Notes |
| 12 | Technology & Tools | Tool/Service, Purpose, Proficiency, Notes |
| 13 | Entertainment Preferences | Category, Favorites, Dislikes, Notes |
| 14 | Work Style & Environment | Aspect, Preference, Current State |
| 15 | Communication Style | Channel, Preference, Response Time, Notes |
| 16 | Travel & Places | Location, Type, Visited?, Notes |
| 17 | Key Dates & Milestones | Date, Event, Type, Reminder Set? |
| 18 | Decisions & Commitments | Decision, Date, Status, Notes |
| 19 | Pending Action Items | Task, Priority, Due Date, Status |
| 20 | Notes & Miscellaneous | Category, Entry, Date |

### Storage Format
```markdown
# Remy's Memory Tables

## 1. Boss Profile
| Field | Value |
|-------|-------|
| Name | [Name] |
| Location | [City/Country] |
...
```

---

## 4. Telegram Formatter

### Location
`api/utils/formatter.js`

### Purpose
Convert table-based memory into readable text for Telegram (doesn't render markdown tables).

### Example Transformation

**Input (table):**
```markdown
| Project | Phase | Deadline | Progress | Notes |
|----------|-------|----------|----------|-------|
| Project A | Planning | Q2 | 0% | Initial research |
```

**Output (Telegram):**
```text
📁 Active Projects
┌─────────────────────────────────────────────┐
│ 📦 Project A  •  Planning  •  Due: Q2    │
│    └─ Initial research                   │
└─────────────────────────────────────────────┘
```

### Key Features
- Table parser for markdown tables
- Row formatter with emoji decorations
- Section pagination (display specific tables)
- Empty table handling (skip if no data)

---

## 5. API Endpoints

### POST `/api/agent/planner`
Generate plan from goal.

**Request:**
```json
{
  "goal": "Plan my week for productivity",
  "context": { "memory": "...", "timezone": "...", "currentDate": "..." }
}
```

**Response:**
```json
{ "title": "...", "steps": [...], "notes": "..." }
```

### GET `/api/memory/view`
Get formatted memory for display.

### POST `/api/memory/update`
Update memory (AI + manual).

---

## 6. Webhook Integration

### Command Detection
```javascript
if (msg.text?.startsWith('/agent plan ')) {
  const goal = msg.text.substring('/agent plan '.length);
  const plan = await planGoal(goal, msg.from.id);
  await bot.sendMessage(chatId, formatPlanForTelegram(plan));
  return;
}
```

---

## 7. Error Handling

| Error Type | Handling |
|------------|----------|
| AI API timeout | Retry once, then return friendly error |
| Invalid goal | Ask user to clarify |
| Rate limit | Queue request, notify user of delay |
| Memory missing | Use default empty memory |

---

## 8. Token Cost Analysis

| Interaction | AI Calls | Notes |
|-------------|-----------|-------|
| Normal chat | 1 | Unchanged |
| `/agent plan` | 1 | Same as normal chat |
| Future: Research agent | +1 | Add later if needed |
| Future: Full orchestrator | 3-5 | Add later if valuable |

**Conclusion:** No token increase for initial implementation.

---

## 9. Future Scaling Path

### Phase 2: Research Agent
- `/agent research <topic>` → gathers info, returns summary
- +1 AI call

### Phase 3: Auto-Execution
- User says "execute step 1"
- Agent performs action
- Rate limiting becomes relevant

### Phase 4: Full Orchestrator
- Only if previous phases successful
- Then consider full orchestrator architecture

---

## 10. Implementation Checklist

- [ ] Create `api/agent/planner.js` - Planner endpoint
- [ ] Create `api/utils/formatter.js` - Telegram table formatter
- [ ] Update `api/webhook.js` - Add `/agent plan` command
- [ ] Update `api/webhook.js` - Replace `EMPTY_MEMORY` with 20 tables
- [ ] Update `api/admin.js` - Use formatter for memory display
- [ ] Test `/agent plan` command
- [ ] Test table formatter output
- [ ] Verify token usage (should be ~1 call per plan)

---

## 11. Success Criteria

1. `/agent plan <goal>` returns structured steps
2. Steps are relevant and actionable
3. No token cost increase vs normal chat
4. Tables display cleanly in Telegram
5. Memory can be updated with new structure
6. Admin dashboard renders tables correctly

---

**End of Design Document**
