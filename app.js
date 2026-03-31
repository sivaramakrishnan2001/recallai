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

import express from "express";
import cors from "cors";
import { createServer } from "http";
import dotenv from "dotenv";

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
import { scheduleInterviewBot, batchScheduleInterviews } from "./tools/botScheduler.js";

dotenv.config();

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
    const greeting = await getGreeting(session);
    return res.json({
      audio: greeting.audio,
      text: greeting.text,
      phase: session.phase,
      sessionId: session.id,
    });
  } catch (err) {
    console.error(`[/api/start] ${err.message}`);
    return res.status(500).json({ error: err.message });
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
    const response = await getInterviewerResponse(session, text);
    const isDone = session.done;
    let report = null;

    if (isDone) {
      report = generateReport(session);
      console.log(`[Interview] Complete [${sessionId}] score=${report.overall_score}`);
      sendResultsToN8n(session);
    }

    session.processing = false;
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
    console.error(`[/api/respond] ${err.message}`);
    return res.status(500).json({ error: err.message });
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
app.post("/webhook/recall/events", (req, res) => {
  // Payload shape: { event: "bot.in_call_recording", data: { bot: { id, metadata } } }
  const event  = req.body?.event;
  const botId  = req.body?.data?.bot?.id;
  const meta   = req.body?.data?.bot?.metadata || {};

  console.log(`[Recall webhook] ${event} — bot: ${botId}`);

  if (!botId) return res.json({ ok: true });

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
    const session = getSession(sessionId);
    if (session && !session.done) {
      session.done = true;
      sendResultsToN8n(session);
      console.log(`[Recall webhook] Interview finalised for session ${sessionId}`);
    }
  }

  res.json({ ok: true });
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
  const serverUrl  = `https://${serverHost}`;

  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>AI Interview</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}
    #box{background:rgba(255,255,255,.07);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:32px;max-width:580px;width:100%;text-align:center}
    h1{font-size:22px;margin-bottom:4px;color:#a78bfa}
    .meta{font-size:13px;color:#94a3b8;margin-bottom:20px}
    #status{font-size:16px;font-weight:600;padding:12px 20px;border-radius:8px;background:rgba(167,139,250,.15);color:#c4b5fd;margin-bottom:16px;min-height:46px;display:flex;align-items:center;justify-content:center}
    #transcript{background:rgba(0,0,0,.3);border-radius:8px;padding:12px 16px;font-size:13px;color:#94a3b8;min-height:48px;text-align:left;margin-bottom:12px;line-height:1.5;max-height:80px;overflow-y:auto}
    #interviewer{background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:12px 16px;font-size:14px;color:#e2e8f0;min-height:60px;text-align:left;line-height:1.6;max-height:100px;overflow-y:auto}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
    .dot.green{background:#22c55e}.dot.yellow{background:#eab308}.dot.red{background:#ef4444}
  </style>
</head>
<body>
<div id="box">
  <h1>AI Interview</h1>
  <div class="meta"><strong>${esc(candidate)}</strong> &bull; ${esc(role)} &bull; ${esc(difficulty)}</div>
  <div id="status"><span class="dot yellow"></span>Connecting…</div>
  <div id="transcript">Candidate speech will appear here…</div>
  <div id="interviewer">Interviewer response will appear here…</div>
</div>
<script>
(function() {
  const CFG = {
    sessionId: 'bot-${Date.now()}',
    server:    '${serverUrl}',
    role:      '${esc(role)}',
    candidate: '${esc(candidate)}',
    difficulty:'${esc(difficulty)}',
    type:      '${esc(type)}',
  };

  // ── State ──────────────────────────────────────────────
  let busy       = false;   // waiting for LLM/TTS response
  let audioQueue = [];      // queued base64 MP3s to play
  let playing    = false;   // currently playing audio
  let transcript = "";      // accumulated candidate speech
  let debounce   = null;    // silence debounce timer
  const SILENCE_MS = 1800;  // send after 1.8s of silence

  // ── UI helpers ─────────────────────────────────────────
  function setStatus(dot, msg) {
    document.getElementById('status').innerHTML =
      '<span class="dot ' + dot + '"></span>' + msg;
  }
  function showTranscript(t) {
    document.getElementById('transcript').textContent = t || 'Listening…';
  }
  function showInterviewer(t) {
    document.getElementById('interviewer').textContent = t || '';
  }

  // ── Audio queue ────────────────────────────────────────
  function enqueueAudio(b64, text) {
    if (text) showInterviewer(text);
    if (!b64) return;
    audioQueue.push(b64);
    if (!playing) playNext();
  }

  function playNext() {
    if (audioQueue.length === 0) { playing = false; setStatus('green','Listening…'); return; }
    playing = true;
    setStatus('yellow','Speaking…');
    const b64 = audioQueue.shift();
    const audio = new Audio('data:audio/mpeg;base64,' + b64);
    audio.onended = playNext;
    audio.onerror = () => { console.error('Audio playback error'); playNext(); };
    audio.play().catch(e => { console.error('Play failed:', e); playNext(); });
  }

  // ── API calls ──────────────────────────────────────────
  async function apiStart() {
    setStatus('yellow','Starting interview…');
    try {
      const r = await fetch(CFG.server + '/api/start', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          sessionId:     CFG.sessionId,
          candidateName: CFG.candidate,
          role:          CFG.role,
          difficulty:    CFG.difficulty,
          interviewType: CFG.type,
        }),
      });
      const d = await r.json();
      if (d.error) { setStatus('red', d.error); return; }
      enqueueAudio(d.audio, d.text);
      setStatus('green','Interview started — listening');
    } catch(e) {
      setStatus('red','Start failed: ' + e.message);
    }
  }

  async function apiRespond(text) {
    if (busy || !text.trim() || text.trim().length < 4) return;
    busy = true;
    setStatus('yellow','Processing…');
    showTranscript('You: ' + text);
    try {
      const r = await fetch(CFG.server + '/api/respond', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sessionId: CFG.sessionId, text }),
      });
      const d = await r.json();
      if (d.done) {
        enqueueAudio(d.audio, d.text);
        setStatus('green','Interview complete');
        return;
      }
      enqueueAudio(d.audio, d.text);
    } catch(e) {
      setStatus('red','Error: ' + e.message);
    } finally {
      busy = false;
      transcript = '';
    }
  }

  // ── Transcript debouncer ───────────────────────────────
  // Recall.ai sends transcript events continuously.
  // We accumulate words and only send after SILENCE_MS of silence.
  function onTranscriptEvent(data) {
    // Support both Recall.ai formats:
    // Format 1: { transcript: "text", is_final: true }
    // Format 2: { words: [{text}], data: { words: [{text}] } }
    let words = "";
    if (typeof data.transcript === "string") {
      words = data.transcript;
    } else if (Array.isArray(data.words)) {
      words = data.words.map(w => w.text).join(" ");
    } else if (data.data && Array.isArray(data.data.words)) {
      words = data.data.words.map(w => w.text).join(" ");
    }

    if (!words.trim()) return;

    // Skip interviewer's own audio being transcribed
    const speaker = data.speaker || data.participant?.name || data.data?.participant?.name || "";
    if (speaker.toLowerCase().includes("ai interview") || speaker.toLowerCase().includes("bot")) return;

    transcript = words;
    showTranscript('You: ' + transcript);

    // Wait for silence before sending
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (transcript.trim().length >= 4) {
        apiRespond(transcript);
      }
    }, SILENCE_MS);
  }

  // ── Recall.ai transcript WebSocket ────────────────────
  // Connect to the Recall.ai meeting transcript stream.
  // This WebSocket is available inside the bot's browser context.
  let wsRetries = 0;
  const MAX_WS_RETRIES = 10;
  
  function connectTranscriptWS() {
    // Try multiple endpoints with fallback strategy
    const endpoints = [
      'wss://meeting-data.bot.recall.ai/api/v1/transcript',  // Standard endpoint
      'wss://internal.recall.ai/v1/meeting/transcript',       // Alternative endpoint
      'wss://ws.recall.ai/transcript',                        // Backup endpoint
    ];
    
    const endpoint = endpoints[Math.min(wsRetries, endpoints.length - 1)];
    
    try {
      console.log('[WS] Attempting connection to ' + endpoint);
      const ws = new WebSocket(endpoint);
      
      ws.onopen = () => {
        console.log('[WS] ✓ Transcript WebSocket connected');
        wsRetries = 0; // Reset retries on success
        setStatus('green','Listening…');
      };
      
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onTranscriptEvent(data);
        } catch(err) {
          console.warn('[WS] Parse error:', err.message);
        }
      };
      
      ws.onclose = () => {
        console.log('[WS] Connection closed, retrying…');
        ws.cleaned = true;
        // Exponential backoff: 1s, 2s, 4s, 8s, etc.
        const delay = Math.min(1000 * Math.pow(2, wsRetries), 30000);
        wsRetries++;
        if (wsRetries <= MAX_WS_RETRIES) {
          setTimeout(connectTranscriptWS, delay);
        } else {
          console.error('[WS] Max retries exceeded. Manual transcript submission recommended.');
          setStatus('yellow','WebSocket unavailable — manual transcript submission enabled');
        }
      };
      
      ws.onerror = (e) => {
        console.error('[WS] Connection error:', e.message || e);
        if (!ws.cleaned) ws.close();
      };
    } catch(e) {
      console.error('[WS] Failed to create WebSocket:', e.message);
      const delay = Math.min(1000 * Math.pow(2, wsRetries), 30000);
      wsRetries++;
      if (wsRetries <= MAX_WS_RETRIES) {
        setTimeout(connectTranscriptWS, delay);
      }
    }
  }

  // ── Init ───────────────────────────────────────────────
  window.addEventListener('load', async () => {
    console.log('[Init] Starting interview...');
    await apiStart();
    
    // Delay WebSocket connection to allow bot initialization
    // Recall.ai bot may take 1-2 seconds to fully initialize
    console.log('[Init] Waiting for bot context to initialize...');
    setTimeout(() => {
      console.log('[Init] Connecting to transcript stream...');
      connectTranscriptWS();
    }, 2000); // 2 second delay for bot initialization
  });
})();
</script>
</body>
</html>`);
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

export { app, server };
