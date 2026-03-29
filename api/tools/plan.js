const { z } = require('zod');
const { generateText, CHAT_MODEL } = require('../lib/models');
const memory = require('../memory');
const { redis, KEYS } = require('../lib/redis');

const PLANNER_SYSTEM = `You are a planning agent for Remy.

Break down user goals into 3-7 clear, actionable steps.
Use memory for context about projects, goals, preferences.

Return ONLY JSON:
{
  "title": "Short title",
  "steps": [
    { "id":1, "action": "Specific action", "estimatedTime": "15min" }
  ],
  "notes": "Optional advice"
}`;

// ── Plan a goal ───────────────────────────────────────────────────────────────
const planGoalTool = {
  description: 'Create a structured plan to achieve a goal. Use when the user asks you to plan something, break down a task, or create action steps.',
  parameters: z.object({
    goal: z.string().describe('The goal to plan for'),
  }),
  execute: async ({ goal }) => {
    try {
      const [memoryExport, timezone] = await Promise.all([
        memory.exportAsMarkdown(),
        redis.get(KEYS.TIMEZONE),
      ]);
      const currentDate = new Date().toISOString().split('T')[0];

      const result = await generateText({
        model: CHAT_MODEL,
        system: PLANNER_SYSTEM,
        prompt: `Goal: ${goal}\n\nContext:\n- Current Date: ${currentDate}\n- Timezone: ${timezone || 'UTC'}\n\nMemory:\n${memoryExport || 'No memory available yet.'}\n\nGenerate a plan. Return ONLY valid JSON with title, steps array (each with id, action, estimatedTime), and optional notes. 3-7 steps max.`,
        temperature: 0.7,
        maxTokens: 800,
      });

      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { error: 'Could not generate a plan' };

      const plan = JSON.parse(jsonMatch[0]);
      if (!plan.title || !plan.steps) return { error: 'Invalid plan structure' };

      plan.steps = plan.steps.map((step, idx) => ({
        id: step.id || idx + 1,
        action: step.action || 'Action not specified',
        estimatedTime: step.estimatedTime || '15min',
      }));

      return { plan };
    } catch (err) {
      return { error: err.message };
    }
  },
};

module.exports = { planGoalTool };
