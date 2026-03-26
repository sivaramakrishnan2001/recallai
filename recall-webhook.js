// =============================================================================
// AI Interview Bot — recall-webhook.js
// Stack: Recall.ai (meeting bot) · OpenAI GPT-4o-mini · ElevenLabs TTS · n8n
// =============================================================================

import express from "express";
import { createServer } from "http";
import dotenv from "dotenv";

dotenv.config();

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const PORT             = process.env.PORT             || 3000;
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const OPENAI_MODEL     = "gpt-4o-mini";               // swap to "gpt-4o" if needed
const ELEVENLABS_KEY   = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const N8N_WEBHOOK_URL  = process.env.N8N_WEBHOOK_URL;

const SESSION_TTL_MS   = 3 * 60 * 60 * 1000;         // 3 hours
const SESSION_GC_MS    = 30 * 60 * 1000;              // cleanup every 30 min
const TOTAL_QUESTIONS  = 2;

// Simple logger
const log = {
  info:  (msg) => console.log(`[INFO]  ${msg}`),
  warn:  (msg) => console.warn(`[WARN]  ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
};

log.info("=== Startup Checks ===");
log.info(`OPENAI_API_KEY   : ${OPENAI_API_KEY ? "✅" : "❌ MISSING"}`);
log.info(`ELEVENLABS_KEY   : ${ELEVENLABS_KEY ? "✅" : "❌ MISSING"}`);
log.info(`N8N_WEBHOOK_URL  : ${N8N_WEBHOOK_URL ? "✅" : "⚠️  not set"}`);
log.info("======================");

// -----------------------------------------------------------------------------
// Session Store
// -----------------------------------------------------------------------------
const sessions = new Map();

function createSession(id, role) {
  const session = {
    id,
    role,
    questions:     [],
    currentQ:      0,
    history:       [],          // { role: "user"|"assistant", content: string }[]
    metrics:       { clarity: 0, depth: 0, communication: 0, overall: 0 },
    responseCount: 0,
    processing:    false,
    lastText:      "",
    startTime:     Date.now(),
    done:          false,
  };
  sessions.set(id, session);
  log.info(`✅ Session created [${id}] role="${role}"`);
  return session;
}

// Remove sessions older than SESSION_TTL_MS
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.startTime < cutoff) sessions.delete(id);
  }
}, SESSION_GC_MS);

// -----------------------------------------------------------------------------
// Express Setup
// -----------------------------------------------------------------------------
const app    = express();
const server = createServer(app);

app.use(express.json({ limit: "10mb" }));

// Allow requests from any origin (needed for Recall.ai headless browser)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (req, res) => res.sendStatus(204));

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

// -----------------------------------------------------------------------------
// POST /api/start
// Called once by the meeting page when it first connects.
// Generates 2 interview questions and returns a greeting with TTS audio.
// -----------------------------------------------------------------------------
app.post("/api/start", async (req, res) => {
  const { sessionId, role = "Software Engineer" } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const session = sessions.get(sessionId) || createSession(sessionId, role);

  try {
    // Generate questions only once per session
    if (session.questions.length === 0) {
      log.info(`🧠 Generating questions for role: ${role}`);
      session.questions = await generateQuestions(role);
    }

    const greeting =
      `Hi! I'm your AI interviewer today for the ${role} position. ` +
      `I have just two questions for you — take your time and answer naturally. ` +
      `Here's the first one: ${session.questions[0]}`;

    const audio = await textToSpeech(greeting);

    return res.json({
      audio,
      greeting,
      questions:      session.questions,
      totalQuestions: session.questions.length,
    });

  } catch (err) {
    log.error(`/api/start: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// POST /api/respond
// Called whenever the candidate finishes speaking (after a silence gap).
// Evaluates the answer, updates metrics, and returns the next response.
// -----------------------------------------------------------------------------
app.post("/api/respond", async (req, res) => {
  const { sessionId, text } = req.body || {};

  // --- Input validation ---
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }
  if (!text || text.trim().length < 3) {
    return res.status(400).json({ error: "Answer is too short" });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found — call /api/start first" });
  }

  // --- Guard against duplicate / concurrent requests ---
  if (session.done)       return res.json({ done: true, metrics: session.metrics });
  if (session.processing) return res.status(429).json({ error: "Still processing previous answer" });
  if (text.trim() === session.lastText) return res.status(429).json({ error: "Duplicate answer" });

  session.processing = true;
  session.lastText   = text.trim();

  try {
    const currentQuestion = session.questions[session.currentQ] || "Thank you for your answers.";
    log.info(`💬 [${sessionId}] Q${session.currentQ + 1}: "${text.substring(0, 80)}"`);

    // Record answer and get AI evaluation
    session.history.push({ role: "user", content: text });
    const evaluation = await evaluateAnswer(session, currentQuestion, text);
    session.history.push({ role: "assistant", content: evaluation.text });
    updateMetrics(session, evaluation.metrics);

    // Decide what the bot says next
    let spokenReply = evaluation.text;
    let isDone      = false;

    if (evaluation.readyForNext) {
      const hasMoreQuestions = session.currentQ < session.questions.length - 1;

      if (hasMoreQuestions) {
        session.currentQ++;
        spokenReply += " " + session.questions[session.currentQ];
        log.info(`➡️  Moving to Q${session.currentQ + 1}`);
      } else {
        isDone       = true;
        session.done = true;
        spokenReply += " That wraps up our interview. Thank you so much — we'll be in touch!";
        log.info(`🏁 Interview complete [${sessionId}]`);
        sendResultsToN8n(session);
      }
    }

    const audio = await textToSpeech(spokenReply);
    session.processing = false;

    return res.json({
      audio,
      text:           spokenReply,
      metrics:        session.metrics,
      questionIndex:  session.currentQ,
      totalQuestions: session.questions.length,
      currentQ:       session.questions[session.currentQ] || null,
      done:           isDone,
    });

  } catch (err) {
    session.processing = false;
    log.error(`/api/respond: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// POST /webhook/recall/events
// Recall.ai lifecycle events (bot joined, call ended, etc.)
// -----------------------------------------------------------------------------
app.post("/webhook/recall/events", (req, res) => {
  const event = req.body?.event;
  const botId = req.body?.data?.bot?.id;

  log.info(`📨 Recall event: ${event}  bot=${botId}`);
  res.json({ status: "ok" });

  if (event === "bot.call_ended" && botId) {
    const session = sessions.get(botId);
    if (session && !session.done) {
      sendResultsToN8n(session);
      sessions.delete(botId);
    }
  }
});

// -----------------------------------------------------------------------------
// GET /meeting-page?server=DOMAIN&role=ROLE
// Serves the HTML UI that runs inside Recall.ai's headless browser.
// Connects to Recall.ai's transcript WebSocket and drives the interview.
// -----------------------------------------------------------------------------
app.get("/meeting-page", (req, res) => {
  const serverUrl = req.query.server
    ? `https://${req.query.server}`
    : `http://localhost:${PORT}`;

  const role = req.query.role
    ? decodeURIComponent(req.query.role)
    : "Software Engineer";

  const html = buildMeetingPageHTML(serverUrl, role);

  // Allow this page to be embedded in Teams / iframes
  res.removeHeader("X-Frame-Options");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.type("text/html").send(html);
});

// -----------------------------------------------------------------------------
// AI: Generate 2 role-specific interview questions
// -----------------------------------------------------------------------------
async function generateQuestions(role) {
  const prompt = `
Generate exactly 2 interview questions for a ${role} position.
Return ONLY a valid JSON array of 2 strings — no explanation, no numbering.
Example: ["First question?", "Second question?"]
One question should be about past experience, the other about a technical or problem-solving scenario.
  `.trim();

  try {
    const responseText = await callOpenAI(
      [{ role: "user", content: prompt }],
      null,
      400
    );

    const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const questions = JSON.parse(jsonMatch[0]);
      if (Array.isArray(questions) && questions.length >= 2) {
        log.info(`✅ Generated ${questions.length} questions for: ${role}`);
        return questions.slice(0, TOTAL_QUESTIONS);
      }
    }
  } catch (err) {
    log.error(`generateQuestions: ${err.message}`);
  }

  // Fallback questions — used if AI call fails
  log.warn("Using fallback questions");
  return [
    `Tell me about your experience as a ${role} — what project are you most proud of and why?`,
    `Describe a difficult technical problem you faced and how you solved it.`,
  ];
}

// -----------------------------------------------------------------------------
// AI: Evaluate a candidate's answer and return a response + scores
// -----------------------------------------------------------------------------
async function evaluateAnswer(session, question, answer) {
  const systemPrompt = `
You are a warm, professional interviewer for a ${session.role} position.
The current question was: "${question}"
The candidate just answered. Respond in 1-2 sentences only.
Briefly acknowledge what they said and transition naturally.
Do NOT repeat the next question — the system will append it automatically.

End your response with EXACTLY this tag on its own line:
[SCORE] clarity:N depth:N comm:N next:yes
Where N is 1–10. Use next:yes when satisfied and ready to move on.
  `.trim();

  try {
    const messages = session.history.map(({ role, content }) => ({ role, content }));
    const fullResponse = await callOpenAI(messages, systemPrompt, 250);

    const scoreMatch = fullResponse.match(
      /\[SCORE\]\s*clarity:(\d+)\s*depth:(\d+)\s*comm:(\d+)\s*next:(yes|no)/i
    );

    const metrics = scoreMatch
      ? { clarity: +scoreMatch[1], depth: +scoreMatch[2], communication: +scoreMatch[3] }
      : { clarity: 6, depth: 6, communication: 6 };

    const readyForNext = scoreMatch ? scoreMatch[4].toLowerCase() === "yes" : true;
    const text = fullResponse.replace(/\[SCORE\].*$/im, "").trim()
      || "Thank you for that. Let's continue.";

    return { text, metrics, readyForNext };

  } catch (err) {
    log.error(`evaluateAnswer: ${err.message}`);
    return {
      text:         "Thank you for sharing that.",
      metrics:      { clarity: 6, depth: 6, communication: 6 },
      readyForNext: true,
    };
  }
}

// -----------------------------------------------------------------------------
// OpenAI: Chat completion — returns the assistant's reply as a string
// -----------------------------------------------------------------------------
async function callOpenAI(messages, systemPrompt, maxTokens = 300) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const payload = {
    model:      OPENAI_MODEL,
    max_tokens: maxTokens,
    messages:   systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI ${response.status}: ${errorText.substring(0, 200)}`);
  }

  const json = await response.json();
  const text = json.choices?.[0]?.message?.content || "";
  log.info(`✅ OpenAI OK — ${json.usage?.total_tokens ?? "?"} tokens used`);
  return text;
}

// -----------------------------------------------------------------------------
// ElevenLabs TTS: Convert text to speech, return base64-encoded MP3
// -----------------------------------------------------------------------------
async function textToSpeech(text) {
  if (!ELEVENLABS_KEY || !text) return null;

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      {
        method:  "POST",
        headers: {
          "xi-api-key":   ELEVENLABS_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id:      "eleven_monolingual_v1",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!response.ok) {
      log.error(`TTS ${response.status}: ${await response.text()}`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    log.info(`🎵 TTS ${(buffer.byteLength / 1024).toFixed(1)}KB — "${text.substring(0, 50)}"`);
    return Buffer.from(buffer).toString("base64");

  } catch (err) {
    log.error(`TTS error: ${err.message}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Metrics: Rolling average of clarity, depth, communication scores (1–10)
// -----------------------------------------------------------------------------
function updateMetrics(session, newScores) {
  session.responseCount++;
  const count   = session.responseCount;
  const metrics = session.metrics;

  // Rolling average formula: new_avg = (old_avg * (n-1) + new_value) / n
  metrics.clarity       = rollingAvg(metrics.clarity,       newScores.clarity       || 6, count);
  metrics.depth         = rollingAvg(metrics.depth,         newScores.depth         || 6, count);
  metrics.communication = rollingAvg(metrics.communication, newScores.communication || 6, count);

  // Overall is the average of all three, scaled to 100
  metrics.overall = Math.round(((metrics.clarity + metrics.depth + metrics.communication) / 3) * 10);
}

function rollingAvg(previous, newValue, count) {
  return Math.round((previous * (count - 1) + newValue) / count);
}

// -----------------------------------------------------------------------------
// n8n: Send interview results to Google Sheets via n8n webhook
// -----------------------------------------------------------------------------
async function sendResultsToN8n(session) {
  if (!N8N_WEBHOOK_URL) return;

  try {
    await fetch(N8N_WEBHOOK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        sessionId:     session.id,
        role:          session.role,
        metrics:       session.metrics,
        questionsAsked: session.currentQ + 1,
        transcript:    session.history,
        timestamp:     new Date().toISOString(),
      }),
    });
    log.info("📊 Interview results sent to n8n");
  } catch (err) {
    log.error(`n8n webhook: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Meeting Page HTML
// Runs inside Recall.ai's headless Chromium.
// Connects to Recall.ai transcript WebSocket and drives the interview via API.
// -----------------------------------------------------------------------------
function buildMeetingPageHTML(serverUrl, role) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AI Interview Bot</title>
  <style>
    /* ── Reset & Base ── */
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }

    .card {
      background: #fff;
      border-radius: 24px;
      padding: 32px 36px;
      width: 100%;
      max-width: 760px;
      box-shadow: 0 32px 80px rgba(0, 0, 0, 0.6);
    }

    h1    { text-align: center; font-size: 22px; color: #1a1a2e; margin-bottom: 2px; }
    .sub  { text-align: center; font-size: 11px; color: #999; margin-bottom: 8px; }

    .badge {
      display: block;
      width: fit-content;
      margin: 0 auto 22px;
      background: #ede7f6;
      color: #512da8;
      font-size: 12px;
      font-weight: 700;
      padding: 4px 16px;
      border-radius: 20px;
    }

    /* ── Status Bar ── */
    .status {
      padding: 11px 18px;
      border-radius: 10px;
      text-align: center;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 18px;
      transition: background 0.3s, color 0.3s;
    }
    .status.idle      { background: #f5f5f5; color: #888; }
    .status.listening { background: #e8f5e9; color: #2e7d32; }
    .status.thinking  { background: #fff8e1; color: #e65100; }
    .status.speaking  { background: #e3f2fd; color: #1565c0; }
    .status.done      { background: #f3e5f5; color: #6a1b9a; }

    /* ── Waveform Animation ── */
    .wave {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 42px;
      margin: 12px 0;
    }
    .wave-bar {
      width: 5px;
      border-radius: 3px;
      background: linear-gradient(180deg, #7c3aed, #2563eb);
      transition: height 0.15s;
    }
    .wave-bar:nth-child(1) { height: 8px;  animation-delay: 0.00s; }
    .wave-bar:nth-child(2) { height: 16px; animation-delay: 0.08s; }
    .wave-bar:nth-child(3) { height: 28px; animation-delay: 0.16s; }
    .wave-bar:nth-child(4) { height: 36px; animation-delay: 0.24s; }
    .wave-bar:nth-child(5) { height: 28px; animation-delay: 0.32s; }
    .wave-bar:nth-child(6) { height: 16px; animation-delay: 0.40s; }
    .wave-bar:nth-child(7) { height: 8px;  animation-delay: 0.48s; }
    .wave.active .wave-bar { animation: wavePulse 0.5s ease-in-out infinite; }
    @keyframes wavePulse {
      0%, 100% { transform: scaleY(0.6); }
      50%       { transform: scaleY(1.4); }
    }

    /* ── Metrics Cards ── */
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .metric-card {
      background: #fafafe;
      border: 1px solid #e8eaf6;
      border-radius: 12px;
      padding: 14px;
      text-align: center;
    }
    .metric-card label {
      display: block;
      font-size: 10px;
      color: #9fa8da;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .metric-value {
      font-size: 28px;
      font-weight: 800;
      color: #5c35c8;
    }
    .overall-score {
      text-align: center;
      font-size: 12px;
      color: #999;
      margin-bottom: 18px;
    }
    .overall-score b { color: #5c35c8; font-size: 14px; }

    /* ── Question Box ── */
    .question-box {
      border-left: 4px solid #7c3aed;
      background: #f9f9ff;
      padding: 15px 18px;
      border-radius: 0 12px 12px 0;
      margin-bottom: 14px;
      min-height: 64px;
    }
    .question-label {
      font-size: 10px;
      color: #aaa;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .question-text {
      color: #1a1a2e;
      font-size: 14px;
      line-height: 1.6;
      font-weight: 500;
    }

    /* ── Transcript Box ── */
    .transcript-box {
      background: #fafafa;
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 12px;
      min-height: 36px;
    }
    .transcript-label {
      font-size: 10px;
      color: #bbb;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 3px;
    }
    .transcript-text {
      font-size: 13px;
      color: #666;
      font-style: italic;
      line-height: 1.5;
    }

    /* ── Progress Bar ── */
    .progress-wrap  { margin-bottom: 6px; }
    .progress-track {
      height: 5px;
      background: #eee;
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 5px;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #7c3aed, #2563eb);
      border-radius: 3px;
      transition: width 0.5s;
      width: 0%;
    }
    .progress-label { text-align: center; font-size: 11px; color: #bbb; }

    /* ── Debug Log ── */
    #debug-log {
      font-size: 10px;
      color: #ccc;
      text-align: center;
      margin-top: 8px;
      min-height: 14px;
    }
  </style>
</head>
<body>

<div class="card">
  <h1>🎤 AI Interview Bot</h1>
  <p class="sub">Powered by OpenAI GPT-4o · ElevenLabs Voice</p>
  <span class="badge">Position: ${role}</span>

  <div class="status idle" id="status">⏳ Connecting to meeting...</div>

  <div class="wave" id="wave">
    <div class="wave-bar"></div>
    <div class="wave-bar"></div>
    <div class="wave-bar"></div>
    <div class="wave-bar"></div>
    <div class="wave-bar"></div>
    <div class="wave-bar"></div>
    <div class="wave-bar"></div>
  </div>

  <div class="metrics">
    <div class="metric-card">
      <label>Clarity</label>
      <div class="metric-value" id="metric-clarity">--</div>
    </div>
    <div class="metric-card">
      <label>Tech Depth</label>
      <div class="metric-value" id="metric-depth">--</div>
    </div>
    <div class="metric-card">
      <label>Communication</label>
      <div class="metric-value" id="metric-comm">--</div>
    </div>
  </div>
  <div class="overall-score">Overall: <b id="metric-overall">--</b> / 100</div>

  <div class="question-box">
    <div class="question-label">Current Question</div>
    <div class="question-text" id="current-question">Initializing...</div>
  </div>

  <div class="transcript-box">
    <div class="transcript-label">Candidate is saying...</div>
    <div class="transcript-text" id="transcript">(listening)</div>
  </div>

  <div class="progress-wrap">
    <div class="progress-track">
      <div class="progress-fill" id="progress-fill"></div>
    </div>
    <div class="progress-label" id="progress-label">Starting up...</div>
  </div>

  <div id="debug-log"></div>
</div>

<audio id="audio-player" autoplay playsinline style="display:none"></audio>

<script>
// ── Configuration (injected server-side) ─────────────────────────────────────
const SERVER_URL = '${serverUrl}';
const ROLE       = '${role}';
const SESSION_ID = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

// ── State ─────────────────────────────────────────────────────────────────────
const audioQueue  = [];
let questions     = [];
let questionIndex = 0;
let totalQuestions = 2;
let isDone        = false;
let isPlaying     = false;
let isThinking    = false;
let accumulated   = '';
let silenceTimer  = null;
let lastSentText  = '';

const SILENCE_DELAY_MS = 1800;   // wait this long after last word before processing

// ── DOM Helpers ───────────────────────────────────────────────────────────────
const el = (id) => document.getElementById(id);

function debug(msg) {
  el('debug-log').textContent = msg;
  console.log('[BOT]', msg);
}

function setStatus(type, msg) {
  const statusEl = el('status');
  statusEl.className = 'status ' + type;
  statusEl.textContent = msg;
  el('wave').className = 'wave' + (type === 'speaking' ? ' active' : '');
}

function setMetrics(metrics) {
  if (!metrics) return;
  el('metric-clarity').textContent = metrics.clarity       ?? '--';
  el('metric-depth').textContent   = metrics.depth         ?? '--';
  el('metric-comm').textContent    = metrics.communication ?? '--';
  el('metric-overall').textContent = metrics.overall       ?? '--';
}

function setProgress(index, total) {
  el('progress-fill').style.width = ((index + 1) / total * 100) + '%';
  el('progress-label').textContent = 'Question ' + (index + 1) + ' of ' + total;
}

// ── Audio Playback Queue ──────────────────────────────────────────────────────
function enqueueAudio(base64, label) {
  if (!base64) return;
  audioQueue.push({ base64, label });
  playNextAudio();
}

function playNextAudio() {
  if (isPlaying || audioQueue.length === 0) return;
  isPlaying = true;

  const { base64, label } = audioQueue.shift();
  debug('🔊 ' + label.substring(0, 70));
  setStatus('speaking', '🗣️ Speaking...');

  try {
    // Decode base64 → Blob URL → play in <audio>
    const raw    = atob(base64);
    const bytes  = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));

    const player = el('audio-player');
    player.src = blobUrl;

    player.onended = () => {
      URL.revokeObjectURL(blobUrl);
      isPlaying = false;
      setStatus('listening', '👂 Listening...');
      playNextAudio();
    };
    player.onerror = () => {
      isPlaying = false;
      playNextAudio();
    };
    player.play().catch((err) => {
      debug('play() failed: ' + err.message);
      isPlaying = false;
      playNextAudio();
    });

  } catch (err) {
    debug('Audio error: ' + err.message);
    isPlaying = false;
    playNextAudio();
  }
}

// ── API Calls ─────────────────────────────────────────────────────────────────
async function apiStart() {
  debug('Starting session...');
  setStatus('thinking', '🧠 Generating questions for ' + ROLE + '...');

  try {
    const response = await fetch(SERVER_URL + '/api/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sessionId: SESSION_ID, role: ROLE }),
    });

    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + await response.text());

    const data = await response.json();
    questions      = data.questions || [];
    totalQuestions = data.totalQuestions || 2;

    el('current-question').textContent = questions[0] || 'Interview starting...';
    setProgress(0, totalQuestions);
    debug('✅ Session started — playing greeting');
    enqueueAudio(data.audio, data.greeting || '');

  } catch (err) {
    debug('Start error: ' + err.message);
    setStatus('idle', '❌ Failed to start: ' + err.message.substring(0, 60));
  }
}

async function apiRespond(candidateText) {
  if (isDone || isThinking) return;

  const text = candidateText.trim();
  if (text.length < 4 || text === lastSentText) return;

  lastSentText = text;
  isThinking   = true;
  el('transcript').textContent = '(processing your answer...)';
  setStatus('thinking', '🧠 Thinking...');

  try {
    const response = await fetch(SERVER_URL + '/api/respond', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sessionId: SESSION_ID, text }),
    });

    isThinking = false;

    if (response.status === 429) return;   // busy or duplicate — silently ignore
    if (!response.ok) {
      const err = await response.text();
      throw new Error('HTTP ' + response.status + ': ' + err);
    }

    const data = await response.json();
    setMetrics(data.metrics);

    questionIndex = data.questionIndex ?? questionIndex;
    setProgress(questionIndex, data.totalQuestions ?? totalQuestions);
    if (data.currentQ) el('current-question').textContent = data.currentQ;

    if (data.done) {
      isDone = true;
      el('current-question').textContent = '✅ Interview complete — thank you!';
      setStatus('done', '✅ All done!');
    }

    enqueueAudio(data.audio, data.text || '');

  } catch (err) {
    isThinking = false;
    debug('Respond error: ' + err.message.substring(0, 80));
    setStatus('listening', '👂 Listening...');
  }
}

// ── Recall.ai Transcript WebSocket ───────────────────────────────────────────
// This page runs inside Recall.ai's headless browser.
// Recall.ai exposes a local transcript WebSocket — no auth needed.
let ws;
let reconnectAttempts = 0;

function connectTranscriptFeed() {
  debug('Connecting to transcript feed...');

  try {
    ws = new WebSocket('wss://meeting-data.bot.recall.ai/api/v1/transcript');
  } catch (err) {
    debug('WebSocket init failed: ' + err.message);
    setTimeout(connectTranscriptFeed, 4000);
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0;
    debug('✅ Transcript feed connected');
    setStatus('listening', '👂 Connected — starting interview...');
    apiStart();
  };

  ws.onmessage = (event) => {
    // Ignore transcript while bot is speaking or processing — prevents self-echo
    if (isPlaying || isThinking || isDone) return;

    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    // Extract words from Recall.ai transcript payload
    const words = data?.transcript?.words || data?.words || [];
    if (!words.length) return;

    const chunk = words.map(w => w.text || w.word || '').join(' ').trim();
    if (!chunk) return;

    // Accumulate words and show live transcript
    accumulated = accumulated ? accumulated + ' ' + chunk : chunk;
    el('transcript').textContent = accumulated;

    // After SILENCE_DELAY_MS with no new words, send the full accumulated text
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const finalText = accumulated.trim();
      accumulated = '';
      el('transcript').textContent = '(listening)';

      if (finalText.length > 4) {
        debug('📝 Processing: ' + finalText.substring(0, 80));
        apiRespond(finalText);
      }
    }, SILENCE_DELAY_MS);
  };

  ws.onerror = (err) => debug('WebSocket error: ' + (err.message || 'unknown'));

  ws.onclose = () => {
    if (isDone) return;
    const delay = Math.min(2000 * (++reconnectAttempts), 15000);
    debug('WebSocket closed — reconnecting in ' + (delay / 1000) + 's');
    setStatus('idle', '⏳ Reconnecting...');
    setTimeout(connectTranscriptFeed, delay);
  };
}

// Start
connectTranscriptFeed();
</script>

</body>
</html>`;
}

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------
server.listen(PORT, () => {
  log.info(`\n🚀 AI Interview Bot running on port ${PORT}`);
  log.info(`   Meeting page : /meeting-page?server=YOUR_NGROK_HOST&role=Frontend+Developer`);
  log.info(`   API start    : POST /api/start`);
  log.info(`   API respond  : POST /api/respond`);
  log.info(`   Health check : GET  /health\n`);
});
