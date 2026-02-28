const { zai } = require('zhipu-ai-provider');
const { generateText } = require('ai');

const PLANNER_MODEL = zai('glm-4.5');

const PLANNER_SYSTEM = `You are a planning agent for Remy, a personal AI assistant.

Your job: break down user goals into clear, actionable steps.
Use provided memory for context about projects, goals, and preferences.

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
