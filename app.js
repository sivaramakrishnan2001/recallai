// =============================================================================
// AI Interview Bot v2.0
// Goal: Schedule a Recall.ai bot to auto-join a meeting and conduct an
//       AI interview based on the candidate's resume.
//
// Flow:
//   POST /api/schedule-bot  →  Recall.ai creates bot with join_at
//   Bot joins meeting       →  bot camera loads /meeting-page
//   /meeting-page           →  calls /api/start → /api/respond loop
//   Interview completes     →  report sent to n8n webhook
// =============================================================================

import dotenv from "dotenv";
dotenv.config(); // MUST be first before other imports

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { createHash } from "crypto";

import {
  createSession,
  getSession,
  hasSession,
  deleteSession,
  getAllSessions,
  initializeGarbageCollection,
  PHASE,
} from "./sessions/sessionManager.js";

import { initializeProvider, getActiveProvider } from "./llm/factory.js";
import { getInterviewerResponse, getGreeting, getSilencePrompt } from "./agent/interviewAgent.js";
import { generateReport } from "./tools/evaluator.js";
import { sendResultsToN8n } from "./tools/webhookSender.js";
import { scheduleInterviewBot, batchScheduleInterviews, retrieveBotArtifacts } from "./tools/botScheduler.js";

const PORT = process.env.PORT || 3000;
const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";

console.log("\n=== AI Interview Bot v2.0 ===");
console.log(`LLM Provider    : ${LLM_PROVIDER}`);
console.log(`OPENAI_API_KEY  : ${process.env.OPENAI_API_KEY ? "set" : "MISSING"}`);
console.log(`RECALL_API_KEY  : ${process.env.RECALL_API_KEY ? "set" : "MISSING"}`);
console.log(`ELEVENLABS_KEY  : ${process.env.ELEVENLABS_API_KEY ? "set" : "MISSING"}`);
console.log(`N8N_WEBHOOK_URL : ${process.env.N8N_WEBHOOK_URL ? "set" : "not set"}`);
console.log("=============================\n");

await initializeProvider();
initializeGarbageCollection();

const app = express();
const server = createServer(app);

app.use(express.json({ limit: "10mb" }));
app.use(cors());

// =============================================================================
// Process Queue & Deduplication (for webhook reliability)
// =============================================================================
const processedEvents = new Map(); // { dedupKey -> timestamp }
const EVENT_DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const transcriptQueue = []; // Simple async queue for webhook processing
let isProcessing = false; // Prevent multiple concurrent queue processors

/**
 * Create a dedup key for transcript events to prevent duplicates
 * Uses MD5 hash of text for robust collision detection
 * @param {string} botId - Recall.ai bot ID
 * @param {string} event - Event type (transcript.data, transcript.partial_data)
 * @param {string} text - Transcript text
 * @param {number} timestamp - When the event occurred (from Recall.ai)
 * @returns {string} Dedup key
 */
function createDedupKey(botId, event, text, timestamp) {
  // Hash the full text (not just first 50 chars) to avoid collisions
  const textHash = createHash('md5').update(text).digest('hex').substring(0, 16);
  return `${botId}_${event}_${textHash}_${Math.floor(timestamp / 1000)}`; // Round to second
}

/**
 * Check if event was already processed (dedup)
 * @param {string} key - Dedup key
 * @returns {boolean} True if already processed
 */
function isDuplicate(key) {
  if (processedEvents.has(key)) {
    return true;
  }
  // Record that we saw this event
  processedEvents.set(key, Date.now());
  
  // Cleanup old entries
  if (processedEvents.size > 1000) {
    for (const [k, v] of processedEvents.entries()) {
      if (Date.now() - v > EVENT_DEDUP_TTL) {
        processedEvents.delete(k);
      }
    }
  }
  return false;
}

/**
 * Queue transcript processing to run asynchronously
 * (webhooks must ACK fast to prevent Recall.ai retries)
 * 
 * Uses a single processor to prevent race conditions
 */
function queueTranscriptProcessing(sessionId, session, text) {
  transcriptQueue.push({ sessionId, session, text });
  
  // Process queue async (don't block webhook handler)
  // Only start processing if not already running
  if (!isProcessing) {
    isProcessing = true;
    setImmediate(async () => {
      while (transcriptQueue.length > 0) {
        const task = transcriptQueue.shift();
        try {
          // Get fresh session reference to avoid stale data
          const freshSession = getSession(task.sessionId);
          if (!freshSession) {
            console.warn(`[Queue] Session disappeared: ${task.sessionId}`);
            continue;
          }
          
          await getInterviewerResponse(freshSession, task.text);
          if (freshSession.done) {
            const report = generateReport(freshSession);
            await sendResultsToN8n(freshSession);
            console.log(`[Interview] Complete [${task.sessionId}] score=${report.overall_score}`);
          }
        } catch (err) {
          console.error(`[Queue] Error processing transcript:`, err.message);
        }
      }
      isProcessing = false;
    });
  }
}

// =============================================================================
// GET /health
// =============================================================================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "2.0",
    sessions: getAllSessions().length,
    provider: getActiveProvider(),
  });
});

// =============================================================================
// POST /api/schedule-bot
// Schedule a Recall.ai bot to auto-join a meeting and run the AI interview.
//
// Body:
//   candidate_name   string   required  Candidate's full name
//   role             string   required  Job role being interviewed for
//   resume           string   optional  Resume text (used to tailor questions)
//   meeting_url      string   required  Zoom / Teams / Google Meet URL
//   meeting_time     string   required  ISO 8601 datetime (must be >10min future for guaranteed join)
//   server_url       string   required  Public HTTPS URL of this server (e.g. https://yourserver.com)
//   interview_type   string   optional  "technical" | "hr" | "mixed"  (default: mixed)
//   difficulty       string   optional  "easy" | "medium" | "hard"    (default: medium)
//
// Returns:
//   bot_id, session_id, joined_at, meeting_url
// =============================================================================
app.post("/api/schedule-bot", async (req, res) => {
  const {
    candidate_name,
    role,
    resume,
    meeting_url,
    meeting_time,
    server_url,
    interview_type,
    difficulty,
  } = req.body || {};

  if (!candidate_name || !role || !meeting_url || !meeting_time || !server_url) {
    return res.status(400).json({
      error: "Required: candidate_name, role, meeting_url, meeting_time, server_url",
    });
  }

  const result = await scheduleInterviewBot({
    candidate_name,
    role,
    resume,
    meeting_url,
    meeting_time,
    interview_type,
    difficulty,
    ngrok_url: server_url,
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  // Pre-create the session so it's ready when the bot joins
  const sessionId = `bot_${result.bot_id}`;
  createSession(sessionId, {
    candidateName: candidate_name,
    role,
    resume,
    interviewType: interview_type || "mixed",
    difficulty: difficulty || "medium",
  });

  console.log(`[schedule-bot] Session ready: ${sessionId}`);

  return res.json({
    success: true,
    bot_id: result.bot_id,
    session_id: sessionId,
    joined_at: result.joined_at,
    meeting_url: result.meeting_url,
    message: `Bot scheduled to join at ${new Date(result.joined_at).toLocaleString()}`,
  });
});

// =============================================================================
// POST /api/batch-schedule
// Schedule multiple bots at once (e.g. a full day of interviews).
//
// Body:
//   server_url   string   required  Public HTTPS URL of this server
//   interviews   array    required  Array of schedule-bot bodies (minus server_url)
// =============================================================================
app.post("/api/batch-schedule", async (req, res) => {
  const { interviews, server_url } = req.body || {};

  if (!server_url || !Array.isArray(interviews) || interviews.length === 0) {
    return res.status(400).json({
      error: "Required: server_url and interviews[] array",
    });
  }

  const configs = interviews.map((i) => ({ ...i, ngrok_url: server_url }));
  const results = await batchScheduleInterviews(configs);

  const successful = [];
  const failed = [];

  for (const r of results) {
    if (r.success) {
      const sessionId = `bot_${r.bot_id}`;
      createSession(sessionId, {
        candidateName: r.candidate_name,
        role: r.role,
        resume: r.resume,
        interviewType: r.interview_config?.interview_type || "mixed",
        difficulty: r.interview_config?.difficulty || "medium",
      });
      successful.push({ ...r, session_id: sessionId });
    } else {
      failed.push(r);
    }
  }

  return res.json({
    summary: { total: results.length, scheduled: successful.length, failed: failed.length },
    scheduled: successful,
    errors: failed,
  });
});

// =============================================================================
// POST /api/start
// Called by /meeting-page when the bot loads into the meeting.
// Starts the interview and returns the greeting audio.
// =============================================================================
app.post("/api/start", async (req, res) => {
  const { sessionId, candidateName, role, resume, difficulty, interviewType } = req.body || {};

  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  let session = getSession(sessionId);
  if (!session) {
    session = createSession(sessionId, { candidateName, role, resume, difficulty, interviewType });
  }

  if (session.history.length > 0) {
    return res.status(409).json({ error: "Interview already started" });
  }

  try {
    console.log(`[/api/start] Starting interview for ${session.id}...`);
    const greeting = await getGreeting(session);
    
    if (!greeting || !greeting.audio) {
      throw new Error("Greeting audio generation failed: no audio returned");
    }
    
    console.log(`[/api/start] ✓ Greeting generated successfully`);
    return res.json({
      audio: greeting.audio,
      text: greeting.text || "Hello! Let's begin the interview.",
      phase: session.phase,
      sessionId: session.id,
    });
  } catch (err) {
    console.error(`[/api/start] ERROR:`, err.message);
    console.error(`[/api/start] Stack:`, err.stack);
    
    // Check for common issues
    const errorMsg = err.message || "Unknown error";
    if (errorMsg.includes("401") || errorMsg.includes("Unauthorized")) {
      return res.status(401).json({ error: "API authentication failed. Check OPENAI_API_KEY and ELEVENLABS_API_KEY." });
    }
    if (errorMsg.includes("rate limit")) {
      return res.status(429).json({ error: "API rate limit exceeded. Try again later." });
    }
    
    return res.status(500).json({ 
      error: errorMsg,
      hint: "Check server logs for detailed error information"
    });
  }
});

// =============================================================================
// POST /api/respond
// Called by /meeting-page with each candidate transcript segment.
// Returns interviewer audio + text response.
// =============================================================================
app.post("/api/respond", async (req, res) => {
  const { sessionId, text } = req.body || {};

  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
  if (!text || text.trim().length < 3) return res.status(400).json({ error: "Answer too short" });

  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.done) return res.json({ done: true, report: generateReport(session) });
  if (session.processing) return res.status(429).json({ error: "Still processing" });
  if (text.trim() === session.lastText) return res.status(429).json({ error: "Duplicate" });

  session.processing = true;
  session.lastText = text.trim();

  try {
    console.log(`[/api/respond] Processing: "${text.substring(0, 50)}..."`);
    const response = await getInterviewerResponse(session, text);
    
    if (!response || !response.audio) {
      throw new Error("Interviewer response generation failed");
    }
    
    const isDone = session.done;
    let report = null;

    if (isDone) {
      report = generateReport(session);
      console.log(`[Interview] Complete [${sessionId}] score=${report.overall_score}`);
      sendResultsToN8n(session);
    }

    session.processing = false;
    
    console.log(`[/api/respond] ✓ Response generated (phase=${session.phase})`);
    return res.json({
      audio: response.audio,
      text: response.text,
      phase: response.phase,
      action: response.action,
      done: isDone,
      report: isDone ? report : undefined,
    });
  } catch (err) {
    session.processing = false;
    console.error(`[/api/respond] ERROR:`, err.message);
    console.error(`[/api/respond] Stack:`, err.stack);
    
    return res.status(500).json({ 
      error: err.message,
      hint: "Check server logs for detailed error information"
    });
  }
});

// =============================================================================
// POST /api/silence
// Called by /meeting-page after a period of candidate silence.
// =============================================================================
app.post("/api/silence", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  const session = getSession(sessionId);
  if (!session || session.done || session.processing) return res.json({ ignored: true });

  try {
    const { audio, text } = await getSilencePrompt(session);
    return res.json({ audio, text });
  } catch (err) {
    console.error(`[/api/silence] ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// GET /api/report/:sessionId
// Retrieve the final interview report.
// =============================================================================
app.get("/api/report/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  return res.json(generateReport(session));
});

// =============================================================================
// POST /webhook/recall/events
// Recall.ai bot lifecycle webhook.
// Register this URL in the Recall.ai dashboard under Webhooks.
//
// Handled events:
//   bot.in_call_recording  — bot joined and is recording; interview can start
//   bot.call_ended         — meeting ended; finalize report
//   bot.done               — bot fully shut down (backup finalizer)
// =============================================================================
app.post("/webhook/recall/events", async (req, res) => {
  // Payload shape: { event: "bot.in_call_recording", data: { bot: { id, metadata } } }
  const event  = req.body?.event;
  const botId  = req.body?.data?.bot?.id;
  const meta   = req.body?.data?.bot?.metadata || {};

  // ACK immediately; process async in background
  res.json({ ok: true });

  console.log(`[Recall webhook] ${event} — bot: ${botId}`);

  if (!botId) return;

  const sessionId = `bot_${botId}`;

  if (event === "bot.in_call_recording") {
    // Bot is now live in the meeting — create session if not already created
    // (it's usually pre-created at schedule time, but this is a safety fallback)
    if (!hasSession(sessionId) && meta.candidate_name && meta.role) {
      createSession(sessionId, {
        candidateName:  meta.candidate_name,
        role:           meta.role,
        interviewType:  meta.interview_type || "mixed",
        difficulty:     meta.difficulty     || "medium",
      });
      console.log(`[Recall webhook] Session auto-created for bot ${botId}`);
    }
  }

  if (event === "bot.call_ended" || event === "bot.done") {
    // Interview ended: finalize session and retrieve artifacts
    const session = getSession(sessionId);
    if (session && !session.done) {
      session.done = true;
      
      // Queue artifact retrieval in background (don't block webhook response)
      setImmediate(async () => {
        try {
          console.log(`[Bot.done] Retrieving artifacts for bot ${botId}`);
          const artifacts = await retrieveBotArtifacts(botId);
          if (artifacts.success) {
            // Attach artifacts to session
            session.transcript_url = artifacts.transcript_url;
            session.report_url     = artifacts.report_url;
            session.summary_url    = artifacts.summary_url;
            console.log(`[Bot.done] Artifacts retrieved and attached to session`);
          } else {
            console.warn(`[Bot.done] Artifact retrieval failed: ${artifacts.error}`);
          }
        } catch (err) {
          console.error(`[Bot.done] Artifact error:`, err.message);
        }
        
        // Send results to n8n (now with artifacts attached)
        await sendResultsToN8n(session);
        console.log(`[Recall webhook] Interview finalised for session ${sessionId}`);
      });
    }
  }
});

// =============================================================================
// POST /webhook/recall/transcript
// Real-time transcript webhook from Recall.ai
// PATTERN: ACK immediately (2xx), queue work async to prevent retries
// Format per docs: { "event": "transcript.data"|"transcript.partial_data",
//                    "data": { "data": { "words": [...], "participant": {...} } } }
// =============================================================================
app.post("/webhook/recall/transcript", (req, res) => {
  // 1. ACK FIRST: Return 200 OK immediately (must complete in <2s)
  res.json({ ok: true });

  // 2. Quick validation
  const event = req.body?.event;
  const data = req.body?.data?.data || {};
  const words = data.words || [];
  const participant = data.participant || {};
  
  if (!words.length) return; // No speech data

  const text = words.map(w => w.text).join(" ");
  const isPartial = event === "transcript.partial_data";
  const participantName = participant.name || "Unknown";
  const botId = req.body?.data?.bot?.id;

  console.log(`[Transcript] ${event === 'transcript.data' ? '✓ FINAL' : '~ PARTIAL'}: "${text.substring(0, 80)}..." (${participantName})`);

  // 3. Validate session exists
  if (!botId) {
    console.warn("[Transcript] No bot ID in webhook");
    return; // ACK already sent
  }

  const sessionId = `bot_${botId}`;
  const session = getSession(sessionId);
  if (!session) {
    console.warn(`[Transcript] Session not found: ${sessionId}`);
    return; // ACK already sent
  }

  // 4. Filter out bot's own speech
  const nameStr = participantName.toLowerCase();
  if (nameStr.includes("bot") || nameStr.includes("ai") || nameStr.includes("alex")) {
    return; // ACK already sent
  }

  // 5. Handle partial transcripts (update UI preview, don't process LLM)
  if (isPartial) {
    session.lastPartial = text;
    return; // ACK already sent
  }

  // 6. DEDUPLICATION: Check if we already processed this event
  //    Recall.ai may retry webhooks 2-3 times on network failures
  const dedupKey = createDedupKey(botId, event, text, Date.now());
  if (isDuplicate(dedupKey)) {
    console.log(`[Dedup] Ignoring duplicate transcript event`);
    return; // ACK already sent, don't process again
  }

  // 7. FINALIZED TRANSCRIPT: Queue async processing
  //    Must complete webhook handler <2s to prevent Recall.ai retry
  session.lastText = text;
  
  // Debounce: wait 1.8s after transcript for more speech
  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  session.debounceTimer = setTimeout(() => {
    if (!session.done && !session.processing && session.lastText.trim().length >= 4) {
      console.log(`[Transcript] Queuing LLM for: "${session.lastText.substring(0, 60)}..."`);
      // Queue processing async (don't block webhook response)
      queueTranscriptProcessing(sessionId, session, session.lastText);
    }
  }, 1800);
  // NOTE: res.json() already sent above, webhook returns immediately
});

// =============================================================================
// GET /meeting-page
// Served to the bot's camera output. Runs the interview UI.
// The bot loads this page inside the meeting — it listens to the meeting
// transcript via WebSocket and calls /api/respond with candidate speech.
//
// Query params: server, role, candidate, difficulty, type
// =============================================================================
function esc(str) {
  if (!str) return "";
  return str
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/<\/script>/gi, "<\\/script>");
}

app.get("/meeting-page", (req, res) => {
  const serverHost = req.query.server || req.get("host");
  const role       = req.query.role       || "Software Engineer";
  const candidate  = req.query.candidate  || "Candidate";
  const difficulty = req.query.difficulty || "medium";
  const type       = req.query.type       || "mixed";
  // Use same protocol as the incoming request (http locally, https via ngrok/production)
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const serverUrl  = `${proto}://${serverHost}`;

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="permissions-policy" content="microphone=*; camera=*; speaker-selection=*">
<title>Interview — ${esc(candidate)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --accent:#a78bfa;--accent2:#818cf8;--accent-glow:rgba(167,139,250,.35);
  --bg:#f8f9fc;--bg2:#eef0f6;
  --text:#1e293b;--text-dim:#64748b;--text-light:#94a3b8;
  --white:#fff;--shadow:0 2px 24px rgba(0,0,0,.06);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",sans-serif;
}
html,body{height:100%;overflow:hidden}
body{
  font-family:var(--font);
  background:var(--bg);
  background-image:repeating-linear-gradient(
    45deg,transparent,transparent 35px,rgba(0,0,0,.015) 35px,rgba(0,0,0,.015) 36px
  );
  color:var(--text);display:flex;align-items:center;justify-content:center;
}

/* ── Layout ── */
.page{
  width:100%;max-width:480px;display:flex;flex-direction:column;
  align-items:center;padding:32px 24px;height:100vh;
}

/* ── Top bar ── */
.top-bar{
  display:flex;align-items:center;justify-content:space-between;
  width:100%;margin-bottom:24px;
}
.top-left{display:flex;align-items:center;gap:8px}
.phase-tag{
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;
  padding:4px 10px;border-radius:20px;
  background:rgba(167,139,250,.12);color:var(--accent);
}
.timer{
  font-size:13px;font-weight:600;color:var(--text-light);
  font-variant-numeric:tabular-nums;
}
.timer.warning{color:#f59e0b}
.timer.expired{color:#ef4444}

/* ── Phase progress dots ── */
.phase-dots{
  display:flex;gap:6px;align-items:center;margin-bottom:28px;
}
.pdot{
  width:8px;height:8px;border-radius:50%;
  background:var(--bg2);border:1.5px solid #d1d5db;
  transition:all .4s ease;
}
.pdot.done{background:var(--accent);border-color:var(--accent)}
.pdot.active{
  background:var(--white);border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-glow);
}

/* ── Voice orb ── */
.orb-wrap{
  position:relative;display:flex;align-items:center;justify-content:center;
  margin-bottom:24px;
}

/* Concentric rings */
.ring{
  position:absolute;border-radius:50%;
  border:1px solid rgba(167,139,250,.1);
  animation:ring-pulse 3s ease-in-out infinite;
}
.ring-1{width:260px;height:260px;animation-delay:0s}
.ring-2{width:310px;height:310px;animation-delay:.5s;border-color:rgba(167,139,250,.06)}
.ring-3{width:360px;height:360px;animation-delay:1s;border-color:rgba(167,139,250,.03)}
@keyframes ring-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.04);opacity:.5}}

/* Speaking state — rings animate bigger */
.orb-wrap.speaking .ring{animation:ring-speak 1.5s ease-in-out infinite}
@keyframes ring-speak{0%,100%{transform:scale(1);opacity:.8}50%{transform:scale(1.08);opacity:.3}}

/* The orb itself */
.orb{
  width:180px;height:180px;border-radius:50%;position:relative;z-index:2;
  background:linear-gradient(135deg,#c4b5fd,#818cf8,#6366f1,#a78bfa);
  background-size:300% 300%;
  animation:orb-gradient 6s ease infinite;
  box-shadow:0 8px 40px rgba(129,140,248,.3),0 0 80px rgba(167,139,250,.15);
  display:flex;align-items:center;justify-content:center;
  transition:transform .3s ease;
}
.orb-wrap.speaking .orb{transform:scale(1.05)}
.orb-wrap.processing .orb{animation:orb-gradient 2s ease infinite}
@keyframes orb-gradient{
  0%{background-position:0% 50%}
  50%{background-position:100% 50%}
  100%{background-position:0% 50%}
}

/* Icon inside orb */
.orb-icon{
  width:48px;height:48px;color:rgba(255,255,255,.9);
  filter:drop-shadow(0 2px 4px rgba(0,0,0,.1));
}

/* ── Waveform bars ── */
.waveform{
  display:flex;align-items:center;justify-content:center;
  gap:3px;height:48px;margin-bottom:20px;width:200px;
}
.wbar{
  width:4px;border-radius:3px;
  background:linear-gradient(180deg,var(--accent),var(--accent2));
  height:8px;transition:height .1s ease;opacity:.5;
}
.waveform.active .wbar{opacity:1;animation:wbar-dance .5s ease-in-out infinite}
.wbar:nth-child(1){animation-delay:0s}
.wbar:nth-child(2){animation-delay:.05s}
.wbar:nth-child(3){animation-delay:.1s}
.wbar:nth-child(4){animation-delay:.15s}
.wbar:nth-child(5){animation-delay:.2s}
.wbar:nth-child(6){animation-delay:.25s}
.wbar:nth-child(7){animation-delay:.3s}
.wbar:nth-child(8){animation-delay:.2s}
.wbar:nth-child(9){animation-delay:.15s}
.wbar:nth-child(10){animation-delay:.1s}
.wbar:nth-child(11){animation-delay:.05s}
.wbar:nth-child(12){animation-delay:.08s}
.wbar:nth-child(13){animation-delay:.18s}
.wbar:nth-child(14){animation-delay:.12s}
.wbar:nth-child(15){animation-delay:.22s}
@keyframes wbar-dance{
  0%,100%{height:8px}
  50%{height:calc(8px + var(--h,24px))}
}
/* Varying heights for natural look */
.wbar:nth-child(1){--h:16px}.wbar:nth-child(2){--h:28px}
.wbar:nth-child(3){--h:20px}.wbar:nth-child(4){--h:36px}
.wbar:nth-child(5){--h:24px}.wbar:nth-child(6){--h:40px}
.wbar:nth-child(7){--h:32px}.wbar:nth-child(8){--h:44px}
.wbar:nth-child(9){--h:28px}.wbar:nth-child(10){--h:36px}
.wbar:nth-child(11){--h:20px}.wbar:nth-child(12){--h:32px}
.wbar:nth-child(13){--h:24px}.wbar:nth-child(14){--h:16px}
.wbar:nth-child(15){--h:12px}

/* ── Status text ── */
.status-label{
  font-size:14px;font-weight:600;color:var(--text);
  margin-bottom:4px;text-align:center;
  min-height:20px;
}
.status-sub{
  font-size:12px;color:var(--text-light);
  text-align:center;margin-bottom:16px;
  min-height:18px;
}

/* ── Transcript bubble ── */
.transcript-area{
  width:100%;flex:1;min-height:0;
  overflow-y:auto;display:flex;flex-direction:column;gap:8px;
  padding:0 4px;
  scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.08) transparent;
}
.transcript-area::-webkit-scrollbar{width:3px}
.transcript-area::-webkit-scrollbar-thumb{background:rgba(0,0,0,.08);border-radius:2px}

.bubble{
  padding:10px 16px;border-radius:16px;font-size:13px;line-height:1.5;
  max-width:90%;word-wrap:break-word;animation:bubble-in .25s ease;
}
@keyframes bubble-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

.bubble.alex{
  align-self:flex-start;
  background:var(--white);border:1px solid #e2e8f0;
  color:var(--text);box-shadow:var(--shadow);
  border-bottom-left-radius:4px;
}
.bubble.alex .who{font-size:10px;font-weight:700;color:var(--accent);margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px}

.bubble.user{
  align-self:flex-end;
  background:linear-gradient(135deg,#818cf8,#a78bfa);
  color:#fff;border-bottom-right-radius:4px;
  box-shadow:0 2px 12px rgba(129,140,248,.25);
}
.bubble.user .who{font-size:10px;font-weight:700;color:rgba(255,255,255,.7);margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px}

.bubble.sys{
  align-self:center;background:transparent;
  color:var(--text-light);font-size:11px;padding:4px 0;
}

/* ── Live mic bar ── */
.mic-bar{
  width:100%;margin-top:12px;flex-shrink:0;
  display:flex;align-items:center;gap:10px;
  padding:10px 16px;border-radius:14px;
  background:var(--white);border:1px solid #e2e8f0;
  box-shadow:var(--shadow);
}
.mic-bar.active{border-color:rgba(167,139,250,.3)}
.mic-dot{
  width:10px;height:10px;border-radius:50%;
  background:#d1d5db;flex-shrink:0;transition:background .3s;
}
.mic-bar.active .mic-dot{background:#22c55e;animation:mic-pulse 1.5s ease-in-out infinite}
@keyframes mic-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.mic-text{
  font-size:12px;color:var(--text-light);flex:1;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.mic-bar.active .mic-text{color:var(--text-dim)}

/* ── Complete overlay ── */
.overlay{
  position:fixed;inset:0;background:rgba(248,249,252,.95);
  display:none;align-items:center;justify-content:center;z-index:100;
  backdrop-filter:blur(12px);
}
.overlay.show{display:flex}
.done-card{
  background:var(--white);border:1px solid #e2e8f0;
  border-radius:24px;padding:48px 40px;text-align:center;
  max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.08);
}
.done-icon{
  width:72px;height:72px;border-radius:50%;margin:0 auto 20px;
  background:linear-gradient(135deg,#34d399,#22c55e);
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 4px 20px rgba(52,211,153,.3);
}
.done-icon svg{width:36px;height:36px;color:#fff}
.done-card h2{font-size:22px;font-weight:700;margin-bottom:8px;color:var(--text)}
.done-card p{font-size:14px;color:var(--text-dim);line-height:1.6}
</style>
</head>
<body>
<div class="page">

  <!-- Top bar -->
  <div class="top-bar">
    <div class="top-left">
      <div class="phase-tag" id="phaseTag">INTRO</div>
    </div>
    <div class="timer" id="timer">00:00</div>
  </div>

  <!-- Phase progress -->
  <div class="phase-dots" id="phaseDots">
    <div class="pdot active"></div>
    <div class="pdot"></div>
    <div class="pdot"></div>
    <div class="pdot"></div>
    <div class="pdot"></div>
  </div>

  <!-- Voice orb -->
  <div class="orb-wrap" id="orbWrap">
    <div class="ring ring-3"></div>
    <div class="ring ring-2"></div>
    <div class="ring ring-1"></div>
    <div class="orb" id="orb">
      <svg class="orb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>
    </div>
  </div>

  <!-- Waveform -->
  <div class="waveform" id="waveform">
    <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
    <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
    <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
    <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
    <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
  </div>

  <!-- Status -->
  <div class="status-label" id="statusLabel">Connecting...</div>
  <div class="status-sub" id="statusSub">${esc(candidate)} &middot; ${esc(role)}</div>

  <!-- Transcript area -->
  <div class="transcript-area" id="chat"></div>

  <!-- Live mic bar -->
  <div class="mic-bar" id="micBar">
    <div class="mic-dot"></div>
    <div class="mic-text" id="micText">Waiting for speech...</div>
  </div>

  <!-- Manual test input (hidden, shows if WebSocket fails) -->
  <div id="testInputContainer" style="display:none; margin-top:12px; width:100%; gap:8px; display:flex;">
    <input type="text" id="testInput" placeholder="Test: Type your response..." 
           style="flex:1; padding:10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px;">
    <button id="testSubmit" style="padding:10px 16px; background:#818cf8; color:#fff; border:none; border-radius:8px; cursor:pointer; font-weight:600; font-size:13px;">Send</button>
  </div>

</div>

<!-- Complete overlay -->
<div class="overlay" id="overlay">
  <div class="done-card">
    <div class="done-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <h2>Interview Complete</h2>
    <p>Thank you, <strong>${esc(candidate)}</strong>. Your responses have been recorded and the report will be shared shortly.</p>
  </div>
</div>

<script>
(function(){
  // ── Config ─────────────────────────────────────────────
  var CFG = {
    sessionId:  'bot-' + Date.now(),
    server:     '${serverUrl}',
    role:       '${esc(role)}',
    candidate:  '${esc(candidate)}',
    difficulty: '${esc(difficulty)}',
    type:       '${esc(type)}',
  };

  var PHASE_NAMES  = ['introduction','resume','technical','behavioral','closing','done'];
  var PHASE_LABELS = ['INTRO','RESUME','TECHNICAL','BEHAVIORAL','CLOSING','DONE'];
  var SILENCE_MS    = 1800;
  var SILENCE_NUDGE = 20000;

  // ── State ──────────────────────────────────────────────
  var busy = false, playing = false, interviewDone = false;
  var audioQueue = [], transcript = '';
  var debounceTimer = null, silenceTimer = null, startTime = null;
  var currentPhase = 'introduction';

  // ── DOM ────────────────────────────────────────────────
  var $chat     = document.getElementById('chat');
  var $orbWrap  = document.getElementById('orbWrap');
  var $wave     = document.getElementById('waveform');
  var $label    = document.getElementById('statusLabel');
  var $sub      = document.getElementById('statusSub');
  var $timer    = document.getElementById('timer');
  var $phaseTag = document.getElementById('phaseTag');
  var $micBar   = document.getElementById('micBar');
  var $micText  = document.getElementById('micText');
  var $overlay  = document.getElementById('overlay');

  // ── UI helpers ─────────────────────────────────────────
  function setMode(mode, label, sub) {
    $orbWrap.className = 'orb-wrap' + (mode ? ' ' + mode : '');
    $wave.className = 'waveform' + (mode === 'speaking' ? ' active' : '');
    if (label) $label.textContent = label;
    if (sub !== undefined) $sub.textContent = sub;
  }

  function updatePhase(phase) {
    if (phase === currentPhase) return;
    currentPhase = phase;
    var idx = PHASE_NAMES.indexOf(phase);
    if (idx < 0) return;
    $phaseTag.textContent = PHASE_LABELS[idx] || phase.toUpperCase();
    var dots = document.querySelectorAll('.pdot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].className = 'pdot' + (i < idx ? ' done' : i === idx ? ' active' : '');
    }
  }

  function updateTimer() {
    if (!startTime || interviewDone) return;
    var s = Math.floor((Date.now() - startTime) / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    $timer.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    $timer.className = 'timer' + (m >= 25 ? ' expired' : m >= 20 ? ' warning' : '');
  }

  function addBubble(type, text) {
    var div = document.createElement('div');
    div.className = 'bubble ' + type;
    if (type === 'alex') {
      div.innerHTML = '<div class="who">Alex</div>' + esc_(text);
    } else if (type === 'user') {
      div.innerHTML = '<div class="who">' + esc_(CFG.candidate) + '</div>' + esc_(text);
    } else {
      div.className = 'bubble sys';
      div.textContent = text;
    }
    $chat.appendChild(div);
    $chat.scrollTop = $chat.scrollHeight;
  }

  function esc_(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function setMic(text, active) {
    $micText.textContent = text || 'Waiting for speech...';
    $micBar.className = 'mic-bar' + (active ? ' active' : '');
  }

  // ── Audio queue ────────────────────────────────────────
  function enqueueAudio(b64, text) {
    if (text) addBubble('alex', text);
    if (!b64) return;
    audioQueue.push(b64);
    if (!playing) playNext();
  }

  function playNext() {
    if (audioQueue.length === 0) {
      playing = false;
      setMode('', 'Listening...', CFG.candidate + ' - ' + CFG.role);
      resetSilenceTimer();
      return;
    }
    playing = true;
    setMode('speaking', 'Alex is speaking...', '');
    var b64 = audioQueue.shift();
    var audio = new Audio('data:audio/mpeg;base64,' + b64);
    audio.autoplay = true;
    audio.controls = false;
    audio.onended = playNext;
    audio.onerror = function(e) {
      console.error('[Audio] Playback error:', e);
      playNext();
    };
    audio.play().catch(function(err) {
      console.warn('[Audio] Autoplay blocked, retrying...', err.message);
      // Retry after user interaction
      setTimeout(function() {
        audio.play().catch(function() { playNext(); });
      }, 500);
    });
  }

  // ── Silence nudge ──────────────────────────────────────
  function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    if (interviewDone || busy || playing) return;
    silenceTimer = setTimeout(function() {
      if (!interviewDone && !busy && !playing) apiSilence();
    }, SILENCE_NUDGE);
  }

  function apiSilence() {
    fetch(CFG.server + '/api/silence', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId: CFG.sessionId }),
    }).then(function(r) { return r.json(); })
      .then(function(d) { if (d.audio) enqueueAudio(d.audio, d.text); })
      .catch(function() {});
  }

  // ── API: Start ─────────────────────────────────────────
  var startRetries = 0, MAX_START = 5;

  function apiStart() {
    setMode('processing', 'Starting interview...', 'Connecting to server');
    fetch(CFG.server + '/api/start', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        sessionId:     CFG.sessionId,
        candidateName: CFG.candidate,
        role:          CFG.role,
        difficulty:    CFG.difficulty,
        interviewType: CFG.type,
      }),
    }).then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) { setMode('', d.error, 'Error'); return; }
        startTime = Date.now();
        setInterval(updateTimer, 1000);
        if (d.phase) updatePhase(d.phase);
        enqueueAudio(d.audio, d.text);
      })
      .catch(function(e) {
        startRetries++;
        if (startRetries <= MAX_START) {
          setMode('', 'Retry ' + startRetries + '/' + MAX_START + '...', e.message || 'Connection failed');
          setTimeout(apiStart, 3000);
        } else {
          setMode('', 'Could not connect', 'Check server URL');
          addBubble('sys', 'Failed to reach ' + CFG.server);
        }
      });
  }

  // ── API: Respond ───────────────────────────────────────
  function apiRespond(text) {
    if (busy || interviewDone || !text.trim() || text.trim().length < 4) return;
    busy = true;
    clearTimeout(silenceTimer);
    setMode('processing', 'Thinking...', '');
    addBubble('user', text);
    setMic('', false);

    fetch(CFG.server + '/api/respond', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId: CFG.sessionId, text: text }),
    }).then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.phase) updatePhase(d.phase);
        if (d.done) {
          interviewDone = true;
          enqueueAudio(d.audio, d.text);
          setTimeout(function() { $overlay.classList.add('show'); }, 3000);
          return;
        }
        enqueueAudio(d.audio, d.text);
      })
      .catch(function() {
        setMode('', 'Connection error', 'Recovering...');
        setTimeout(function() { setMode('', 'Listening...', ''); }, 2000);
      })
      .finally(function() {
        busy = false;
        transcript = '';
      });
  }

  // ── Recall.ai transcript handler ───────────────────────
  //
  // Recall.ai real-time WebSocket event payloads:
  //
  //   Finalized:
  //   {
  //     "event_type": "transcript.data",
  //     "words": [{"text":"hello","start":1.2,"end":1.5}, ...],
  //     "participant": {"id":"p_abc","name":"John","host":false,"platform":"zoom"},
  //     "metadata": {"bot_id":"bot_xyz","recording_id":"rec_123"}
  //   }
  //
  //   Partial/interim:
  //   {
  //     "event_type": "transcript.partial_data",
  //     "words": [{"text":"hel","start":1.2,"end":1.3}],
  //     "participant": {"id":"p_abc","name":"John"}
  //   }
  //
  function onTranscriptEvent(data) {
    var words = '';

    // 1) Standard Recall.ai real-time format
    if (data.event_type === 'transcript.data' || data.event_type === 'transcript.partial_data') {
      if (Array.isArray(data.words)) {
        words = data.words.map(function(w) { return w.text; }).join(' ');
      }
    }
    // 2) Recall.ai webhook transcript format (fallback)
    else if (typeof data.transcript === 'string') {
      words = data.transcript;
    }
    // 3) Legacy / alternative formats
    else if (Array.isArray(data.words)) {
      words = data.words.map(function(w) { return w.text; }).join(' ');
    } else if (data.data && Array.isArray(data.data.words)) {
      words = data.data.words.map(function(w) { return w.text; }).join(' ');
    }

    if (!words.trim()) return;

    // Filter out bot's own speech by participant name
    var speaker = '';
    if (data.participant && data.participant.name) speaker = data.participant.name;
    else if (data.data && data.data.participant) speaker = data.data.participant.name || '';
    else if (data.speaker) speaker = data.speaker;

    var sLow = speaker.toLowerCase();
    if (sLow.includes('ai interview') || sLow.includes('bot') || sLow.includes('alex')) return;

    // Partial results: show live preview only, don't trigger LLM
    if (data.event_type === 'transcript.partial_data') {
      setMic(words, true);
      return;
    }

    // Finalized transcript: accumulate and debounce 1.8s
    transcript = words;
    setMic(words, true);

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      if (transcript.trim().length >= 4 && !busy && !playing) {
        apiRespond(transcript);
      }
    }, SILENCE_MS);
  }

  // ── Recall.ai transcript webhook handler ─────────────────
  // Recall.ai sends real-time transcript to /webhook/recall/transcript
  // This function is called when manual test input is used instead
  
  // In production with Recall.ai:
  //   - Bot joins meeting
  //   - Recall.ai detects speech
  //   - Sends transcript.data webhook to /webhook/recall/transcript
  //   - Server processes and calls LLM
  //   - Audio response queued automatically
  //
  // For testing (without real meeting):
  //   - Manual input form visible
  //   - User types response
  //   - Simulates /api/respond
  
  // ── Init ───────────────────────────────────────────────
  function requestMicrophonePermission() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(function(stream) {
          console.log('[Permissions] Microphone access granted');
          // Stop the stream immediately (we're just requesting permission)
          stream.getTracks().forEach(function(track) { track.stop(); });
          addBubble('sys', 'Microphone access enabled');
        })
        .catch(function(err) {
          console.warn('[Permissions] Microphone access denied:', err.message);
          // Don't fail - bot can still work via Recall.ai transcript
          addBubble('sys', 'Note: Microphone permission was denied (not required for this bot)');
        });
    }
  }

  function setupTestInput() {
    var testInput = document.getElementById('testInput');
    var testSubmit = document.getElementById('testSubmit');
    
    if (!testInput || !testSubmit) return;

    testSubmit.onclick = function() {
      var text = testInput.value.trim();
      if (text.length >= 4 && !busy && !playing && !interviewDone) {
        apiRespond(text);
        testInput.value = '';
      }
    };

    testInput.onkeypress = function(e) {
      if (e.key === 'Enter') {
        var text = testInput.value.trim();
        if (text.length >= 4 && !busy && !playing && !interviewDone) {
          apiRespond(text);
          testInput.value = '';
        }
      }
    };
  }

  window.addEventListener('load', function() {
    addBubble('sys', 'Connecting to interview server...');
    setupTestInput();
    requestMicrophonePermission();
    apiStart();
    addBubble('sys', 'Waiting for candidate speech or manual input...');
    // In production: Recall.ai sends transcript to /webhook/recall/transcript
    // For testing: Use manual input field below
  });
})();
</script>
</body>
</html>`);
});

// =============================================================================
// Global Error Handler
// =============================================================================
app.use((err, req, res, next) => {
  console.error(`[ERROR] Unhandled error:`, err.message);
  console.error(`[ERROR] Stack:`, err.stack);
  res.status(500).json({
    error: err.message || "Internal server error",
    code: err.code || "UNKNOWN_ERROR",
  });
});

// =============================================================================
// Start
// =============================================================================
server.listen(PORT, () => {
  console.log(`✅ Server: http://localhost:${PORT}`);
  console.log(`   POST /api/schedule-bot   — schedule bot for a meeting`);
  console.log(`   POST /api/batch-schedule — schedule multiple interviews`);
  console.log(`   GET  /api/report/:id     — get interview report`);
  console.log(`   GET  /health             — health check\n`);
});

// Handle listen errors (e.g., port already in use)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ ERROR: Port ${PORT} is already in use. Is another instance running?`);
    console.error(`   Kill with: lsof -ti:${PORT} | xargs kill -9  (or use 'taskkill /pid <pid> /f' on Windows)`);
  } else {
    console.error(`❌ Server error:`, err.message);
  }
  process.exit(1);
});

export { app, server };
