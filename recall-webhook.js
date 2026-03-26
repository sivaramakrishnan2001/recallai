import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const log = {
  info:  (m) => console.log(`[INFO]  ${m}`),
  warn:  (m) => console.warn(`[WARN]  ${m}`),
  error: (m) => console.error(`[ERROR] ${m}`),
  debug: (m) => { if (process.env.DEBUG) console.log(`[DEBUG] ${m}`); },
};

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT               = process.env.PORT               || 3000;
const RECALL_API_KEY     = process.env.RECALL_API_KEY;
const BEDROCK_API_KEY    = process.env.BEDROCK_API_KEY;
const BEDROCK_KEY_NAME   = process.env.BEDROCK_API_KEY_NAME;
const AWS_REGION         = process.env.AWS_REGION         || "us-east-1";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE   = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

log.info("=== STARTUP CHECKS ===");
log.info(`RECALL_API_KEY     : ${RECALL_API_KEY     ? "✅" : "❌ MISSING"}`);
log.info(`BEDROCK_API_KEY    : ${BEDROCK_API_KEY    ? "✅" : "❌ MISSING"}`);
log.info(`ELEVENLABS_API_KEY : ${ELEVENLABS_API_KEY ? "✅" : "❌ MISSING"}`);
log.info(`ELEVENLABS_VOICE   : ${ELEVENLABS_VOICE}`);
log.info(`N8N_WEBHOOK_URL    : ${process.env.N8N_WEBHOOK_URL || "not set"}`);
log.info("======================");

if (!BEDROCK_API_KEY || !BEDROCK_KEY_NAME) {
  log.error("AWS Bedrock credentials missing — exiting");
  process.exit(1);
}

// ─── AWS Bedrock ─────────────────────────────────────────────────────────────
const bedrockClient = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     BEDROCK_KEY_NAME,
    secretAccessKey: BEDROCK_API_KEY,
  },
});

// ─── Interview config ─────────────────────────────────────────────────────────
const INTERVIEW_CONFIG = {
  position: "Software Engineer",
  questions: [
    { id: 1, text: "Tell me about your experience with backend development." },
    { id: 2, text: "How would you design a scalable REST API?" },
    { id: 3, text: "Describe a challenging project and how you overcame obstacles." },
    { id: 4, text: "What are your strongest technical skills and why?" },
    { id: 5, text: "Where do you see yourself in 5 years?" },
  ],
  systemPrompt: `You are a professional technical interviewer for a Software Engineer position.
Evaluate the candidate's response and reply conversationally.
At the end of your reply always include exactly this line:
[METRIC] clarity:N depth:N communication:N next:yes/no
Where N is 0-10 and next:yes means move to next question.
Keep responses concise (2-4 sentences max).`,
};

// ─── Session store ────────────────────────────────────────────────────────────
const sessions = new Map();

function getOrCreate(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id:            sessionId,
      currentQ:      0,
      questions:     INTERVIEW_CONFIG.questions,
      history:       [],
      metrics:       { clarity: 0, depth: 0, communication: 0, overall: 0 },
      responseCount: 0,
      processing:    false,
      lastResponse:  null,
      startTime:     Date.now(),
    });
    log.info(`✅ Session created: ${sessionId}`);
  }
  return sessions.get(sessionId);
}

// Clean up sessions older than 3 hours
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.startTime < cutoff) { sessions.delete(id); log.info(`🗑️  Cleaned session ${id}`); }
  }
}, 30 * 60 * 1000);

// ─── Express ──────────────────────────────────────────────────────────────────
const app    = express();
const server = createServer(app);      // ← proper HTTP server for WS upgrade

app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", sessions: sessions.size }));

// ─────────────────────────────────────────────────────────────────────────────
// /api/speak  — called by the MEETING PAGE to process transcript + get TTS audio
//
// POST body: { sessionId, text, isGreeting? }
// Response:  { audio: "<base64 mp3>", text: "...", metrics, questionIndex, totalQuestions, done }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/speak", async (req, res) => {
  const { sessionId, text, isGreeting } = req.body;

  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const session = getOrCreate(sessionId);

  // ── Greeting (first call when bot joins) ────────────────────────────────
  if (isGreeting) {
    const greetingText =
      `Hello! I'm your AI interview assistant. ` +
      `Today we're conducting a ${INTERVIEW_CONFIG.position} interview. ` +
      `I'll ask you ${session.questions.length} questions. Let's begin. ` +
      session.questions[0].text;

    const audio = await callElevenLabs(greetingText);
    return res.json({
      audio,
      text:           greetingText,
      metrics:        session.metrics,
      questionIndex:  0,
      totalQuestions: session.questions.length,
      done:           false,
    });
  }

  // ── Candidate response ───────────────────────────────────────────────────
  if (!text || text.trim().length < 3) {
    return res.status(400).json({ error: "text too short" });
  }

  // Debounce: skip if same text being processed
  if (session.processing || session.lastResponse === text) {
    return res.status(429).json({ error: "processing" });
  }

  session.processing   = true;
  session.lastResponse = text;

  try {
    const currentQ = session.questions[session.currentQ];
    if (!currentQ) {
      return res.json({ done: true, metrics: session.metrics });
    }

    log.info(`💬 [${sessionId}] Q${session.currentQ + 1}: "${text.substring(0, 80)}"`);

    // Add to history
    session.history.push({ role: "user",      content: text      });

    // Bedrock
    const aiReply = await callBedrock(session);
    log.info(`🤖 [${sessionId}] AI: "${aiReply.text.substring(0, 80)}"`);

    // Update history & metrics
    session.history.push({ role: "assistant", content: aiReply.text });
    updateMetrics(session, aiReply.metrics);

    // Move to next question?
    let nextQuestionText = null;
    if (aiReply.next && session.currentQ < session.questions.length - 1) {
      session.currentQ++;
      nextQuestionText = session.questions[session.currentQ].text;
      log.info(`➡️  Moving to Q${session.currentQ + 1}`);
    }

    // Build spoken text (reply + next question if any)
    const spokenText = nextQuestionText
      ? `${aiReply.text} ${nextQuestionText}`
      : aiReply.text;

    // TTS
    const audio = await callElevenLabs(spokenText);

    session.processing = false;

    const isDone = !aiReply.next && session.currentQ >= session.questions.length - 1;
    if (isDone) {
      log.info(`🏁 [${sessionId}] Interview complete`);
      await sendToN8n({ sessionId, metrics: session.metrics, transcript: session.history });
    }

    return res.json({
      audio,
      text:           spokenText,
      metrics:        session.metrics,
      questionIndex:  session.currentQ,
      totalQuestions: session.questions.length,
      done:           isDone,
    });

  } catch (err) {
    session.processing = false;
    log.error(`/api/speak error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /webhook/recall/events  — Recall.ai lifecycle webhooks (bot status only)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/webhook/recall/events", async (req, res) => {
  const event  = req.body?.event;
  const bot_id = req.body?.data?.bot?.id;

  log.info(`📨 Recall webhook: "${event}" bot=${bot_id}`);

  // Always respond 200 quickly so Recall.ai doesn't retry
  res.json({ status: "ok" });

  if (event === "bot.call_ended" && bot_id) {
    // Find session by bot_id (stored when meeting page calls /api/speak with botId)
    const session = sessions.get(bot_id) || sessions.get(`bot-${bot_id}`);
    if (session) {
      log.info(`📊 Finalizing interview for bot ${bot_id}`);
      await sendToN8n({ sessionId: bot_id, metrics: session.metrics, transcript: session.history });
      sessions.delete(bot_id);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /meeting-page  — The webpage Recall.ai's bot opens in its headless browser.
//  It connects to wss://meeting-data.bot.recall.ai/api/v1/transcript directly
//  to receive transcripts, then calls /api/speak to get TTS audio.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/meeting-page", (req, res) => {
  const serverUrl = req.query.server
    ? `https://${req.query.server}`
    : `http://localhost:${PORT}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Interview Bot</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg,#667eea 0%,#764ba2 100%);
      min-height:100vh; display:flex; align-items:center; justify-content:center;
    }
    .card {
      background:#fff; border-radius:20px; padding:36px;
      width:100%; max-width:780px;
      box-shadow:0 20px 60px rgba(0,0,0,.3);
    }
    h1 { text-align:center; color:#333; font-size:26px; margin-bottom:6px; }
    .subtitle { text-align:center; color:#888; font-size:13px; margin-bottom:28px; }

    .status {
      padding:12px 20px; border-radius:8px; text-align:center;
      font-weight:600; font-size:15px; margin-bottom:20px;
      transition: all .3s;
    }
    .status.listening  { background:#e8f5e9; color:#2e7d32; }
    .status.thinking   { background:#fff8e1; color:#f57f17; }
    .status.speaking   { background:#e3f2fd; color:#1565c0; }
    .status.connecting { background:#f3e5f5; color:#6a1b9a; }

    .metrics { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:24px; }
    .metric { background:#f5f5f5; border-radius:10px; padding:14px; text-align:center; }
    .metric label { display:block; font-size:11px; color:#888; text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px; }
    .metric .val { font-size:28px; font-weight:700; color:#667eea; }

    .q-box {
      border-left:4px solid #667eea; background:#f9f9f9;
      padding:16px 20px; border-radius:0 10px 10px 0; margin-bottom:16px;
    }
    .q-box .q-label { font-size:11px; color:#aaa; text-transform:uppercase; letter-spacing:.5px; }
    .q-box .q-text  { color:#333; font-size:15px; margin-top:6px; line-height:1.5; }

    .progress { text-align:center; color:#aaa; font-size:13px; }

    .wave { display:flex; align-items:center; justify-content:center; gap:4px; height:36px; margin:12px 0; }
    .bar {
      width:4px; border-radius:2px; background:#667eea;
      animation: wave .7s ease-in-out infinite;
    }
    .bar:nth-child(1){height:12px;animation-delay:0s}
    .bar:nth-child(2){height:20px;animation-delay:.1s}
    .bar:nth-child(3){height:28px;animation-delay:.2s}
    .bar:nth-child(4){height:20px;animation-delay:.3s}
    .bar:nth-child(5){height:12px;animation-delay:.4s}
    @keyframes wave { 0%,100%{transform:scaleY(1)} 50%{transform:scaleY(1.8)} }
    .wave.paused .bar { animation-play-state:paused; }

    #log { margin-top:16px; font-size:11px; color:#bbb; max-height:60px; overflow:hidden; }
  </style>
</head>
<body>
<div class="card">
  <h1>🎤 AI Interview Bot</h1>
  <p class="subtitle">Technical Interview Assistant — Software Engineer</p>

  <div class="status connecting" id="status">⏳ Connecting to meeting...</div>

  <div class="wave paused" id="wave">
    <div class="bar"></div><div class="bar"></div><div class="bar"></div>
    <div class="bar"></div><div class="bar"></div>
  </div>

  <div class="metrics">
    <div class="metric"><label>Clarity</label><div class="val" id="m-clarity">--</div></div>
    <div class="metric"><label>Technical Depth</label><div class="val" id="m-depth">--</div></div>
    <div class="metric"><label>Communication</label><div class="val" id="m-comm">--</div></div>
  </div>

  <div class="q-box">
    <div class="q-label">Current Question</div>
    <div class="q-text" id="q-text">Initializing interview...</div>
  </div>

  <div class="progress" id="progress">Starting...</div>
  <div id="log"></div>
</div>

<!-- Hidden audio — Recall.ai captures this into the meeting -->
<audio id="audio" autoplay playsinline style="display:none"></audio>

<script>
const SERVER = '${serverUrl}';
const SESSION_ID = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);

const statusEl   = document.getElementById('status');
const waveEl     = document.getElementById('wave');
const progressEl = document.getElementById('progress');
const qTextEl    = document.getElementById('q-text');
const audioEl    = document.getElementById('audio');
const logEl      = document.getElementById('log');

let questionIndex   = 0;
let totalQuestions  = 5;
let interviewDone   = false;
let lastSpokenText  = '';
const audioQueue    = [];
let isPlayingAudio  = false;

function dbg(msg) {
  console.log(msg);
  logEl.textContent = msg;
}

function setStatus(type, msg) {
  statusEl.className = 'status ' + type;
  statusEl.textContent = msg;
  waveEl.className = 'wave' + (type === 'speaking' ? '' : ' paused');
}

function updateMetrics(m) {
  if (!m) return;
  document.getElementById('m-clarity').textContent = m.clarity  ?? '--';
  document.getElementById('m-depth').textContent   = m.depth    ?? '--';
  document.getElementById('m-comm').textContent    = m.communication ?? '--';
}

// ── Audio queue ────────────────────────────────────────────────────────────
function enqueueAudio(base64mp3, text) {
  audioQueue.push({ base64mp3, text });
  playNextAudio();
}

function playNextAudio() {
  if (isPlayingAudio || audioQueue.length === 0) return;
  isPlayingAudio = true;

  const { base64mp3, text } = audioQueue.shift();
  dbg('🔊 Playing: ' + text.substring(0, 60) + '...');
  setStatus('speaking', '🗣️ AI is speaking...');

  try {
    const bytes  = atob(base64mp3);
    const buf    = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const blob   = new Blob([buf], { type: 'audio/mpeg' });
    const url    = URL.createObjectURL(blob);

    audioEl.src = url;
    audioEl.onended = () => {
      URL.revokeObjectURL(url);
      isPlayingAudio = false;
      setStatus('listening', '👂 Listening to candidate...');
      playNextAudio();
    };
    audioEl.onerror = () => {
      isPlayingAudio = false;
      playNextAudio();
    };
    audioEl.play().catch(e => {
      dbg('play() failed: ' + e.message);
      isPlayingAudio = false;
      playNextAudio();
    });
  } catch (e) {
    dbg('Audio error: ' + e.message);
    isPlayingAudio = false;
    playNextAudio();
  }
}

// ── Call server: speak ────────────────────────────────────────────────────
async function callSpeak(text, isGreeting) {
  if (interviewDone) return;
  try {
    setStatus('thinking', '🧠 Processing...');
    const res = await fetch(SERVER + '/api/speak', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sessionId: SESSION_ID, text, isGreeting: !!isGreeting }),
    });

    if (!res.ok) {
      const err = await res.text();
      dbg('Server error: ' + res.status + ' ' + err);
      setStatus('listening', '👂 Listening...');
      return;
    }

    const data = await res.json();

    if (data.audio) {
      enqueueAudio(data.audio, data.text || '');
    }

    updateMetrics(data.metrics);

    if (data.questionIndex !== undefined) {
      questionIndex  = data.questionIndex;
      totalQuestions = data.totalQuestions;
      qTextEl.textContent  = data.done
        ? '✅ Interview complete! Thank you.'
        : QUESTIONS[questionIndex] || 'Interview in progress...';
      progressEl.textContent = data.done
        ? 'Interview complete'
        : 'Question ' + (questionIndex + 1) + ' of ' + totalQuestions;
    }

    if (data.done) {
      interviewDone = true;
      setStatus('listening', '✅ Interview complete');
    }

  } catch (e) {
    dbg('callSpeak error: ' + e.message);
    setStatus('listening', '👂 Listening...');
  }
}

// ── Question list (mirrors server) ─────────────────────────────────────────
const QUESTIONS = [
  'Tell me about your experience with backend development.',
  'How would you design a scalable REST API?',
  'Describe a challenging project and how you overcame obstacles.',
  'What are your strongest technical skills and why?',
  'Where do you see yourself in 5 years?',
];
qTextEl.textContent = QUESTIONS[0];

// ── Connect to Recall.ai transcript WebSocket ──────────────────────────────
// This WebSocket is exposed by the bot itself when running output_media.
// The webpage connects here to receive live transcripts from the meeting.
let transcriptWs;
let transcriptConnected = false;
let debounceTimer       = null;
const DEBOUNCE_MS       = 2500;   // Wait 2.5s of silence before processing

function connectTranscriptWS() {
  dbg('Connecting to Recall.ai transcript WebSocket...');
  try {
    transcriptWs = new WebSocket('wss://meeting-data.bot.recall.ai/api/v1/transcript');
  } catch (e) {
    dbg('WS init error: ' + e.message);
    setTimeout(connectTranscriptWS, 4000);
    return;
  }

  transcriptWs.onopen = () => {
    transcriptConnected = true;
    dbg('✅ Connected to Recall.ai transcript feed');
    setStatus('listening', '👂 Connected — listening...');

    // Send greeting (introduces bot and asks first question)
    callSpeak('', true);
  };

  transcriptWs.onmessage = (evt) => {
    if (interviewDone || isPlayingAudio) return;

    let data;
    try { data = JSON.parse(evt.data); } catch { return; }

    // Extract spoken words from transcript event
    const words = data.transcript?.words || data.words;
    if (!words || words.length === 0) return;

    const text = words.map(w => w.text).join(' ').trim();
    if (text.length < 3 || text === lastSpokenText) return;

    dbg('🎙️ Heard: ' + text.substring(0, 80));

    // Debounce — wait for pause in speech before processing
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (text !== lastSpokenText && !isPlayingAudio && !interviewDone) {
        lastSpokenText = text;
        callSpeak(text, false);
      }
    }, DEBOUNCE_MS);
  };

  transcriptWs.onerror = (e) => {
    dbg('Transcript WS error: ' + (e.message || 'unknown'));
  };

  transcriptWs.onclose = () => {
    transcriptConnected = false;
    dbg('⚠️ Transcript WS closed — retrying in 4s');
    setStatus('connecting', '⏳ Reconnecting...');
    setTimeout(connectTranscriptWS, 4000);
  };
}

// Start
connectTranscriptWS();
</script>
</body>
</html>`;

  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.type("text/html").send(html);
});

// ─── WebSocket server (optional — for external dashboard) ─────────────────
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws/dashboard") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  log.info("Dashboard WS connected");
  ws.on("close", () => log.info("Dashboard WS disconnected"));
});

// ─── Helper: ElevenLabs TTS ───────────────────────────────────────────────
async function callElevenLabs(text) {
  if (!ELEVENLABS_API_KEY) {
    log.error("ELEVENLABS_API_KEY missing");
    return null;
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`,
    {
      method:  "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body:    JSON.stringify({
        text,
        model_id:       "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    log.error(`ElevenLabs ${res.status}: ${err}`);
    return null;
  }

  const buf = await res.arrayBuffer();
  log.info(`🎵 TTS: ${(buf.byteLength / 1024).toFixed(1)} KB`);
  return Buffer.from(buf).toString("base64");
}

// ─── Helper: AWS Bedrock ──────────────────────────────────────────────────
async function callBedrock(session) {
  const messages = session.history.map((m) => ({ role: m.role, content: m.content }));

  const res = await bedrockClient.send(
    new InvokeModelCommand({
      modelId:     "anthropic.claude-3-sonnet-20240229-v1:0",
      contentType: "application/json",
      accept:      "application/json",
      body:        JSON.stringify({
        anthropic_version: "bedrock-2023-06-01",
        max_tokens:        400,
        system:            INTERVIEW_CONFIG.systemPrompt,
        messages,
      }),
    })
  );

  const body = JSON.parse(new TextDecoder().decode(res.body));
  const text = body.content?.[0]?.text || "";

  // Parse [METRIC] clarity:N depth:N communication:N next:yes/no
  const m = text.match(/\[METRIC\]\s*clarity:(\d+)\s*depth:(\d+)\s*communication:(\d+)\s*next:(yes|no)/i);
  const metrics = m
    ? { clarity: +m[1], depth: +m[2], communication: +m[3] }
    : { clarity: 5, depth: 5, communication: 5 };

  const next = m ? m[4].toLowerCase() === "yes" : false;

  // Remove the [METRIC] line from spoken text
  const cleanText = text.replace(/\[METRIC\].*$/im, "").trim();

  return { text: cleanText, metrics, next };
}

// ─── Helper: Update running average metrics ───────────────────────────────
function updateMetrics(session, incoming) {
  session.responseCount++;
  const n = session.responseCount;
  const s = session.metrics;
  const i = incoming;

  s.clarity       = Math.round((s.clarity       * (n - 1) + i.clarity)       / n);
  s.depth         = Math.round((s.depth         * (n - 1) + i.depth)         / n);
  s.communication = Math.round((s.communication * (n - 1) + i.communication) / n);
  s.overall       = Math.round(((s.clarity + s.depth + s.communication) / 3) * 10);
}

// ─── Helper: send results to n8n ─────────────────────────────────────────
async function sendToN8n(data) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ...data, timestamp: new Date().toISOString() }),
    });
    log.info(`n8n: ${r.status}`);
  } catch (e) {
    log.error(`n8n error: ${e.message}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log.info(`\n🚀 Interview Bot running on port ${PORT}`);
  log.info(`   Meeting page : /meeting-page?server=YOUR_DOMAIN`);
  log.info(`   Speak API    : POST /api/speak`);
  log.info(`   Webhook      : POST /webhook/recall/events`);
  log.info(`   TTS          : ${ELEVENLABS_API_KEY ? "ElevenLabs ✅" : "❌ disabled"}\n`);
});
