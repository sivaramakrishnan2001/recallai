// Fallback LLM — Template-based responses for testing/fallback

const FALLBACK_RESPONSES = [
  "That's interesting. Can you tell me more about that?",
  "I see. How did that experience help you grow as a professional?",
  "That makes sense. What was the most challenging part?",
  "Impressive. What would you do differently if you faced that again?",
  "Thanks for sharing. How did you approach problem-solving in that situation?",
];

let responseIndex = 0;

export function callFallback(messages, systemPrompt) {
  // Return a rotating template response
  const response = FALLBACK_RESPONSES[responseIndex % FALLBACK_RESPONSES.length];
  responseIndex++;
  return response;
}
