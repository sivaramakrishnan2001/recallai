// Interview Agent — Main orchestrator for interview flow

import { callLLM } from "../llm/factory.js";
import { buildInterviewerPrompt } from "../tools/questionGenerator.js";
import { parseLLMResponse, recordScores } from "../tools/evaluator.js";
import { advancePhase } from "./stateMachine.js";
import { textToSpeech } from "../voice/tts.js";
import { isTimeExpired, isTimeAlmostUp, getRemainingMinutes, PHASE } from "../sessions/sessionManager.js";
async function retryWithBackoff(fn, maxAttempts = 3, baseDelay = 1000) {
  let lastError;
  for (let i = 1; i <= maxAttempts; i++) {
    try { return await fn(); } catch (err) {
      lastError = err;
      if (i < maxAttempts) await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i - 1)));
    }
  }
  throw lastError;
}

export async function getInterviewerResponse(session, candidateText) {
  // CHECK TIME IMMEDIATELY — Force close if expired
  if (isTimeExpired(session) && session.phase !== PHASE.CLOSING && session.phase !== PHASE.DONE) {
    session.phase = PHASE.CLOSING;
    const closingText = "We've reached the end of our interview time. Thank you for your time. We will evaluate your responses and share a report shortly. Do you have any quick questions?";
    const audio = await textToSpeech(closingText);
    session.history.push({
      role:    "assistant",
      content: closingText,
      phase:   PHASE.CLOSING,
    });
    return {
      audio,
      text: closingText,
      phase: PHASE.CLOSING,
      action: "close",
    };
  }

  // Build the prompt for this turn
  const systemPrompt = buildInterviewerPrompt(session);

  // Add candidate's response to history
  session.history.push({
    role:    "user",
    content: candidateText,
    phase:   session.phase,
  });

  // Call LLM with automatic retry on failure
  let llmRaw;
  try {
    llmRaw = await retryWithBackoff(
      () => callLLM(session.history, systemPrompt, 300),
      3, // max attempts
      1000 // base delay in ms
    );
  } catch (err) {
    console.error(`[Agent] LLM failed after retries: ${err.message}`);
    // Provide fallback response instead of crashing
    llmRaw = "[META] phase:unknown action:ask comm:0 tech:0 solve:0 exp:0 question:Can you clarify that response?";
  }

  // Parse the response
  const parsed = parseLLMResponse(llmRaw);

  // Record scores
  if (parsed.scores.communication > 0 || parsed.scores.technicalKnowledge > 0) {
    recordScores(session, parsed.scores);
  }

  // Record question asked
  if (parsed.question && parsed.action === "ask") {
    session.questionsAsked.push(parsed.question);
  }

  // Handle phase transitions based on LLM's indicated action
  if (parsed.phase && parsed.phase !== session.phase) {
    // Validate phase is in valid PHASE enum before setting
    const validPhases = Object.values(PHASE);
    if (validPhases.includes(parsed.phase)) {
      console.log(`[Agent] Phase transition: ${session.phase} → ${parsed.phase}`);
      session.phase = parsed.phase;
    } else {
      console.warn(`[Agent] LLM returned invalid phase: "${parsed.phase}". Ignoring.`);
    }
  }

  // TIME MANAGEMENT: If time < 2 minutes and not already warned, force transition to closing
  if (isTimeAlmostUp(session) && !session.timeWarningGiven && session.phase !== PHASE.CLOSING && session.phase !== PHASE.DONE) {
    session.timeWarningGiven = true;
    session.phase = PHASE.CLOSING;
    parsed.action = "transition";
    console.log(`[Agent] Time warning: ${getRemainingMinutes(session)} minute(s) remaining - forcing transition to closing`);
  }

  // TIME MANAGEMENT: If time expired, force to done
  if (isTimeExpired(session)) {
    session.phase = PHASE.CLOSING;
    session.done = true;
    parsed.action = "close";
    console.log(`[Agent] Time expired - closing interview`);
  }

  // Advance state machine based on action
  advancePhase(session, parsed.action);

  // Generate audio
  const audio = await textToSpeech(parsed.spokenText);

  // Add interviewer response to history
  session.history.push({
    role:    "assistant",
    content: parsed.spokenText,
    phase:   session.phase,
  });

  return {
    audio,
    text:   parsed.spokenText,
    phase:  session.phase,
    action: parsed.action,
  };
}

export async function getGreeting(session) {
  const systemPrompt = buildInterviewerPrompt(session);
  const greeting = `Start the interview. Greet ${session.candidateName} warmly as a real human would on a video call. Introduce yourself as Alex. Briefly explain you'll be covering ${session.interviewType} topics today. Then naturally ask them to walk you through their background. Sound like a real person — casual but professional. No stiff formal language.`;

  let greetingRaw;
  try {
    greetingRaw = await callLLM([{ role: "user", content: greeting }], systemPrompt, 250);
  } catch (err) {
    console.error(`[Agent] Greeting error: ${err.message}`);
    throw err;
  }

  const parsed = parseLLMResponse(greetingRaw);
  const audio = await textToSpeech(parsed.spokenText);

  session.history.push({
    role:    "assistant",
    content: parsed.spokenText,
    phase:   session.phase,
  });

  return {
    audio,
    text: parsed.spokenText,
  };
}

export async function getSilencePrompt(session) {
  // Varied, natural silence nudges — no robotic "I am waiting for your response"
  const prompts = [
    "Hey, take your time. No rush at all.",
    "Still there? Whenever you're ready.",
    "No worries, take a moment if you need it.",
    "It's okay to think it through — go ahead when you're set.",
    "I'm listening, just go whenever you're ready.",
    "Take your time, there's no pressure here.",
  ];

  // Avoid repeating the same prompt twice in a row
  const lastIdx = session._lastSilenceIdx ?? -1;
  let idx;
  do { idx = Math.floor(Math.random() * prompts.length); } while (idx === lastIdx && prompts.length > 1);
  session._lastSilenceIdx = idx;

  const text  = prompts[idx];
  const audio = await textToSpeech(text);
  return { audio, text };
}
