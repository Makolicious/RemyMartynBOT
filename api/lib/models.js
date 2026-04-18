const { zai } = require('zhipu-ai-provider');
const { generateText } = require('ai');

const CHAT_MODEL    = zai('glm-4-plus');
const UTILITY_MODEL = zai('glm-5');

let FALLBACK_MODEL = null;
let MEMORY_MODEL = null;
if (process.env.ANTHROPIC_API_KEY) {
  const { anthropic } = require('@ai-sdk/anthropic');
  const chatModel = process.env.ANTHROPIC_CHAT_MODEL || 'claude-sonnet-4-6';
  const fastModel = process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5';
  FALLBACK_MODEL = anthropic(chatModel);
  MEMORY_MODEL = anthropic(fastModel);
  console.log(`[INIT] Anthropic models — chat: ${chatModel}, memory: ${fastModel}`);
}

// ── Model routing — Anthropic is primary for all interactive chat ─────────────
function pickModels(prompt, hasWebSearch) {
  if (FALLBACK_MODEL) {
    // Anthropic is always primary for interactive chat — reliable tool use
    return {
      primary:       FALLBACK_MODEL,
      primaryName:   'Anthropic',
      secondary:     CHAT_MODEL,
      secondaryName: 'GLM-4-Plus',
    };
  }
  // No Anthropic key — GLM only
  return {
    primary:       CHAT_MODEL,
    primaryName:   'GLM-4-Plus',
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
  UTILITY_MODEL,
  FALLBACK_MODEL,
  MEMORY_MODEL,
  pickModels,
  analyzeQueryComplexity,
};
