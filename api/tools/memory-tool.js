const { z } = require('zod');
const memory = require('../memory');

// ── Save a fact to memory ─────────────────────────────────────────────────────
const saveMemoryTool = {
  description: 'Save an important fact about the user to long-term memory. Use when the user shares personal info, preferences, decisions, goals, contacts, or anything worth remembering for future conversations.',
  parameters: z.object({
    fact: z.string().describe('The fact to remember, as a concise statement'),
    category: z.string().describe(`Category: one of ${memory.CATEGORIES.join(', ')}`),
  }),
  execute: async ({ fact, category }) => {
    try {
      const result = await memory.smartAddMemory(fact, category, 85);
      return { success: true, action: result.action, id: result.memory.id };
    } catch (err) {
      return { error: err.message };
    }
  },
};

// ── Search memory for relevant facts ──────────────────────────────────────────
const recallMemoryTool = {
  description: 'Search your memory for facts about the user. Use when you need context about their preferences, projects, contacts, or past decisions.',
  parameters: z.object({
    query: z.string().describe('What to search for in memory'),
  }),
  execute: async ({ query }) => {
    try {
      const results = await memory.semanticSearch(query, 8);
      if (!results.length) return { results: [], message: 'Nothing found' };
      return {
        results: results.map(m => ({
          content: m.content,
          category: m.category,
          importance: m.importance.toFixed(0),
        })),
      };
    } catch (err) {
      return { error: err.message };
    }
  },
};

module.exports = { saveMemoryTool, recallMemoryTool };
