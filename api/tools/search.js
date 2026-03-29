const { z } = require('zod');

const SERPER_KEY = process.env.SERPER_API_KEY || '';

// ── Tool definition for AI SDK ────────────────────────────────────────────────
const searchWebTool = {
  description: 'Search the web for current information. Use when the user asks about news, prices, weather, current events, people, or anything that needs live data.',
  parameters: z.object({
    query: z.string().describe('The search query'),
  }),
  execute: async ({ query }) => {
    if (!SERPER_KEY) return { error: 'Web search not configured' };
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 5 }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { error: `Search failed: ${res.status}` };
      const data = await res.json();
      const answer  = data.answerBox?.answer || data.answerBox?.snippet || '';
      const organic = data.organic?.slice(0, 4).map(r => `${r.title}: ${r.snippet}`).join('\n') || '';
      const result = [answer, organic].filter(Boolean).join('\n\n');
      return { results: result || 'No results found' };
    } catch (err) {
      console.error('[TOOL:SEARCH] Failed:', err.message);
      return { error: err.message };
    }
  },
};

// Heuristic: does this message need live web data?
function needsWebSearch(text) {
  if (!SERPER_KEY) return false;
  const lower = text.toLowerCase();
  const conversational = /how are you|what'?s up|what do you think|why not|where were we|what about you|how'?s it going|how come you|what should i|how do you feel/i;
  if (conversational.test(lower)) return false;
  return /\b(who (is|was|are)|what (is|are|was|were|does)|when (did|is|was|does)|where (is|are|can|do)|how (to|much|many|does|do|did)|why (did|does|is|are|do)|latest|current|today|news|price|weather|stock|rate|score|search|look up|find|tell me about)\b/i.test(text);
}

module.exports = { searchWebTool, needsWebSearch };
