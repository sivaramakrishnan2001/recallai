// =============================================================================
// AI Interview Bot v3.0 — Test Suite
// Architecture: OpenAI Realtime API + ElevenLabs TTS + Recall.ai
// Run: node test.js
// =============================================================================

import assert from "assert";

import {
  createSession, getSession, hasSession, deleteSession, PHASE,
  getRemainingMinutes, isTimeAlmostUp, isTimeExpired,
} from "./sessions/sessionManager.js";

import { advancePhase } from "./agent/stateMachine.js";
import { parseLLMResponse, processToolCall, recordScores, generateReport, avg } from "./tools/evaluator.js";
import { buildRealtimeInstructions, buildGreetingPrompt, INTERVIEW_TOOLS } from "./tools/questionGenerator.js";
import { scheduleInterviewBot, calculateBotJoinTime, parseResume } from "./tools/botScheduler.js";

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
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Conversation Quality (Human vs Robot) ──────────────────────\n");

test("prompt instructs Alex to sound like a real human, not AI", () => {
  const s = makeSession("q-1");
  const p = buildRealtimeInstructions(s);
  assert(p.includes("You are NOT an AI") || p.includes("real human"));
  clean("q-1");
});

test("prompt bans 'Thank you for your response'", () => {
  const s = makeSession("q-2");
  const p = buildRealtimeInstructions(s);
  assert(p.toLowerCase().includes("thank you for your response"));
  const banIdx = p.indexOf("NEVER DO THESE");
  const phraseIdx = p.indexOf("Thank you for your response");
  assert(phraseIdx > banIdx, "Phrase must appear in the banned section");
  clean("q-2");
});

test("prompt bans 'That is a great answer'", () => {
  const s = makeSession("q-3");
  const p = buildRealtimeInstructions(s);
  const banIdx = p.indexOf("NEVER DO THESE");
  const phraseIdx = p.toLowerCase().indexOf("great answer");
  assert(phraseIdx > banIdx, "Must be in banned section");
  clean("q-3");
});

test("prompt bans 'As an AI'", () => {
  const s = makeSession("q-4");
  const p = buildRealtimeInstructions(s);
  const banIdx = p.indexOf("NEVER DO THESE");
  const aiIdx = p.indexOf("As an AI");
  assert(aiIdx > banIdx, "Must be in banned section");
  clean("q-4");
});

test("prompt instructs Alex to acknowledge previous answer", () => {
  const s = makeSession("q-5");
  const p = buildRealtimeInstructions(s);
  assert(
    p.includes("Acknowledge what the candidate just said") ||
    p.includes("Reference something specific"),
  );
  clean("q-5");
});

test("prompt provides natural filler words", () => {
  const s = makeSession("q-6");
  const p = buildRealtimeInstructions(s);
  assert(p.includes("Hmm") || p.includes("Got it") || p.includes("Fair enough"));
  clean("q-6");
});

test("prompt requires asking ONE question at a time", () => {
  const s = makeSession("q-7");
  const p = buildRealtimeInstructions(s);
  assert(p.includes("ONE") || p.includes("one question at a time"));
  clean("q-7");
});

test("prompt instructs natural phase transitions", () => {
  const s = makeSession("q-8");
  const p = buildRealtimeInstructions(s);
  assert(p.includes("shift gears") || p.includes("move on") || p.includes("naturally"));
  clean("q-8");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TOOL DEFINITIONS (Realtime API)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Tool Definitions (Realtime API) ────────────────────────────\n");

test("INTERVIEW_TOOLS has 3 tools", () => {
  assert.equal(INTERVIEW_TOOLS.length, 3);
});

test("evaluate_response tool has all score parameters", () => {
  const tool = INTERVIEW_TOOLS.find(t => t.name === "evaluate_response");
  assert(tool, "evaluate_response tool must exist");
  const props = tool.parameters.properties;
  assert(props.communication, "Must have communication");
  assert(props.technical_knowledge, "Must have technical_knowledge");
  assert(props.problem_solving, "Must have problem_solving");
  assert(props.practical_experience, "Must have practical_experience");
});

test("transition_phase tool has next_phase enum", () => {
  const tool = INTERVIEW_TOOLS.find(t => t.name === "transition_phase");
  assert(tool, "transition_phase tool must exist");
  const nextPhase = tool.parameters.properties.next_phase;
  assert(nextPhase.enum.includes("resume"));
  assert(nextPhase.enum.includes("technical"));
  assert(nextPhase.enum.includes("behavioral"));
  assert(nextPhase.enum.includes("closing"));
});

test("end_interview tool exists with reason parameter", () => {
  const tool = INTERVIEW_TOOLS.find(t => t.name === "end_interview");
  assert(tool, "end_interview tool must exist");
  assert(tool.parameters.properties.reason);
});

test("prompt includes tool usage instructions", () => {
  const s = makeSession("t-1");
  const p = buildRealtimeInstructions(s);
  assert(p.includes("evaluate_response") || p.includes("TOOL USAGE"));
  clean("t-1");
});

test("greeting prompt is concise and mentions candidate name", () => {
  const s = makeSession("t-2", { candidateName: "Marcus" });
  const p = buildGreetingPrompt(s);
  assert(p.includes("Marcus"));
  assert(p.includes("Alex"));
  clean("t-2");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. TOOL CALL PROCESSING
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Tool Call Processing ────────────────────────────────────────\n");

test("processToolCall: evaluate_response records scores", () => {
  const s = makeSession("tc-1");
  s.phase = PHASE.TECHNICAL;
  const result = processToolCall(s, "evaluate_response", {
    communication: 8,
    technical_knowledge: 7,
    problem_solving: 6,
    practical_experience: 9,
    question_asked: "How do you handle caching?",
  });
  assert.equal(result.status, "recorded");
  assert.equal(s.scores.communication[0], 8);
  assert.equal(s.scores.technicalKnowledge[0], 7);
  assert.equal(s.scores.problemSolving[0], 6);
  assert.equal(s.scores.practicalExperience[0], 9);
  assert(s.questionsAsked.includes("How do you handle caching?"));
  clean("tc-1");
});

test("processToolCall: evaluate_response clamps scores to 0-10", () => {
  const s = makeSession("tc-2");
  s.phase = PHASE.TECHNICAL;
  processToolCall(s, "evaluate_response", {
    communication: 15,
    technical_knowledge: -3,
    problem_solving: 0,
    practical_experience: 10,
  });
  assert.equal(s.scores.communication[0], 10);
  assert.equal(s.scores.technicalKnowledge.length, 0); // 0 not recorded
  assert.equal(s.scores.problemSolving.length, 0);      // 0 not recorded
  assert.equal(s.scores.practicalExperience[0], 10);
  clean("tc-2");
});

test("processToolCall: transition_phase changes session phase", () => {
  const s = makeSession("tc-3");
  s.phase = PHASE.RESUME;
  const result = processToolCall(s, "transition_phase", {
    next_phase: "technical",
    reason: "Enough resume questions",
  });
  assert.equal(result.status, "transitioned");
  clean("tc-3");
});

test("processToolCall: transition_phase rejects invalid phase", () => {
  const s = makeSession("tc-4");
  const result = processToolCall(s, "transition_phase", { next_phase: "invalid_phase" });
  assert.equal(result.status, "error");
  clean("tc-4");
});

test("processToolCall: end_interview sets done flag", () => {
  const s = makeSession("tc-5");
  const result = processToolCall(s, "end_interview", { reason: "Time expired" });
  assert.equal(result.status, "ended");
  assert.equal(s.done, true);
  assert.equal(s.phase, PHASE.DONE);
  clean("tc-5");
});

test("processToolCall: unknown tool returns error", () => {
  const s = makeSession("tc-6");
  const result = processToolCall(s, "unknown_tool", {});
  assert.equal(result.status, "error");
  clean("tc-6");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. RESUME-BASED PERSONALISATION
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Resume-Based Personalisation ───────────────────────────────\n");

test("prompt includes candidate resume text verbatim", () => {
  const s = makeSession("r-1", { resume: "Led migration of monolith to microservices at Stripe using Go and Kafka" });
  const p = buildRealtimeInstructions(s);
  assert(p.includes("Led migration of monolith to microservices at Stripe"));
  clean("r-1");
});

test("prompt instructs SPECIFIC resume-based questions", () => {
  const s = makeSession("r-2", { resume: "Worked on payment processing systems" });
  const p = buildRealtimeInstructions(s);
  assert(p.includes("specific") || p.includes("SPECIFIC"));
  clean("r-2");
});

test("prompt warns NOT to ask generic questions when resume provided", () => {
  const s = makeSession("r-3", { resume: "10 years Python, FastAPI, AWS" });
  const p = buildRealtimeInstructions(s);
  assert(p.includes("Do NOT ask generic") || p.includes("NOT ask"));
  clean("r-3");
});

test("prompt handles no-resume gracefully", () => {
  const s = makeSession("r-4", { resume: null });
  const p = buildRealtimeInstructions(s);
  assert(p.includes("No resume provided"));
  clean("r-4");
});

test("previously asked questions are listed to prevent repetition", () => {
  const s = makeSession("r-5");
  s.questionsAsked = ["Tell me about Redis?", "How did you handle cache invalidation?"];
  const p = buildRealtimeInstructions(s);
  assert(p.includes("Tell me about Redis?"));
  assert(p.includes("How did you handle cache invalidation?"));
  clean("r-5");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. LLM RESPONSE PARSING (Legacy fallback)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── LLM Response Parsing (Legacy) ──────────────────────────────\n");

test("natural acknowledgment preserved in spokenText", () => {
  const raw = "Right, so the Redis cluster handled invalidation. How did you handle cache warming?\n[META] phase:technical action:ask comm:7 tech:8 solve:7 exp:8 question:How did you handle cache warming?";
  const p = parseLLMResponse(raw);
  assert(p.spokenText.includes("Redis cluster"));
  assert(!p.spokenText.includes("[META]"));
});

test("[META] tag stripped from spoken text", () => {
  const raw = "Sure. Walk me through your pipeline.\n[META] phase:technical action:ask comm:7 tech:8 solve:6 exp:7 question:Walk me through your pipeline.";
  const p = parseLLMResponse(raw);
  assert(!p.spokenText.includes("[META]"));
  assert(!p.spokenText.includes("phase:"));
});

test("extracts all metadata fields correctly", () => {
  const raw = "Got it. [META] phase:behavioral action:followup comm:7 tech:5 solve:8 exp:7 question:Tell me more?";
  const p = parseLLMResponse(raw);
  assert.equal(p.phase, "behavioral");
  assert.equal(p.action, "followup");
  assert.equal(p.scores.communication, 7);
  assert.equal(p.scores.technicalKnowledge, 5);
  assert.equal(p.scores.problemSolving, 8);
  assert.equal(p.scores.practicalExperience, 7);
});

test("missing [META] returns safe defaults", () => {
  const p = parseLLMResponse("Take your time.");
  assert.equal(p.spokenText, "Take your time.");
  assert.equal(p.phase, null);
  assert.equal(p.action, "ask");
  assert.equal(p.scores.communication, 0);
});

test("empty string gets fallback text", () => {
  const p = parseLLMResponse("");
  assert(p.spokenText.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. SESSION MANAGEMENT
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
// 7. TIME MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── Time Management ────────────────────────────────────────────\n");

test("fresh session is not expired", () => {
  const s = makeSession("t-1a");
  assert.equal(isTimeExpired(s), false);
  clean("t-1a");
});

test("session past maxDuration is expired", () => {
  const s = makeSession("t-2a");
  s.startTime = Date.now() - 31 * 60 * 1000;
  assert.equal(isTimeExpired(s), true);
  clean("t-2a");
});

test("isTimeAlmostUp true within last 2 minutes", () => {
  const s = makeSession("t-3a", { max_interview_duration: 30 });
  s.startTime = Date.now() - 29 * 60 * 1000;
  assert.equal(isTimeAlmostUp(s), true);
  clean("t-3a");
});

test("getRemainingMinutes is 0 when expired", () => {
  const s = makeSession("t-4a");
  s.startTime = Date.now() - 35 * 60 * 1000;
  assert.equal(getRemainingMinutes(s), 0);
  clean("t-4a");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. STATE MACHINE
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

test("auto-transition when phase question limit reached", () => {
  const s = makeSession("sm-8", { difficulty: "medium", interviewType: "mixed" });
  s.phase = PHASE.RESUME; s.phaseStep = 1;
  advancePhase(s, "ask");
  assert.equal(s.phase, PHASE.TECHNICAL);
  clean("sm-8");
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. SCORING & REPORT
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
  const s = makeSession("sc-6", { candidateName: "Tom", role: "DevOps", interviewType: "technical" });
  const r = generateReport(s);
  assert.equal(r.candidate_name, "Tom");
  assert.equal(r.role, "DevOps");
  assert.equal(r.interview_type, "technical");
  clean("sc-6");
});

test("avg([7,8,9]) = 8", () => { assert.equal(avg([7, 8, 9]), 8); });
test("avg([]) = 0",       () => { assert.equal(avg([]), 0); });
test("avg([10]) = 10",    () => { assert.equal(avg([10]), 10); });

// ─────────────────────────────────────────────────────────────────────────────
// 10. BOT SCHEDULER VALIDATION
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
});
await testAsync("rejects missing meeting_url", async () => {
  const r = await scheduleInterviewBot({ ...BASE, meeting_url: undefined });
  assert.equal(r.success, false);
});
await testAsync("rejects missing meeting_time", async () => {
  const r = await scheduleInterviewBot({ ...BASE, meeting_time: undefined });
  assert.equal(r.success, false);
});
await testAsync("rejects missing server_url", async () => {
  const r = await scheduleInterviewBot({ ...BASE, ngrok_url: undefined });
  assert.equal(r.success, false);
});
await testAsync("rejects past meeting time", async () => {
  const r = await scheduleInterviewBot({ ...BASE, meeting_time: new Date(Date.now() - 60000).toISOString() });
  assert.equal(r.success, false);
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
  const join = calculateBotJoinTime(meeting, 5);
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
// 11. RESUME PARSING
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
