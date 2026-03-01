# Adaptive Response System for RemyMartynBOT Implementation Plan

## Goal
Make Remy's responses adaptive based on query complexity instead of always using a fixed system prompt. This will make Remy smarter by adjusting response length dynamically.

## Architecture

### Current State
- Remy uses `zai('glm-4.5')` model for chat responses
- System prompt is hardcoded: "Answer in 1-3 sentences. No fluff."
- No `maxTokens` parameter specified (uses model default)
- Response generated in `api/webhook.js` around line 654-672

### New Design
- Add complexity analyzer function
- Dynamically adjust system prompt based on detected complexity
- Set `maxTokens` parameter accordingly
- Keep responses concise but allow longer responses for complex queries

## Tech Stack
- Node.js (already in use)
- `ai` package for AI calls (already in use)
- `zhipu-ai-provider` for zai model (already in use)

## Implementation Tasks

### Task 1: Add Complexity Analyzer Function

**Files to modify:**
- `api/webhook.js`

**Description:**
Create a helper function that analyzes user query and determines:
- Word count (simple: <10, medium: 10-30, complex: >30)
- Presence of question words (who, what, when, where, how, why) → marks as complex
- Presence of context keywords (explain, summarize, list) → marks as complex

**Implementation:**
```javascript
// Add near top of webhook.js, after existing constants
function analyzeQueryComplexity(query) {
  const questionWords = ['who', 'what', 'when', 'where', 'how', 'why'];
  const contextKeywords = ['explain', 'summarize', 'list'];

  const wordCount = query.trim().split(/\s+/).length;
  const hasQuestionWords = questionWords.some(word => query.toLowerCase().includes(word));
  const hasContextKeywords = contextKeywords.some(keyword => query.toLowerCase().includes(keyword));

  // Determine complexity
  let complexity;
  let maxTokens;

  if (hasQuestionWords || hasContextKeywords) {
    complexity = 'complex';
    maxTokens = 500;
  } else if (wordCount > 30) {
    complexity = 'medium';
    maxTokens = 300;
  } else {
    complexity = 'simple';
    maxTokens = 200;
  }

  return { complexity, maxTokens };
}
```

**Testing:**
- Manually test with various queries to verify complexity detection
- Console log complexity level for debugging

---

### Task 2: Modify Response Generator

**Files to modify:**
- `api/webhook.js`

**Description:**
Update the `handleInlineQuery` function to use the complexity analyzer and generate dynamic system prompts.

**Implementation:**
```javascript
// Find the handleInlineQuery function (around line 654)
async function handleInlineQuery(query, res) {
  // ... existing auth checks ...

  // Analyze query complexity
  const { complexity, maxTokens } = analyzeQueryComplexity(queryText);

  // Generate dynamic system prompt based on complexity
  let systemPrompt;
  if (complexity === 'simple') {
    systemPrompt = `You are Remy — a sharp, concise AI assistant. Answer in 1-2 sentences. No fluff.`;
  } else if (complexity === 'medium') {
    systemPrompt = `You are Remy — a sharp, concise AI assistant. Answer in 2-3 sentences. No fluff.`;
  } else {
    systemPrompt = `You are Remy — a sharp, concise AI assistant. Answer in 3-5 sentences. No fluff.`;
  }

  // Generate response with adjusted maxTokens
  const { text: answer } = await generateText({
    model: CHAT_MODEL,
    system: systemPrompt,
    messages: [{ role: 'user', content: queryText }],
    maxTokens: maxTokens,
    temperature: 0.7,
    abortSignal: AbortSignal.timeout(8000),
  });

  // ... rest of response handling (logging, sending to Telegram)
}
```

**Testing:**
- Test with simple query ("hi", "hello")
- Test with medium query ("tell me about yourself")
- Test with complex query ("explain how the memory system works and what each component does")
- Verify maxTokens are being applied correctly (check logs)

---

### Task 3: Add Logging

**Files to modify:**
- `api/webhook.js`

**Description:**
Add console logging to track complexity detection and maxTokens usage for debugging.

**Implementation:**
```javascript
// Add to handleInlineQuery function, before generateText call
console.log(`[RESPONSE] Complexity: ${complexity}, maxTokens: ${maxTokens}, Query: "${queryText.slice(0, 50)}"`);
```

**Testing:**
- Check Vercel logs to verify logging is working
- Observe complexity levels in real usage

---

### Task 4: Create Test Documentation

**Files to create:**
- None (document in this plan)

**Description:**
Create a simple test plan document in the codebase.

**Test Cases:**
1. Simple queries (under 10 words) → expect short response
2. Medium queries (10-30 words) → expect medium response
3. Complex queries (over 30 words) → expect long response

**Verification:**
- Deploy changes
- Test each category of queries
- Verify responses match expected complexity

---

## Summary

**Total Tasks:** 4
**Estimated Time:** 20-30 minutes
**Risk Level:** Low (backward compatible, can be reverted if needed)

## Execution

After completing this plan, Remy will adapt its response length based on query complexity:
- Simple: Short responses (1-2 sentences, ~200 tokens)
- Medium: Medium responses (2-3 sentences, ~300 tokens)
- Complex: Longer responses (3-5 sentences, ~500 tokens)
