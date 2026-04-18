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

// ── Model routing — picks primary/secondary based on query ────────────────────
const SONNET_TRIGGERS = /\b(write|draft|essay|article|story|poem|script|report|proposal|plan|strategy|roadmap|analyze|analyse|analysis|breakdown|compare|contrast|research|explain|summarize|summarise|translate|code|function|algorithm|debug|refactor|build|create|design|list.*steps|step.by.step|pros.and.cons|in.depth|detailed|thorough|comprehensive|long.form)\b/i;

function pickModels(prompt, hasWebSearch) {
  const useSonnet = FALLBACK_MODEL && (hasWebSearch || (SONNET_TRIGGERS.test(prompt) && prompt.length > 40));
  return {
    primary:       useSonnet ? FALLBACK_MODEL : CHAT_MODEL,
    primaryName:   useSonnet ? 'Anthropic' : 'GLM-4-Plus',
    secondary:     useSonnet ? CHAT_MODEL : FALLBACK_MODEL,
    secondaryName: useSonnet ? 'GLM-4-Plus' : 'Anthropic',
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
