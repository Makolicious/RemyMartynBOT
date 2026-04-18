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

// Safety filter — block harmful/explicit visual queries
const BLOCKED_VISUAL_PATTERNS = /\b(gore|gory|murder|kill|dead bod|corpse|mutilat|dismember|beheading|execution|torture|self.?harm|suicide|cut(?:ting)?\s+(?:my|your|their)|nude|naked|nsfw|porn|hentai|sex(?:ual)?|erotic|xxx|child|minor|underage|bomb.?making|how\s+to\s+(?:make|build)\s+(?:a\s+)?(?:bomb|weapon|explosive)|drug\s+(?:cook|mak|synthe)|terrorist|extremis|white\s+suprem|nazi|swastika)\b/i;

// Image search via Serper.dev
async function imageSearch(query) {
  if (!SERPER_KEY) return null;
  if (BLOCKED_VISUAL_PATTERNS.test(query)) {
    console.log(`[VISUAL] Blocked unsafe query: "${query.slice(0, 50)}"`);
    return null;
  }
  try {
    const res = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5, safe: 'active' }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const images = data.images || [];
    const good = images.find(img =>
      img.imageUrl && !img.imageUrl.endsWith('.svg') && img.imageWidth > 200
    ) || images[0];
    if (!good?.imageUrl) return null;
    return { url: good.imageUrl, title: good.title || '', source: good.source || '' };
  } catch (err) {
    console.error('[SEARCH] Image search failed:', err.message);
    return null;
  }
}

// Detect visual/image/map requests
function detectVisualRequest(text) {
  const lower = text.toLowerCase();
  const mapMatch = lower.match(/(?:show|send|get|give|pull up|display|find)\s+(?:me\s+)?(?:a\s+)?(?:map|satellite view|street view|directions?)\s+(?:of|to|for|from|around|near)\s+(.+)/i)
    || lower.match(/(?:map|satellite view|street view)\s+(?:of|to|for)\s+(.+)/i);
  if (mapMatch) return { type: 'map', query: mapMatch[1].replace(/[?.!]+$/, '').trim() };

  const imgMatch = lower.match(/(?:show|send|get|give|find|pull up|display)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:photo|picture|image|pic|img)\s+(?:of|about|showing)\s+(.+)/i)
    || lower.match(/(?:show|send|get|give|find|pull up|display)\s+(?:me\s+)?(?:what|how)\s+(?:a\s+|an\s+)?(.+?)(?:\s+looks?\s+like)/i)
    || lower.match(/(?:let(?:'?s| me| us)\s+see|i (?:want|wanna) (?:to )?see)\s+(?:the\s+|a\s+|an\s+)?(.+)/i)
    || lower.match(/(?:show|send|get|give|find|pull up|display)\s+(?:me\s+)(.+)/i);
  if (imgMatch) {
    const query = imgMatch[1].replace(/[?.!]+$/, '').trim();
    if (/\b(schedule|reminder|memory|memories|history|setting|log|cron|job|status|what you|how you)\b/i.test(query)) return null;
    return { type: 'image', query };
  }
  return null;
}

// Heuristic: does this message need live web data?
function needsWebSearch(text) {
  if (!SERPER_KEY) return false;
  const lower = text.toLowerCase();
  // Block short greetings and casual messages — these are NOT search requests
  if (text.trim().length < 15) return false;
  const conversational = /how are you|what'?s up|what do you think|why not|where were we|what about you|how'?s it going|how come you|what should i|how do you feel|what'?s good|yo+|hey+|sup|hi+|hello/i;
  if (conversational.test(lower)) return false;
  return /\b(who (is|was|are)|what (is|are|was|were|does)|when (did|is|was|does)|where (is|are|can|do)|how (to|much|many|does|do|did)|why (did|does|is|are|do)|latest|current|today|news|price|weather|stock|rate|score|search|look up|find|tell me about)\b/i.test(text);
}

module.exports = { searchWebTool, needsWebSearch, imageSearch, detectVisualRequest, BLOCKED_VISUAL_PATTERNS };
