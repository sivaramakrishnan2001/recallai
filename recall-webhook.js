import express from "express";
import { createServer } from "http";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import dotenv from "dotenv";

dotenv.config();

const log = {
  info:  (m) => console.log(`[INFO]  ${m}`),
  warn:  (m) => console.warn(`[WARN]  ${m}`),
  error: (m) => console.error(`[ERROR] ${m}`),
};

// ── Config ────────────────────────────────────────────────────────────────────
const PORT               = process.env.PORT               || 3000;
const BEDROCK_API_KEY    = process.env.BEDROCK_API_KEY;
const BEDROCK_KEY_NAME   = process.env.BEDROCK_API_KEY_NAME;
const AWS_REGION         = process.env.AWS_REGION         || "us-east-1";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE   = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

log.info("=== STARTUP CHECKS ===");
log.info(`RECALL_API_KEY     : ${process.env.RECALL_API_KEY     ? "✅" : "❌ MISSING"}`);
log.info(`BEDROCK_API_KEY    : ${BEDROCK_API_KEY    ? "✅" : "❌ MISSING"}`);
log.info(`ELEVENLABS_API_KEY : ${ELEVENLABS_API_KEY ? "✅" : "❌ MISSING"}`);
log.info(`ELEVENLABS_VOICE   : ${ELEVENLABS_VOICE}`);
log.info(`N8N_WEBHOOK_URL    : ${process.env.N8N_WEBHOOK_URL || "not set"}`);
log.info("======================");

if (!BEDROCK_API_KEY || !BEDROCK_KEY_NAME) {
  log.error("AWS Bedrock credentials missing — exiting"); process.exit(1);
}

// ── AWS Bedrock ───────────────────────────────────────────────────────────────
const bedrockClient = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: { accessKeyId: BEDROCK_KEY_NAME, secretAccessKey: BEDROCK_API_KEY },
});

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(id) { return sessions.get(id); }

function createSession(id, role) {
  const s = {
    id,
    role:          role || "Software Engineer",
    questions:     [],           // filled by Bedrock on first call
    currentQ:      0,
    history:       [],
    metrics:       { clarity: 0, depth: 0, communication: 0, overall: 0 },
    responseCount: 0,
    processing:    false,
    lastText:      "",
    startTime:     Date.now(),
    done:          false,
  };
  sessions.set(id, s);
  log.info(`✅ Session ${id} | role: ${role}`);
  return s;
}

setInterval(() => {
  const cut = Date.now() - 3 * 3600_000;
  for (const [k, s] of sessions) if (s.startTime < cut) { sessions.delete(k); }
}, 30 * 60_000);

// ── Express ───────────────────────────────────────────────────────────────────
const app    = express();
const server = createServer(app);

app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_q, r) => r.json({ status: "ok", sessions: sessions.size }));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/start
// Called once when meeting page loads. Generates role-specific questions,
// returns greeting audio.
// Body:  { sessionId, role }
// Reply: { audio, questions, greeting }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/start", async (req, res) => {
  const { sessionId, role = "Software Engineer" } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  let session = getSession(sessionId);
  if (!session) session = createSession(sessionId, role);

  try {
    // Generate 5 role-specific questions with Bedrock
    if (session.questions.length === 0) {
      log.info(`🧠 Generating questions for role: ${role}`);
      session.questions = await generateQuestions(role);
      log.info(`📋 Questions ready: ${session.questions.length}`);
    }

    const greetingText =
      `Hello! I'm your AI interview assistant from Pragmatic Digital Solutions. ` +
      `Today I'll be interviewing you for the ${role} position. ` +
      `I have ${session.questions.length} questions for you. ` +
      `Please answer clearly and take your time. Let's begin. ` +
      session.questions[0];

    const audio = await callElevenLabs(greetingText);

    return res.json({
      audio,
      greeting:       greetingText,
      questions:      session.questions,
      totalQuestions: session.questions.length,
    });

  } catch (err) {
    log.error(`/api/start error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/respond
// Called each time the candidate finishes speaking.
// Body:  { sessionId, text }
// Reply: { audio, text, metrics, questionIndex, totalQuestions, done }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/respond", async (req, res) => {
  const { sessionId, text } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  if (!text || text.trim().length < 3) return res.status(400).json({ error: "text too short" });

  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: "session not found — call /api/start first" });
  if (session.done) return res.json({ done: true, metrics: session.metrics });

  // Deduplicate
  if (session.processing) return res.status(429).json({ error: "still processing" });
  if (text.trim() === session.lastText.trim()) return res.status(429).json({ error: "duplicate" });

  session.processing = true;
  session.lastText   = text.trim();

  try {
    const currentQ = session.questions[session.currentQ];
    log.info(`💬 [${sessionId}] Q${session.currentQ + 1}: "${text.substring(0, 80)}"`);

    // Add to history
    session.history.push({ role: "user", content: text });

    // Bedrock: evaluate response + decide next step
    const ai = await callBedrock(session, currentQ, text);
    log.info(`🤖 [${sessionId}]: "${ai.text.substring(0, 80)}" | next=${ai.next}`);

    session.history.push({ role: "assistant", content: ai.text });
    updateMetrics(session, ai.metrics);

    // Move to next question?
    let spokenText = ai.text;
    if (ai.next && session.currentQ < session.questions.length - 1) {
      session.currentQ++;
      spokenText += " " + session.questions[session.currentQ];
      log.info(`➡️  Q${session.currentQ + 1}`);
    }

    const isDone = ai.next && session.currentQ >= session.questions.length - 1;
    if (isDone) {
      session.done = true;
      spokenText += " That concludes our interview. Thank you so much for your time. We will be in touch soon.";
      log.info(`🏁 Interview complete [${sessionId}]`);
      await sendToN8n(session);
    }

    const audio = await callElevenLabs(spokenText);
    session.processing = false;

    return res.json({
      audio,
      text:           spokenText,
      metrics:        session.metrics,
      questionIndex:  session.currentQ,
      totalQuestions: session.questions.length,
      currentQ:       session.questions[session.currentQ],
      done:           isDone,
    });

  } catch (err) {
    session.processing = false;
    log.error(`/api/respond error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ── Recall.ai webhook (lifecycle events) ─────────────────────────────────────
app.post("/webhook/recall/events", async (req, res) => {
  const event  = req.body?.event;
  const bot_id = req.body?.data?.bot?.id;
  log.info(`📨 ${event} | bot=${bot_id}`);
  res.json({ status: "ok" });

  if (event === "bot.call_ended" && bot_id) {
    const s = getSession(bot_id);
    if (s && !s.done) { await sendToN8n(s); sessions.delete(bot_id); }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /meeting-page?server=YOUR_DOMAIN&role=Frontend+Developer
//
// This is the webpage Recall.ai's bot opens in its headless browser.
// It connects to wss://meeting-data.bot.recall.ai/api/v1/transcript
// to receive LIVE TRANSCRIPTS from participants.
// Then calls /api/respond to get AI response + TTS audio.
// The <audio> element playback is captured by Recall.ai → Teams participants hear the bot.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/meeting-page", (req, res) => {
  const serverUrl = req.query.server
    ? `https://${req.query.server}`
    : `http://localhost:${PORT}`;
  const role = req.query.role ? decodeURIComponent(req.query.role) : "Software Engineer";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Interview Bot</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;
    }
    .card{
      background:#fff;border-radius:24px;padding:32px;width:100%;max-width:800px;
      box-shadow:0 24px 80px rgba(0,0,0,.5);
    }
    .brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:4px}
    .brand h1{font-size:24px;color:#1a1a2e;font-weight:700}
    .subtitle{text-align:center;color:#888;font-size:12px;margin-bottom:6px}
    .role-badge{
      display:inline-block;background:#e8eaf6;color:#3949ab;
      font-size:12px;font-weight:600;padding:4px 14px;border-radius:20px;
      margin:0 auto 20px;display:block;width:fit-content;text-align:center;
    }

    .status{
      padding:11px 18px;border-radius:10px;text-align:center;font-weight:600;
      font-size:14px;margin-bottom:18px;transition:all .4s;
    }
    .status.listening {background:#e8f5e9;color:#2e7d32}
    .status.thinking  {background:#fff8e1;color:#e65100}
    .status.speaking  {background:#e3f2fd;color:#1565c0}
    .status.idle      {background:#f5f5f5;color:#666}

    /* waveform */
    .wave{display:flex;align-items:center;justify-content:center;gap:5px;height:44px;margin:14px 0}
    .bar{width:5px;background:linear-gradient(#667eea,#764ba2);border-radius:3px;
         animation:pulse .6s ease-in-out infinite}
    .bar:nth-child(1){height:10px;animation-delay:0s}
    .bar:nth-child(2){height:18px;animation-delay:.1s}
    .bar:nth-child(3){height:32px;animation-delay:.15s}
    .bar:nth-child(4){height:40px;animation-delay:.2s}
    .bar:nth-child(5){height:32px;animation-delay:.25s}
    .bar:nth-child(6){height:18px;animation-delay:.3s}
    .bar:nth-child(7){height:10px;animation-delay:.35s}
    @keyframes pulse{0%,100%{transform:scaleY(1);opacity:.7}50%{transform:scaleY(1.5);opacity:1}}
    .wave.paused .bar{animation-play-state:paused;height:4px!important}

    /* metrics */
    .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
    .metric{background:#f8f9ff;border:1px solid #e8eaf6;border-radius:12px;padding:14px;text-align:center}
    .metric label{display:block;font-size:10px;color:#9fa8da;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
    .metric .val{font-size:30px;font-weight:800;background:linear-gradient(135deg,#667eea,#764ba2);
                  -webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .overall{text-align:center;font-size:13px;color:#888;margin-bottom:20px}
    .overall strong{color:#667eea}

    /* question */
    .q-box{border-left:4px solid #667eea;background:#f9f9ff;padding:16px 20px;border-radius:0 12px 12px 0;margin-bottom:14px}
    .q-label{font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
    .q-text{color:#1a1a2e;font-size:15px;line-height:1.6;font-weight:500}

    /* transcript */
    .transcript-box{
      background:#fafafa;border-radius:10px;padding:12px 16px;margin-bottom:12px;
      min-height:40px;max-height:80px;overflow-y:auto;
    }
    .transcript-label{font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
    #transcript-text{font-size:13px;color:#555;line-height:1.5;font-style:italic}

    .progress{text-align:center;color:#aaa;font-size:12px;margin-bottom:8px}
    .progress-bar{height:4px;background:#e8eaf6;border-radius:2px;overflow:hidden;margin-bottom:16px}
    .progress-fill{height:100%;background:linear-gradient(90deg,#667eea,#764ba2);transition:width .5s;border-radius:2px}

    #log{font-size:10px;color:#ccc;text-align:center;min-height:14px}
  </style>
</head>
<body>
<div class="card">
  <div class="brand"><h1>🎤 AI Interview Bot</h1></div>
  <p class="subtitle">Powered by AWS Bedrock · ElevenLabs Voice</p>
  <span class="role-badge" id="role-badge">Position: ${role}</span>

  <div class="status idle" id="status">⏳ Connecting to meeting...</div>

  <div class="wave paused" id="wave">
    <div class="bar"></div><div class="bar"></div><div class="bar"></div>
    <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
  </div>

  <div class="metrics">
    <div class="metric"><label>Clarity</label><div class="val" id="m-clarity">--</div></div>
    <div class="metric"><label>Technical Depth</label><div class="val" id="m-depth">--</div></div>
    <div class="metric"><label>Communication</label><div class="val" id="m-comm">--</div></div>
  </div>
  <div class="overall">Overall Score: <strong id="m-overall">--</strong>/100</div>

  <div class="q-box">
    <div class="q-label">Current Question</div>
    <div class="q-text" id="q-text">Generating interview questions...</div>
  </div>

  <div class="transcript-box">
    <div class="transcript-label">Candidate is saying...</div>
    <div id="transcript-text">(listening...)</div>
  </div>

  <div class="progress" id="progress">Starting up...</div>
  <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>

  <div id="log"></div>
</div>

<audio id="audio" autoplay playsinline style="display:none"></audio>

<script>
// ── Config ────────────────────────────────────────────────────────────────
const SERVER     = '${serverUrl}';
const ROLE       = '${role}';
const SESSION_ID = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);

// ── DOM ───────────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const statusEl   = $('status');
const waveEl     = $('wave');
const progressEl = $('progress');
const qTextEl    = $('q-text');
const audioEl    = $('audio');
const logEl      = $('log');
const transcriptEl = $('transcript-text');

// ── State ─────────────────────────────────────────────────────────────────
let questionIndex   = 0;
let totalQuestions  = 5;
let interviewDone   = false;
let isPlaying       = false;
let isThinking      = false;
const audioQueue    = [];
let accumulatedText = '';   // builds up partial transcript
let silenceTimer    = null;
let lastProcessed   = '';
const SILENCE_MS    = 2000; // process after 2s of silence

// ── UI helpers ────────────────────────────────────────────────────────────
function dbg(msg) { logEl.textContent = msg; console.log('[BOT]', msg); }

function setStatus(type, msg) {
  statusEl.className = 'status ' + type;
  statusEl.textContent = msg;
  waveEl.className = 'wave' + (type === 'speaking' ? '' : ' paused');
}

function updateMetrics(m) {
  if (!m) return;
  $('m-clarity').textContent = m.clarity  ?? '--';
  $('m-depth').textContent   = m.depth    ?? '--';
  $('m-comm').textContent    = m.communication ?? '--';
  $('m-overall').textContent = m.overall  ?? '--';
}

function updateProgress(idx, total) {
  progressEl.textContent = 'Question ' + (idx + 1) + ' of ' + total;
  $('progress-fill').style.width = ((idx + 1) / total * 100) + '%';
}

// ── Audio queue ───────────────────────────────────────────────────────────
function enqueue(base64, text) {
  if (!base64) return;
  audioQueue.push({ base64, text });
  playNext();
}

function playNext() {
  if (isPlaying || audioQueue.length === 0) return;
  isPlaying = true;

  const { base64, text } = audioQueue.shift();
  dbg('🔊 ' + text.substring(0, 60) + '...');
  setStatus('speaking', '🗣️ AI is speaking...');

  try {
    const raw  = atob(base64);
    const buf  = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url  = URL.createObjectURL(blob);

    audioEl.src = url;
    audioEl.onended = () => { URL.revokeObjectURL(url); isPlaying = false; setStatus('listening','👂 Listening to candidate...'); playNext(); };
    audioEl.onerror = () => { isPlaying = false; playNext(); };
    audioEl.play().catch(e => { dbg('play() failed: ' + e.message); isPlaying = false; playNext(); });
  } catch (e) {
    dbg('Audio decode error: ' + e.message);
    isPlaying = false;
    playNext();
  }
}

// ── API calls ─────────────────────────────────────────────────────────────
async function startInterview() {
  dbg('Starting interview...');
  setStatus('thinking', '🧠 Generating questions for ' + ROLE + '...');
  try {
    const r = await fetch(SERVER + '/api/start', {
      method:  'POST',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify({ sessionId: SESSION_ID, role: ROLE }),
    });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();

    totalQuestions = d.totalQuestions || 5;
    if (d.questions && d.questions.length > 0) {
      qTextEl.textContent = d.questions[0];
    }
    updateProgress(0, totalQuestions);
    dbg('✅ Questions ready. Playing greeting...');

    if (d.audio) enqueue(d.audio, d.greeting || '');

  } catch (e) {
    dbg('startInterview error: ' + e.message);
    setStatus('idle', '❌ Error starting: ' + e.message);
  }
}

async function processAnswer(text) {
  if (interviewDone || isThinking) return;
  if (text.trim() === lastProcessed.trim()) { dbg('Duplicate — skipped'); return; }
  if (text.trim().length < 4) return;

  lastProcessed = text.trim();
  isThinking    = true;
  accumulatedText = '';
  transcriptEl.textContent = '(processing...)';
  setStatus('thinking', '🧠 Thinking...');

  try {
    const r = await fetch(SERVER + '/api/respond', {
      method:  'POST',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify({ sessionId: SESSION_ID, text }),
    });

    if (r.status === 429) { isThinking = false; return; }
    if (!r.ok) throw new Error(await r.text());

    const d = await r.json();
    isThinking = false;

    updateMetrics(d.metrics);
    updateProgress(d.questionIndex ?? questionIndex, d.totalQuestions ?? totalQuestions);
    questionIndex = d.questionIndex ?? questionIndex;

    if (d.currentQ) qTextEl.textContent = d.currentQ;
    if (d.done) {
      interviewDone = true;
      qTextEl.textContent = '✅ Interview complete. Thank you!';
    }

    if (d.audio) enqueue(d.audio, d.text || '');

  } catch (e) {
    isThinking = false;
    dbg('processAnswer error: ' + e.message);
    setStatus('listening', '👂 Listening...');
  }
}

// ── Recall.ai Transcript WebSocket ───────────────────────────────────────
// The bot exposes this WebSocket from inside its headless browser.
// It delivers live transcripts from all participants.
// NO authentication needed — we are running inside the bot's browser.
let transcriptWs;

function connectTranscriptWS() {
  dbg('Connecting to Recall.ai transcript feed...');
  try {
    transcriptWs = new WebSocket('wss://meeting-data.bot.recall.ai/api/v1/transcript');
  } catch(e) {
    dbg('WS error: ' + e.message);
    setTimeout(connectTranscriptWS, 5000);
    return;
  }

  transcriptWs.onopen = () => {
    dbg('✅ Transcript feed connected');
    setStatus('listening', '👂 Connected — listening...');
    startInterview();  // Generate questions + play greeting
  };

  transcriptWs.onmessage = (evt) => {
    // Skip if bot is speaking or processing
    if (isPlaying || isThinking || interviewDone) return;

    let data;
    try { data = JSON.parse(evt.data); } catch { return; }

    // Extract words — Recall.ai sends: { transcript: { words: [{text}] } }
    const words = data?.transcript?.words || data?.words || [];
    if (!words.length) return;

    const chunk = words.map(w => w.text || w.word || '').join(' ').trim();
    if (!chunk) return;

    // Accumulate transcript
    accumulatedText = accumulatedText
      ? accumulatedText + ' ' + chunk
      : chunk;

    // Show live transcript
    transcriptEl.textContent = accumulatedText;

    // Debounce: process after SILENCE_MS of no new words
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const finalText = accumulatedText.trim();
      accumulatedText = '';
      if (finalText.length > 5 && !isPlaying && !isThinking) {
        dbg('📝 Processing: ' + finalText.substring(0, 80));
        processAnswer(finalText);
      }
    }, SILENCE_MS);
  };

  transcriptWs.onerror = (e) => dbg('WS error: ' + (e.message || 'unknown'));

  transcriptWs.onclose = () => {
    dbg('⚠️ Transcript feed closed — reconnect in 3s');
    if (!interviewDone) {
      setStatus('idle', '⏳ Reconnecting...');
      setTimeout(connectTranscriptWS, 3000);
    }
  };
}

// ── Start ─────────────────────────────────────────────────────────────────
connectTranscriptWS();
</script>
</body>
</html>`;

  res.removeHeader("X-Frame-Options");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.type("text/html").send(html);
});

// ── Generate role-specific questions with Bedrock ─────────────────────────
async function generateQuestions(role) {
  const res = await bedrockClient.send(new InvokeModelCommand({
    modelId:     "anthropic.claude-3-sonnet-20240229-v1:0",
    contentType: "application/json",
    accept:      "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-06-01",
      max_tokens:        600,
      messages: [{
        role:    "user",
        content: `Generate exactly 5 interview questions for a ${role} position.
Return ONLY a JSON array of 5 strings, no explanation, no numbering.
Example: ["Question 1?","Question 2?","Question 3?","Question 4?","Question 5?"]
Make questions specific to ${role} skills, covering: experience, technical skills, problem-solving, design/architecture, and career goals.`,
      }],
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(res.body));
  const text = body.content?.[0]?.text || "";

  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch {}

  // Fallback generic questions
  return [
    `Tell me about your experience as a ${role}.`,
    `What are your strongest technical skills for this ${role} role?`,
    `Describe a challenging project you worked on as a ${role}.`,
    `How do you approach problem-solving and learning new technologies?`,
    `Where do you see yourself in 5 years in your ${role} career?`,
  ];
}

// ── Bedrock: evaluate answer + generate follow-up ─────────────────────────
async function callBedrock(session, currentQ, candidateAnswer) {
  const systemPrompt = `You are a professional interviewer for a ${session.role} position.
The current question was: "${currentQ}"
The candidate answered. Respond in 2-3 sentences MAX:
1. Acknowledge their answer briefly and naturally
2. Ask a short follow-up OR transition to next question

End with EXACTLY this line (no newline before it):
[METRIC] clarity:N depth:N communication:N next:yes/no
- N = 0 to 10
- next:yes = ready to move to next question
- next:no = want more detail on current answer`;

  const messages = session.history.map(m => ({ role: m.role, content: m.content }));

  const res = await bedrockClient.send(new InvokeModelCommand({
    modelId:     "anthropic.claude-3-sonnet-20240229-v1:0",
    contentType: "application/json",
    accept:      "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-06-01",
      max_tokens:        300,
      system:            systemPrompt,
      messages,
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(res.body));
  const full = body.content?.[0]?.text || "";

  const m = full.match(/\[METRIC\]\s*clarity:(\d+)\s*depth:(\d+)\s*communication:(\d+)\s*next:(yes|no)/i);
  const metrics = m
    ? { clarity: +m[1], depth: +m[2], communication: +m[3] }
    : { clarity: 5, depth: 5, communication: 5 };
  const next = m ? m[4].toLowerCase() === "yes" : true;

  const cleanText = full.replace(/\[METRIC\].*$/im, "").trim();
  return { text: cleanText || "Thank you for that answer.", metrics, next };
}

// ── Metrics running average ───────────────────────────────────────────────
function updateMetrics(session, inc) {
  session.responseCount++;
  const n = session.responseCount, s = session.metrics, i = inc;
  s.clarity       = Math.round((s.clarity       * (n-1) + (i.clarity||5))       / n);
  s.depth         = Math.round((s.depth         * (n-1) + (i.depth||5))         / n);
  s.communication = Math.round((s.communication * (n-1) + (i.communication||5)) / n);
  s.overall       = Math.round(((s.clarity + s.depth + s.communication) / 3) * 10);
}

// ── n8n results ───────────────────────────────────────────────────────────
async function sendToN8n(session) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId:      session.id,
        role:           session.role,
        metrics:        session.metrics,
        questionsAsked: session.currentQ + 1,
        transcript:     session.history,
        timestamp:      new Date().toISOString(),
      }),
    });
    log.info(`📊 Results sent to n8n`);
  } catch (e) {
    log.error(`n8n error: ${e.message}`);
  }
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────
async function callElevenLabs(text) {
  if (!ELEVENLABS_API_KEY) { log.error("ELEVENLABS_API_KEY missing"); return null; }
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`, {
    method:  "POST",
    headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id:       "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!r.ok) { log.error(`ElevenLabs ${r.status}: ${await r.text()}`); return null; }
  const buf = await r.arrayBuffer();
  log.info(`🎵 TTS: ${(buf.byteLength/1024).toFixed(1)} KB for "${text.substring(0,50)}"`);
  return Buffer.from(buf).toString("base64");
}

// ── Start server ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log.info(`\n🚀 AI Interview Bot on port ${PORT}`);
  log.info(`   /meeting-page?server=YOUR_DOMAIN&role=Frontend+Developer`);
  log.info(`   POST /api/start   — init session + greeting`);
  log.info(`   POST /api/respond — process answer`);
  log.info(`   POST /webhook/recall/events\n`);
});
