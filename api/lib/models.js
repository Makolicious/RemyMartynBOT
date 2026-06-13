const { anthropic } = require('@ai-sdk/anthropic');
const { generateText } = require('ai');

// ── Models — Claude only ──────────────────────────────────────────────────────
// ANTHROPIC_API_KEY is required. CHAT_MODEL handles interactive chat and any
// quality-sensitive task; MEMORY_MODEL is the fast/cheap model for utility work
// (fact extraction, relevance gating, inline answers).
const CHAT_MODEL   = anthropic(process.env.ANTHROPIC_CHAT_MODEL || 'claude-opus-4-8');
const MEMORY_MODEL = anthropic(process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[INIT] ANTHROPIC_API_KEY is not set — model calls will fail.');
} else {
  console.log(`[INIT] Claude models — chat: ${process.env.ANTHROPIC_CHAT_MODEL || 'claude-opus-4-8'}, fast: ${process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5'}`);
}

// ── Model routing ──────────────────────────────────────────────────────────────
// Single provider now, so there's no secondary fallback. Kept as a function so
// callers (chat.js, eval.js) keep a stable shape.
function pickModels() {
  return {
    primary:       CHAT_MODEL,
    primaryName:   'Claude',
    secondary:     null,
    secondaryName: null,
  };
}

// ── Adaptive response sizing ──────────────────────────────────────────────────
function analyzeQueryComplexity(query) {
  const questionWords = ['who', 'what', 'when', 'where', 'how', 'why'];
  const contextKeywords = ['explain', 'summarize', 'list'];
  const wordCount = query.trim().split(/\s+/).length;
  const hasQuestionWords = questionWords.some(w => query.toLowerCase().includes(w));
  const hasContextKeywords = contextKeywords.some(k => query.toLowerCase().includes(k));

  if (hasQuestionWords || hasContextKeywords) return { complexity: 'complex', maxTokens: 500 };
  if (wordCount > 30) return { complexity: 'medium', maxTokens: 300 };
  return { complexity: 'simple', maxTokens: 200 };
}

module.exports = {
  generateText,
  CHAT_MODEL,
  MEMORY_MODEL,
  pickModels,
  analyzeQueryComplexity,
};
