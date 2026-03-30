// LLM Factory — Provider abstraction and switching
// Supports: OpenAI, AWS Bedrock, fallback

import { callOpenAI } from "./openai.js";
import { callBedrock, getBedrockClient } from "./bedrock.js";
import { callFallback } from "./fallback.js";

const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";
let cachedCallable = null; // Cache the provider function for performance

export async function initializeProvider() {
  if (LLM_PROVIDER === "bedrock") {
    await getBedrockClient();
  }
  // Pre-select the callable to avoid conditional on every request
  selectProvider();
}

function selectProvider() {
  if (LLM_PROVIDER === "bedrock") {
    cachedCallable = callBedrock;
  } else if (LLM_PROVIDER === "openai") {
    cachedCallable = callOpenAI;
  } else {
    cachedCallable = callFallback;
  }
}

/**
 * Call LLM using cached provider function — Eliminates conditionals per call
 */
export async function callLLM(messages, systemPrompt, maxTokens = 500) {
  try {
    // Use cached provider function (no if/else per request)
    if (!cachedCallable) selectProvider();
    return await cachedCallable(messages, systemPrompt, maxTokens);
  } catch (err) {
    console.error(`[LLM] Provider error: ${err.message}`);
    throw err;
  }
}

export function getActiveProvider() {
  return LLM_PROVIDER;
}
