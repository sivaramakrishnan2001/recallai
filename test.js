// =============================================================================
// AI Interview Bot — Test Suite
// Focus: conversations must sound like a real human senior engineer,
//        not a robotic AI assistant.
// Run: node server/test.js
// =============================================================================

import assert from "assert";

import {
  createSession, getSession, hasSession, deleteSession, PHASE,
  getRemainingMinutes, isTimeAlmostUp, isTimeExpired,
} from "./sessions/sessionManager.js";

import { advancePhase } from "./agent/stateMachine.js";
import { parseLLMResponse, recordScores, generateReport, avg } from "./tools/evaluator.js";
import { buildInterviewerPrompt } from "./tools/questionGenerator.js";
import { scheduleInterviewBot, calculateBotJoinTime, parseResume } from "./tools/botScheduler.js";
import { getSilencePrompt } from "./agent/interviewAgent.js";

// ── Runner ───────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

function makeSession(id, cfg = {}) {
  return createSession(id, {
    candidateName: "Jane Smith",
    role: "Senior Backend Engineer",
    difficulty: "medium",
    interviewType: "mixed",
    ...cfg,
  });
}
const clean = (...ids) => ids.forEach(deleteSession);

// ─────────────────────────────────────────────────────────────────────────────
// 1. HUMAN-LIKE CONVERSATION QUALITY
//    The prompt must instruct natural speech and ban robotic patterns.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Conversation Quality (Human vs Robot) ──────────────────────\n");

test("prompt instructs Alex to sound like a real human, not AI", () => {
  const s = makeSession("q-1");
  const p = buildInterviewerPrompt(s);
  assert(p.includes("You are NOT an AI") || p.includes("real human") || p.includes("real person"));
  clean("q-1");
});

test("prompt bans 'Thank you for your response'", () => {
  const s = makeSession("q-2");
  const p = buildInterviewerPrompt(s);
  assert(p.toLowerCase().includes("thank you for your response"));
  // Must appear in the BANNED section (preceded by ✗ or NEVER)
  const banIdx  = p.indexOf("NEVER DO THESE");
  const phraseIdx = p.indexOf("Thank you for your response");
  assert(phraseIdx > banIdx, "Phrase must appear in the banned section");
  clean("q-2");
});

test("prompt bans 'That is a great answer'", () => {
  const s = makeSession("q-3");
  const p = buildInterviewerPrompt(s);
  const banIdx  = p.indexOf("NEVER DO THESE");
  const phraseIdx = p.toLowerCase().indexOf("great answer");
  assert(phraseIdx > banIdx, "Must be in banned section");
  clean("q-3");
});

test("prompt bans 'Now I will ask you about'", () => {
  const s = makeSession("q-4");
  const p = buildInterviewerPrompt(s);
  const banIdx  = p.indexOf("NEVER DO THESE");
  const phraseIdx = p.indexOf("Now I will ask you about");
  assert(phraseIdx > banIdx, "Must be in banned section");
  clean("q-4");
});

test("prompt bans question numbering like 'Question 3 of 5'", () => {
  const s = makeSession("q-5");
  const p = buildInterviewerPrompt(s);
  const banIdx = p.indexOf("NEVER DO THESE");
  const numIdx = p.indexOf("Question 3 of 5");
  assert(numIdx > banIdx, "Question numbering must be banned");
  clean("q-5");
});

test("prompt instructs Alex to acknowledge previous answer before asking", () => {
  const s = makeSession("q-6");
  const p = buildInterviewerPrompt(s);
  assert(
    p.includes("Acknowledge what the candidate just said") ||
    p.includes("Reference something specific they mentioned"),
    "Prompt must instruct acknowledgment of previous answers"
  );
  clean("q-6");
});

test("prompt provides natural filler words to use", () => {
  const s = makeSession("q-7");
  const p = buildInterviewerPrompt(s);
  // Prompt should list natural fillers
  assert(p.includes("Hmm") || p.includes("Got it") || p.includes("Fair enough"));
  clean("q-7");
});

test("prompt requires asking ONE question at a time", () => {
  const s = makeSession("q-8");
  const p = buildInterviewerPrompt(s);
  assert(p.includes("ONE") || p.includes("one question at a time"));
  clean("q-8");
});

test("prompt gives a GOOD response example with natural acknowledgment", () => {
  const s = makeSession("q-9");
  const p = buildInterviewerPrompt(s);
  assert(p.includes("GOOD response") || p.includes("Example of a GOOD"));
  clean("q-9");
});

test("prompt gives a BAD response example showing robotic speech", () => {
  const s = makeSession("q-10");
  const p = buildInterviewerPrompt(s);
  assert(p.includes("BAD response") || p.includes("Example of a BAD"));
  clean("q-10");
});

test("prompt instructs natural phase transitions (not robotic)", () => {
  const s = makeSession("q-11");
  const p = buildInterviewerPrompt(s);
  assert(
    p.includes("shift gears") || p.includes("Let's move on") || p.includes("naturally"),
    "Transitions must sound natural"
  );
  clean("q-11");
});

test("prompt bans 'As an AI'", () => {
  const s = makeSession("q-12");
  const p = buildInterviewerPrompt(s);
  const banIdx = p.indexOf("NEVER DO THESE");
  const aiIdx  = p.indexOf("As an AI");
  assert(aiIdx > banIdx, "Must be in banned section");
  clean("q-12");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. RESUME-BASED PERSONALISATION
//    Questions must reference the actual resume, not be generic.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Resume-Based Personalisation ───────────────────────────────\n");

test("prompt includes candidate resume text verbatim", () => {
  const s = makeSession("r-1", { resume: "Led migration of monolith to microservices at Stripe using Go and Kafka" });
  const p = buildInterviewerPrompt(s);
  assert(p.includes("Led migration of monolith to microservices at Stripe"));
  clean("r-1");
});

test("prompt instructs to ask about SPECIFIC resume items, not generic", () => {
  const s = makeSession("r-2", { resume: "Worked on payment processing systems" });
  const p = buildInterviewerPrompt(s);
  assert(
    p.includes("specific") || p.includes("SPECIFIC"),
    "Prompt must instruct specific resume-based questions"
  );
  clean("r-2");
});

test("prompt warns NOT to ask generic questions when resume is provided", () => {
  const s = makeSession("r-3", { resume: "10 years Python, FastAPI, AWS" });
  const p = buildInterviewerPrompt(s);
  assert(
    p.includes("Do NOT ask generic") || p.includes("not ask generic") || p.includes("NOT ask"),
    "Must discourage generic questions when resume is provided"
  );
  clean("r-3");
});

test("prompt mentions candidate name in greeting instructions", () => {
  const s = makeSession("r-4", { candidateName: "Marcus Lee" });
  const p = buildInterviewerPrompt(s);
  assert(p.includes("Marcus Lee"));
  clean("r-4");
});

test("prompt includes role in resume context", () => {
  const s = makeSession("r-5", { role: "Staff Infrastructure Engineer" });
  const p = buildInterviewerPrompt(s);
  assert(p.includes("Staff Infrastructure Engineer"));
  clean("r-5");
});

test("prompt handles no-resume gracefully with generic fallback instruction", () => {
  const s = makeSession("r-6", { resume: null });
  const p = buildInterviewerPrompt(s);
  assert(p.includes("No resume provided"));
  clean("r-6");
});

test("previously asked questions are listed to prevent repetition", () => {
  const s = makeSession("r-7");
  s.questionsAsked = ["Tell me about your Redis experience?", "How did you handle cache invalidation?"];
  const p = buildInterviewerPrompt(s);
  assert(p.includes("Tell me about your Redis experience?"));
  assert(p.includes("How did you handle cache invalidation?"));
  clean("r-7");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SILENCE PROMPTS — Varied, Natural, Non-Repetitive
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Silence Prompts (Natural & Varied) ─────────────────────────\n");

await testAsync("silence prompt returns text and audio fields", async () => {
  const s = makeSession("sp-1");
  const r = await getSilencePrompt(s);
  assert(typeof r.text === "string" && r.text.length > 0);
  // audio may be null if ELEVENLABS_API_KEY not set — that's fine
  clean("sp-1");
});

await testAsync("silence prompts are varied — two consecutive calls differ", async () => {
  const s = makeSession("sp-2");
  // Run many times to check variety
  const texts = new Set();
  for (let i = 0; i < 10; i++) {
    const r = await getSilencePrompt(s);
    texts.add(r.text);
  }
  assert(texts.size >= 2, `Only got ${texts.size} unique silence prompt(s) — need variety`);
  clean("sp-2");
});

await testAsync("silence prompts do NOT contain robotic phrases", async () => {
  const s = makeSession("sp-3");
  const roboticPhrases = [
    "please provide",
    "i am waiting",
    "your response is required",
    "please respond",
    "please answer",
  ];
  for (let i = 0; i < 6; i++) {
    const r = await getSilencePrompt(s);
    const lower = r.text.toLowerCase();
    for (const phrase of roboticPhrases) {
      assert(!lower.includes(phrase), `Robotic phrase found: "${phrase}" in "${r.text}"`);
    }
  }
  clean("sp-3");
});

await testAsync("silence prompt does NOT repeat same text back to back", async () => {
  const s = makeSession("sp-4");
  let last = "";
  let repeatCount = 0;
  for (let i = 0; i < 8; i++) {
    const r = await getSilencePrompt(s);
    if (r.text === last) repeatCount++;
    last = r.text;
  }
  assert(repeatCount <= 1, `Silence prompt repeated consecutively ${repeatCount} times`);
  clean("sp-4");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. LLM RESPONSE PARSING — Natural speech preserved
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── LLM Response Parsing ───────────────────────────────────────\n");

test("natural acknowledgment + question is preserved in spokenText", () => {
  const raw = "Right, so the Redis cluster handled invalidation — that's a common pain point. How did you handle cache warming after a cold start?\n[META] phase:technical action:ask comm:7 tech:8 solve:7 exp:8 question:How did you handle cache warming after a cold start?";
  const p = parseLLMResponse(raw);
  assert(p.spokenText.includes("Redis cluster"));
  assert(p.spokenText.includes("cache warming"));
  // [META] must be stripped from spoken text
  assert(!p.spokenText.includes("[META]"));
});

test("[META] tag stripped completely from spoken text", () => {
  const raw = "Sure. Walk me through your deployment pipeline.\n[META] phase:technical action:ask comm:7 tech:8 solve:6 exp:7 question:Walk me through your deployment pipeline.";
  const p = parseLLMResponse(raw);
  assert(!p.spokenText.includes("[META]"));
  assert(!p.spokenText.includes("phase:"));
  assert(!p.spokenText.includes("comm:"));
});

test("multi-sentence natural response is fully preserved", () => {
  const raw = "Hmm, interesting. So you were running that on EKS. I'm curious — how did you handle node autoscaling during traffic spikes? Did you use cluster autoscaler or Karpenter?\n[META] phase:technical action:ask comm:8 tech:9 solve:7 exp:8 question:How did you handle node autoscaling during traffic spikes?";
  const p = parseLLMResponse(raw);
  assert(p.spokenText.includes("EKS"));
  assert(p.spokenText.includes("Karpenter"));
  assert(p.spokenText.includes("Hmm"));
});

test("extracts all metadata fields correctly", () => {
  const raw = "Got it. [META] phase:behavioral action:followup comm:7 tech:5 solve:8 exp:7 question:Tell me more about the conflict?";
  const p = parseLLMResponse(raw);
  assert.equal(p.phase, "behavioral");
  assert.equal(p.action, "followup");
  assert.equal(p.scores.communication, 7);
  assert.equal(p.scores.technicalKnowledge, 5);
  assert.equal(p.scores.problemSolving, 8);
  assert.equal(p.scores.practicalExperience, 7);
  assert.equal(p.question, "Tell me more about the conflict?");
});

test("missing [META] returns safe defaults", () => {
  const p = parseLLMResponse("Take your time, go ahead.");
  assert.equal(p.spokenText, "Take your time, go ahead.");
  assert.equal(p.phase, null);
  assert.equal(p.action, "ask");
  assert.equal(p.scores.communication, 0);
});

test("empty string gets fallback spoken text", () => {
  const p = parseLLMResponse("");
  assert(p.spokenText.length > 0);
});

test("whitespace-only string gets fallback text", () => {
  const p = parseLLMResponse("   ");
  assert(p.spokenText.length > 0);
});

test("introduction phase with zero scores is valid", () => {
  const raw = "Hey Jane, I'm Alex — good to meet you. So just to kick things off, can you walk me through your background and what brought you here today?\n[META] phase:introduction action:ask comm:0 tech:0 solve:0 exp:0 question:Can you walk me through your background?";
  const p = parseLLMResponse(raw);
  assert.equal(p.phase, "introduction");
  assert.equal(p.scores.communication, 0); // no score yet — just introductions
  assert(p.spokenText.includes("Alex"));
});

test("closing phase action:close is parsed correctly", () => {
  const raw = "Alright Jane, that's all from my side. Really appreciate you taking the time today. We'll be in touch soon.\n[META] phase:closing action:close comm:0 tech:0 solve:0 exp:0 question:none";
  const p = parseLLMResponse(raw);
  assert.equal(p.action, "close");
  assert.equal(p.phase, "closing");
  assert(p.spokenText.includes("appreciate you"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Session Management ─────────────────────────────────────────\n");

test("createSession stores all config fields", () => {
  const s = makeSession("s-1", { resume: "5 years Go, AWS", difficulty: "hard", interviewType: "technical" });
  assert.equal(s.candidateName, "Jane Smith");
  assert.equal(s.resume, "5 years Go, AWS");
  assert.equal(s.difficulty, "hard");
  assert.equal(s.interviewType, "technical");
  assert.equal(s.phase, PHASE.INTRODUCTION);
  clean("s-1");
});

test("createSession prevents overwrite with same ID", () => {
  makeSession("s-2", { candidateName: "Alice" });
  makeSession("s-2", { candidateName: "Bob" });
  assert.equal(getSession("s-2").candidateName, "Alice");
  clean("s-2");
});

test("deleteSession removes session cleanly", () => {
  makeSession("s-3");
  deleteSession("s-3");
  assert.equal(hasSession("s-3"), false);
});

test("createSession defaults to 30 min duration", () => {
  const s = makeSession("s-4");
  assert.equal(s.maxDurationMs, 30 * 60 * 1000);
  clean("s-4");
});

test("createSession respects custom duration", () => {
  const s = makeSession("s-5", { max_interview_duration: 45 });
  assert.equal(s.maxDurationMs, 45 * 60 * 1000);
  clean("s-5");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. TIME MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Time Management ────────────────────────────────────────────\n");

test("fresh session is not expired", () => {
  const s = makeSession("t-1");
  assert.equal(isTimeExpired(s), false);
  clean("t-1");
});

test("session past maxDuration is expired", () => {
  const s = makeSession("t-2");
  s.startTime = Date.now() - 31 * 60 * 1000;
  assert.equal(isTimeExpired(s), true);
  clean("t-2");
});

test("isTimeAlmostUp true within last 2 minutes", () => {
  const s = makeSession("t-3", { max_interview_duration: 30 });
  s.startTime = Date.now() - 29 * 60 * 1000;
  assert.equal(isTimeAlmostUp(s), true);
  clean("t-3");
});

test("getRemainingMinutes is 0 when expired", () => {
  const s = makeSession("t-4");
  s.startTime = Date.now() - 35 * 60 * 1000;
  assert.equal(getRemainingMinutes(s), 0);
  clean("t-4");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. STATE MACHINE — Natural phase flow
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── State Machine ──────────────────────────────────────────────\n");

test("introduction → resume on transition", () => {
  const s = makeSession("sm-1");
  s.phase = PHASE.INTRODUCTION;
  advancePhase(s, "transition");
  assert.equal(s.phase, PHASE.RESUME);
  clean("sm-1");
});

test("resume → technical for mixed interview", () => {
  const s = makeSession("sm-2", { interviewType: "mixed" });
  s.phase = PHASE.RESUME;
  advancePhase(s, "transition");
  assert.equal(s.phase, PHASE.TECHNICAL);
  clean("sm-2");
});

test("technical → closing for technical interview (skips behavioral)", () => {
  const s = makeSession("sm-3", { interviewType: "technical" });
  s.phase = PHASE.TECHNICAL;
  advancePhase(s, "transition");
  assert.equal(s.phase, PHASE.CLOSING);
  clean("sm-3");
});

test("resume → behavioral for hr interview (skips technical)", () => {
  const s = makeSession("sm-4", { interviewType: "hr" });
  s.phase = PHASE.RESUME;
  advancePhase(s, "transition");
  assert.equal(s.phase, PHASE.BEHAVIORAL);
  clean("sm-4");
});

test("closing → done on close, sets session.done", () => {
  const s = makeSession("sm-5");
  s.phase = PHASE.CLOSING;
  advancePhase(s, "close");
  assert.equal(s.phase, PHASE.DONE);
  assert.equal(s.done, true);
  clean("sm-5");
});

test("ask increments phaseStep", () => {
  const s = makeSession("sm-6");
  s.phase = PHASE.TECHNICAL; s.phaseStep = 1;
  advancePhase(s, "ask");
  assert.equal(s.phaseStep, 2);
  clean("sm-6");
});

test("followup increments followUpCount", () => {
  const s = makeSession("sm-7");
  s.followUpCount = 0;
  advancePhase(s, "followup");
  assert.equal(s.followUpCount, 1);
  clean("sm-7");
});

test("followup auto-resets at maxFollowUps limit", () => {
  const s = makeSession("sm-8");
  s.phase = PHASE.TECHNICAL;
  s.followUpCount = s.maxFollowUps; // at limit
  advancePhase(s, "followup");
  assert.equal(s.followUpCount, 0); // reset → treat as new question
  clean("sm-8");
});

test("auto-transition when phase question limit reached (medium resume = 2)", () => {
  const s = makeSession("sm-9", { difficulty: "medium", interviewType: "mixed" });
  s.phase = PHASE.RESUME; s.phaseStep = 1;
  advancePhase(s, "ask");
  assert.equal(s.phase, PHASE.TECHNICAL);
  clean("sm-9");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. SCORING & REPORT
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Scoring & Report ───────────────────────────────────────────\n");

test("zero scores are not recorded", () => {
  const s = makeSession("sc-1");
  recordScores(s, { communication: 0, technicalKnowledge: 0, problemSolving: 0, practicalExperience: 0 });
  assert.equal(s.scores.communication.length, 0);
  clean("sc-1");
});

test("non-zero scores are recorded", () => {
  const s = makeSession("sc-2");
  recordScores(s, { communication: 8, technicalKnowledge: 7, problemSolving: 6, practicalExperience: 8 });
  assert.equal(s.scores.communication[0], 8);
  clean("sc-2");
});

test("report shows null for untested dimensions", () => {
  const s = makeSession("sc-3");
  recordScores(s, { communication: 8, technicalKnowledge: 0, problemSolving: 0, practicalExperience: 0 });
  const r = generateReport(s);
  assert.equal(r.technical_score, null);
  assert.equal(r.communication_score, 8);
  clean("sc-3");
});

test("recommended_hire true when overall >= 6", () => {
  const s = makeSession("sc-4");
  recordScores(s, { communication: 7, technicalKnowledge: 7, problemSolving: 7, practicalExperience: 7 });
  assert.equal(generateReport(s).recommended_hire, true);
  clean("sc-4");
});

test("recommended_hire false when overall < 6", () => {
  const s = makeSession("sc-5");
  recordScores(s, { communication: 4, technicalKnowledge: 4, problemSolving: 4, practicalExperience: 4 });
  assert.equal(generateReport(s).recommended_hire, false);
  clean("sc-5");
});

test("report includes candidate name, role, interview_type", () => {
  const s = makeSession("sc-6", { candidateName: "Tom Hanks", role: "DevOps Engineer", interviewType: "technical" });
  const r = generateReport(s);
  assert.equal(r.candidate_name, "Tom Hanks");
  assert.equal(r.role, "DevOps Engineer");
  assert.equal(r.interview_type, "technical");
  clean("sc-6");
});

test("avg([7,8,9]) = 8", () => { assert.equal(avg([7, 8, 9]), 8); });
test("avg([]) = 0",       () => { assert.equal(avg([]), 0); });
test("avg([10]) = 10",    () => { assert.equal(avg([10]), 10); });

// ─────────────────────────────────────────────────────────────────────────────
// 9. BOT SCHEDULER VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Bot Scheduler Validation ───────────────────────────────────\n");

const BASE = {
  candidate_name: "Jane", role: "Engineer",
  meeting_url: "https://zoom.us/j/1",
  meeting_time: new Date(Date.now() + 900000).toISOString(),
  ngrok_url: "https://srv.example.com",
};

await testAsync("rejects missing candidate_name", async () => {
  const r = await scheduleInterviewBot({ ...BASE, candidate_name: undefined });
  assert.equal(r.success, false);
  assert(r.error.includes("candidate_name"));
});
await testAsync("rejects missing role", async () => {
  const r = await scheduleInterviewBot({ ...BASE, role: undefined });
  assert.equal(r.success, false);
  assert(r.error.includes("role"));
});
await testAsync("rejects missing meeting_url", async () => {
  const r = await scheduleInterviewBot({ ...BASE, meeting_url: undefined });
  assert.equal(r.success, false);
  assert(r.error.includes("meeting_url"));
});
await testAsync("rejects missing meeting_time", async () => {
  const r = await scheduleInterviewBot({ ...BASE, meeting_time: undefined });
  assert.equal(r.success, false);
  assert(r.error.includes("meeting_time"));
});
await testAsync("rejects missing server_url", async () => {
  const r = await scheduleInterviewBot({ ...BASE, ngrok_url: undefined });
  assert.equal(r.success, false);
});
await testAsync("rejects past meeting time", async () => {
  const r = await scheduleInterviewBot({ ...BASE, meeting_time: new Date(Date.now() - 60000).toISOString() });
  assert.equal(r.success, false);
  assert(r.error.toLowerCase().includes("future") || r.error.toLowerCase().includes("minute"));
});
await testAsync("rejects meeting time < 2 min away", async () => {
  const r = await scheduleInterviewBot({ ...BASE, meeting_time: new Date(Date.now() + 60000).toISOString() });
  assert.equal(r.success, false);
});
await testAsync("rejects invalid date string", async () => {
  const r = await scheduleInterviewBot({ ...BASE, meeting_time: "not-a-date" });
  assert.equal(r.success, false);
});
await testAsync("rejects when RECALL_API_KEY missing", async () => {
  const saved = process.env.RECALL_API_KEY;
  delete process.env.RECALL_API_KEY;
  const r = await scheduleInterviewBot({ ...BASE });
  process.env.RECALL_API_KEY = saved;
  assert.equal(r.success, false);
  assert(r.error.includes("RECALL_API_KEY"));
});

test("calculateBotJoinTime returns Date before meeting", () => {
  const meeting = new Date(Date.now() + 60 * 60 * 1000);
  const join    = calculateBotJoinTime(meeting, 5);
  assert(join < meeting);
  assert.equal(Math.round((meeting - join) / 60000), 5);
});
test("calculateBotJoinTime throws for invalid date", () => {
  assert.throws(() => calculateBotJoinTime("bad"), /valid date/i);
});
test("calculateBotJoinTime throws when too soon", () => {
  assert.throws(() => calculateBotJoinTime(new Date(Date.now() + 3 * 60 * 1000), 2), /too soon|future/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. RESUME PARSING
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Resume Parsing ─────────────────────────────────────────────\n");

test("extracts email", () => {
  assert.equal(parseResume("jane@example.com").email, "jane@example.com");
});
test("extracts years of experience", () => {
  assert.equal(parseResume("8 years of experience in backend").experience_years, 8);
});
test("extracts technologies", () => {
  const r = parseResume("Built with Node.js, AWS, Docker, PostgreSQL");
  assert(r.technologies.includes("aws"));
  assert(r.technologies.includes("docker"));
  assert(r.technologies.includes("postgresql"));
});
test("deduplicates technologies", () => {
  const r = parseResume("AWS Lambda, AWS S3, AWS RDS");
  assert.equal(r.technologies.filter(t => t === "aws").length, 1);
});
test("returns empty object for null", () => {
  assert.deepEqual(parseResume(null), {});
});

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════════\n");
console.log(`  ✅ Passed : ${pass}`);
console.log(`  ❌ Failed : ${fail}`);
console.log(`  📊 Total  : ${pass + fail}`);
console.log();
if (fail > 0) { console.error("  Some tests failed.\n"); process.exit(1); }
else          { console.log("  All tests passed!\n"); process.exit(0); }
