import express from "express";
import { createServer } from "http";
import dotenv from "dotenv";
dotenv.config();

const log = {
  info:  (m) => console.log(`[INFO]  ${m}`),
  warn:  (m) => console.warn(`[WARN]  ${m}`),
  error: (m) => console.error(`[ERROR] ${m}`),
};

// ── Config ────────────────────────────────────────────────────────────────────
const PORT               = process.env.PORT               || 3000;
const AWS_REGION         = process.env.AWS_REGION         || "us-east-1";
const BEDROCK_API_KEY    = process.env.BEDROCK_API_KEY;          // ABSK... key
const BEDROCK_KEY_NAME   = process.env.BEDROCK_API_KEY_NAME;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE   = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const MODEL_ID           = "anthropic.claude-3-sonnet-20240229-v1:0";

log.info("=== STARTUP CHECKS ===");
log.info(`BEDROCK_API_KEY    : ${BEDROCK_API_KEY    ? "✅" : "❌ MISSING"}`);
log.info(`ELEVENLABS_API_KEY : ${ELEVENLABS_API_KEY ? "✅" : "❌ MISSING"}`);
log.info(`AWS_REGION         : ${AWS_REGION}`);
log.info("======================");

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();

function createSession(id, role) {
  const s = {
    id, role,
    questions:     [],
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
  log.info(`✅ Session [${id}] role="${role}"`);
  return s;
}

setInterval(() => {
  const cut = Date.now() - 3 * 3600_000;
  for (const [k, s] of sessions) if (s.startTime < cut) sessions.delete(k);
}, 30 * 60_000);

// ── Express + HTTP server ─────────────────────────────────────────────────────
const app    = express();
const server = createServer(app);
app.use(express.json({ limit: "10mb" }));
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (_, res) => res.sendStatus(204));

app.get("/health", (_, res) => res.json({ ok: true, sessions: sessions.size }));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/start  — called once by meeting page on connect
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/start", async (req, res) => {
  const { sessionId, role = "Software Engineer" } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  let s = sessions.get(sessionId) || createSession(sessionId, role);

  try {
    // Generate 2 role-specific questions
    if (s.questions.length === 0) {
      log.info(`🧠 Generating questions for: ${role}`);
      s.questions = await generateQuestions(role);
    }

    const greeting =
      `Hi! I'm your AI interviewer today for the ${role} position. ` +
      `I have just two questions for you — take your time and answer naturally. ` +
      `Here's the first one: ${s.questions[0]}`;

    const audio = await tts(greeting);
    return res.json({ audio, greeting, questions: s.questions, totalQuestions: s.questions.length });

  } catch (err) {
    log.error(`/api/start: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/respond  — called every time candidate finishes a sentence
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/respond", async (req, res) => {
  const { sessionId, text } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  if (!text || text.trim().length < 3) return res.status(400).json({ error: "too short" });

  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: "session not found — call /api/start first" });
  if (s.done)      return res.json({ done: true, metrics: s.metrics });
  if (s.processing) return res.status(429).json({ error: "busy" });
  if (text.trim() === s.lastText.trim()) return res.status(429).json({ error: "duplicate" });

  s.processing = true;
  s.lastText   = text.trim();

  try {
    const curQ = s.questions[s.currentQ] || "Thank you for your answers.";
    log.info(`💬 [${sessionId}] Q${s.currentQ + 1}: "${text.substring(0, 80)}"`);

    s.history.push({ role: "user", content: text });
    const ai = await evaluateAnswer(s, curQ, text);
    s.history.push({ role: "assistant", content: ai.text });
    updateMetrics(s, ai.metrics);

    let spoken    = ai.text;
    let isDone    = false;

    if (ai.next) {
      if (s.currentQ < s.questions.length - 1) {
        s.currentQ++;
        spoken += " " + s.questions[s.currentQ];
        log.info(`➡️  Q${s.currentQ + 1}`);
      } else {
        isDone   = true;
        s.done   = true;
        spoken  += " That wraps up our interview. Thank you so much — we'll be in touch!";
        log.info(`🏁 Interview done [${sessionId}]`);
        sendToN8n(s);
      }
    }

    const audio = await tts(spoken);
    s.processing = false;

    return res.json({
      audio,
      text:           spoken,
      metrics:        s.metrics,
      questionIndex:  s.currentQ,
      totalQuestions: s.questions.length,
      currentQ:       s.questions[s.currentQ] || null,
      done:           isDone,
    });

  } catch (err) {
    s.processing = false;
    log.error(`/api/respond: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ── Recall.ai lifecycle webhook ───────────────────────────────────────────────
app.post("/webhook/recall/events", (req, res) => {
  const e   = req.body?.event;
  const bid = req.body?.data?.bot?.id;
  log.info(`📨 ${e} bot=${bid}`);
  res.json({ status: "ok" });
  if (e === "bot.call_ended" && bid) {
    const s = sessions.get(bid);
    if (s && !s.done) { sendToN8n(s); sessions.delete(bid); }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /meeting-page?server=DOMAIN&role=ROLE
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
<title>AI Interview Bot</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border-radius:24px;padding:32px 36px;width:100%;max-width:760px;
  box-shadow:0 32px 80px rgba(0,0,0,.6)}
h1{text-align:center;font-size:22px;color:#1a1a2e;margin-bottom:2px}
.sub{text-align:center;font-size:11px;color:#999;margin-bottom:8px}
.badge{display:block;width:fit-content;margin:0 auto 22px;background:#ede7f6;
  color:#512da8;font-size:12px;font-weight:700;padding:4px 16px;border-radius:20px}

/* status */
.st{padding:11px 18px;border-radius:10px;text-align:center;font-weight:600;
  font-size:14px;margin-bottom:18px;transition:background .3s,color .3s}
.st.idle      {background:#f5f5f5;color:#888}
.st.listening {background:#e8f5e9;color:#2e7d32}
.st.thinking  {background:#fff8e1;color:#e65100}
.st.speaking  {background:#e3f2fd;color:#1565c0}
.st.done      {background:#f3e5f5;color:#6a1b9a}

/* waveform */
.wave{display:flex;align-items:center;justify-content:center;gap:4px;height:42px;margin:12px 0}
.bar{width:5px;border-radius:3px;background:linear-gradient(180deg,#7c3aed,#2563eb);
  transition:height .15s}
.wave.active .bar{animation:pulse .5s ease-in-out infinite}
.bar:nth-child(1){height:8px;animation-delay:0s}
.bar:nth-child(2){height:16px;animation-delay:.08s}
.bar:nth-child(3){height:28px;animation-delay:.16s}
.bar:nth-child(4){height:36px;animation-delay:.24s}
.bar:nth-child(5){height:28px;animation-delay:.32s}
.bar:nth-child(6){height:16px;animation-delay:.40s}
.bar:nth-child(7){height:8px;animation-delay:.48s}
@keyframes pulse{0%,100%{transform:scaleY(.6)}50%{transform:scaleY(1.4)}}

/* metrics */
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.m{background:#fafafe;border:1px solid #e8eaf6;border-radius:12px;padding:14px;text-align:center}
.m label{display:block;font-size:10px;color:#9fa8da;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.m .v{font-size:28px;font-weight:800;color:#5c35c8}
.overall{text-align:center;font-size:12px;color:#999;margin-bottom:18px}
.overall b{color:#5c35c8;font-size:14px}

/* question */
.qbox{border-left:4px solid #7c3aed;background:#f9f9ff;padding:15px 18px;
  border-radius:0 12px 12px 0;margin-bottom:14px;min-height:64px}
.qlabel{font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.qtext{color:#1a1a2e;font-size:14px;line-height:1.6;font-weight:500}

/* transcript */
.tbox{background:#fafafa;border-radius:10px;padding:10px 14px;margin-bottom:12px;min-height:36px}
.tlabel{font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.ttext{font-size:13px;color:#666;font-style:italic;line-height:1.5}

/* progress */
.prog-wrap{margin-bottom:6px}
.prog-bar{height:5px;background:#eee;border-radius:3px;overflow:hidden;margin-bottom:5px}
.prog-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#2563eb);border-radius:3px;
  transition:width .5s;width:0%}
.prog-label{text-align:center;font-size:11px;color:#bbb}

#log{font-size:10px;color:#ccc;text-align:center;margin-top:8px;min-height:14px}
</style>
</head>
<body>
<div class="card">
  <h1>🎤 AI Interview Bot</h1>
  <p class="sub">Powered by AWS Bedrock · ElevenLabs Voice</p>
  <span class="badge" id="badge">Position: ${role}</span>

  <div class="st idle" id="st">⏳ Connecting to meeting...</div>

  <div class="wave" id="wave">
    <div class="bar"></div><div class="bar"></div><div class="bar"></div>
    <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
  </div>

  <div class="metrics">
    <div class="m"><label>Clarity</label><div class="v" id="mc">--</div></div>
    <div class="m"><label>Tech Depth</label><div class="v" id="md">--</div></div>
    <div class="m"><label>Communication</label><div class="v" id="mm">--</div></div>
  </div>
  <div class="overall">Overall: <b id="mo">--</b>/100</div>

  <div class="qbox">
    <div class="qlabel">Current Question</div>
    <div class="qtext" id="qt">Initializing...</div>
  </div>

  <div class="tbox">
    <div class="tlabel">Candidate is saying...</div>
    <div class="ttext" id="tt">(listening)</div>
  </div>

  <div class="prog-wrap">
    <div class="prog-bar"><div class="prog-fill" id="pf"></div></div>
    <div class="prog-label" id="pl">Starting up...</div>
  </div>
  <div id="log"></div>
</div>
<audio id="audio" autoplay playsinline style="display:none"></audio>

<script>
const SERVER     = '${serverUrl}';
const ROLE       = '${role}';
const SID        = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);

const $ = id => document.getElementById(id);
let questions    = [];
let qIdx         = 0;
let totalQ       = 2;
let done         = false;
let playing      = false;
let thinking     = false;
const queue      = [];
let accumulated  = '';
let silTimer     = null;
let lastSent     = '';
const SILENCE    = 1800;   // ms of silence before processing

function dbg(m){ $('log').textContent = m; console.log('[BOT]', m); }

function status(type, msg){
  const el = $('st');
  el.className = 'st ' + type;
  el.textContent = msg;
  $('wave').className = 'wave' + (type === 'speaking' ? ' active' : '');
}

function setMetrics(m){
  if(!m) return;
  $('mc').textContent = m.clarity       ?? '--';
  $('md').textContent = m.depth         ?? '--';
  $('mm').textContent = m.communication ?? '--';
  $('mo').textContent = m.overall       ?? '--';
}

function setProgress(idx, total){
  $('pf').style.width = ((idx+1)/total*100) + '%';
  $('pl').textContent = 'Question ' + (idx+1) + ' of ' + total;
}

// ── Audio queue ────────────────────────────────────────────────────────────
function enqueue(b64, txt){
  if(!b64) return;
  queue.push({ b64, txt });
  playNext();
}

function playNext(){
  if(playing || queue.length === 0) return;
  playing = true;
  const { b64, txt } = queue.shift();
  dbg('🔊 ' + txt.substring(0,70));
  status('speaking','🗣️ Speaking...');

  try {
    const raw = atob(b64);
    const buf = new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++) buf[i]=raw.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([buf],{type:'audio/mpeg'}));
    const a   = $('audio');
    a.src = url;
    a.onended  = ()=>{ URL.revokeObjectURL(url); playing=false; status('listening','👂 Listening...'); playNext(); };
    a.onerror  = ()=>{ playing=false; playNext(); };
    a.play().catch(e=>{ dbg('play() '+e.message); playing=false; playNext(); });
  } catch(e){ dbg('audio error: '+e.message); playing=false; playNext(); }
}

// ── API ────────────────────────────────────────────────────────────────────
async function apiStart(){
  dbg('Starting session...');
  status('thinking','🧠 Generating questions for '+ROLE+'...');
  try{
    const r = await fetch(SERVER+'/api/start',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId:SID, role:ROLE })
    });
    if(!r.ok) throw new Error('HTTP '+r.status+': '+await r.text());
    const d = await r.json();
    questions = d.questions || [];
    totalQ    = d.totalQuestions || 2;
    $('qt').textContent = questions[0] || 'Interview starting...';
    setProgress(0, totalQ);
    dbg('✅ Started. Playing greeting...');
    enqueue(d.audio, d.greeting||'');
  } catch(e){
    dbg('start error: '+e.message);
    status('idle','❌ Start failed: '+e.message.substring(0,60));
  }
}

async function apiRespond(text){
  if(done||thinking) return;
  const t = text.trim();
  if(t.length < 4 || t === lastSent) return;
  lastSent  = t;
  thinking  = true;
  $('tt').textContent = '(processing your answer...)';
  status('thinking','🧠 Thinking...');
  try{
    const r = await fetch(SERVER+'/api/respond',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId:SID, text:t })
    });
    thinking = false;
    if(r.status === 429){ return; }
    if(!r.ok){ const err=await r.text(); throw new Error('HTTP '+r.status+': '+err); }
    const d = await r.json();
    setMetrics(d.metrics);
    qIdx = d.questionIndex ?? qIdx;
    setProgress(qIdx, d.totalQuestions ?? totalQ);
    if(d.currentQ) $('qt').textContent = d.currentQ;
    if(d.done){
      done = true;
      $('qt').textContent = '✅ Interview complete — thank you!';
      status('done','✅ All done!');
    }
    enqueue(d.audio, d.text||'');
  } catch(e){
    thinking = false;
    dbg('respond error: '+e.message.substring(0,80));
    status('listening','👂 Listening...');
  }
}

// ── Recall.ai transcript WebSocket ─────────────────────────────────────────
// Runs inside Recall.ai's headless browser.
// Connects to Recall.ai's built-in transcript feed — no auth needed.
let ws, retries = 0;

function connect(){
  dbg('Connecting to transcript feed...');
  try {
    ws = new WebSocket('wss://meeting-data.bot.recall.ai/api/v1/transcript');
  } catch(e){
    dbg('WS init: '+e.message);
    setTimeout(connect, 4000);
    return;
  }

  ws.onopen = () => {
    retries = 0;
    dbg('✅ Transcript feed connected');
    status('listening','👂 Connected — starting interview...');
    apiStart();
  };

  ws.onmessage = (e) => {
    // While bot is speaking or thinking, ignore incoming transcript to avoid
    // bot hearing its own voice or interrupting itself
    if(playing || thinking || done) return;

    let d;
    try { d = JSON.parse(e.data); } catch { return; }

    // Recall.ai transcript format: { transcript: { words: [{text},...] } }
    const words = d?.transcript?.words || d?.words || [];
    if(!words.length) return;

    const chunk = words.map(w => w.text||w.word||'').join(' ').trim();
    if(!chunk) return;

    // Accumulate words
    accumulated = accumulated ? accumulated + ' ' + chunk : chunk;
    $('tt').textContent = accumulated;

    // After SILENCE ms of no new words, process the full accumulated text
    clearTimeout(silTimer);
    silTimer = setTimeout(() => {
      const final = accumulated.trim();
      accumulated = '';
      $('tt').textContent = '(listening)';
      if(final.length > 4) {
        dbg('📝 Got: '+final.substring(0,80));
        apiRespond(final);
      }
    }, SILENCE);
  };

  ws.onerror = e => dbg('WS err: '+(e.message||'?'));

  ws.onclose = () => {
    if(done) return;
    const delay = Math.min(2000 * (++retries), 15000);
    dbg('WS closed — retry in '+(delay/1000)+'s');
    status('idle','⏳ Reconnecting...');
    setTimeout(connect, delay);
  };
}

connect();
</script>
</body>
</html>`;

  res.removeHeader("X-Frame-Options");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.type("text/html").send(html);
});

// ─────────────────────────────────────────────────────────────────────────────
// AI: Generate 2 role-specific questions
// Uses direct HTTP to Bedrock with ABSK Bearer token (NOT AWS SDK)
// ─────────────────────────────────────────────────────────────────────────────
async function generateQuestions(role) {
  const prompt = `Generate exactly 2 interview questions for a ${role} position.
Return ONLY a valid JSON array of 2 strings. No explanation, no numbering.
Example: ["First question?","Second question?"]
Make questions open-ended, covering experience and a technical/problem-solving scenario.`;

  try {
    const result = await callClaude([{ role: "user", content: prompt }], null, 400);
    const text = result?.content?.[0]?.text || "";
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr) && arr.length >= 2) return arr.slice(0, 2);
    }
  } catch (e) {
    log.error(`generateQuestions: ${e.message}`);
  }

  // Fallback
  return [
    `Tell me about your experience as a ${role} — what are you most proud of?`,
    `Describe a difficult technical problem you solved and how you approached it.`,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// AI: Evaluate candidate answer + decide if next question
// ─────────────────────────────────────────────────────────────────────────────
async function evaluateAnswer(session, question, answer) {
  const system = `You are a friendly interviewer for a ${session.role} position.
The current question was: "${question}"
The candidate just answered. Respond naturally in 1-2 sentences max.
Acknowledge what they said, then EITHER ask a brief follow-up OR say you're ready to move on.

End your response with EXACTLY this tag on its own line:
[SCORE] clarity:N depth:N comm:N next:yes
Where N = 1-10. Use next:yes when satisfied with the answer and ready to move on.`;

  try {
    const messages = session.history.map(m => ({ role: m.role, content: m.content }));
    const result = await callClaude(messages, system, 250);
    const full = result?.content?.[0]?.text || "";

    const m = full.match(/\[SCORE\]\s*clarity:(\d+)\s*depth:(\d+)\s*comm:(\d+)\s*next:(yes|no)/i);
    const metrics = m
      ? { clarity: +m[1], depth: +m[2], communication: +m[3] }
      : { clarity: 6, depth: 6, communication: 6 };
    const next = m ? m[4].toLowerCase() === "yes" : true;
    const text = full.replace(/\[SCORE\].*$/im, "").trim() || "Thank you for that. Let's continue.";

    return { text, metrics, next };
  } catch (e) {
    log.error(`evaluateAnswer: ${e.message}`);
    return {
      text: "Thank you for sharing that.",
      metrics: { clarity: 6, depth: 6, communication: 6 },
      next: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude via direct HTTP — works with ABSK Bedrock API keys (Bearer token)
// Also decodes ABSK → accessKeyId:secretKey for fallback IAM signing
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(messages, system, maxTokens = 300) {
  if (!BEDROCK_API_KEY) throw new Error("BEDROCK_API_KEY not configured");

  const url  = `https://bedrock-runtime.${AWS_REGION}.amazonaws.com/model/${MODEL_ID}/invoke`;
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-06-01",
    max_tokens:        maxTokens,
    ...(system ? { system } : {}),
    messages,
  });

  // ── Attempt 1: ABSK Bearer token (new Bedrock API key format) ────────────
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Accept":        "application/json",
        "Authorization": `Bearer ${BEDROCK_API_KEY}`,
      },
      body,
    });

    if (res.ok) {
      const json = await res.json();
      log.info(`✅ Bedrock OK (Bearer)`);
      return json;
    }

    const errText = await res.text();
    log.warn(`Bearer attempt failed (${res.status}): ${errText.substring(0, 120)}`);

    // If it's a 403 auth error, try decode
    if (res.status !== 403 && res.status !== 401) {
      throw new Error(`Bedrock ${res.status}: ${errText}`);
    }
  } catch (e) {
    if (!e.message.includes("fetch")) throw e;
    log.warn(`Bearer fetch error: ${e.message}`);
  }

  // ── Attempt 2: Decode ABSK → parse embedded credentials ─────────────────
  // ABSK keys encode: base64(accessKeyId + ":" + secretAccessKey)
  try {
    const decoded  = Buffer.from(BEDROCK_API_KEY.replace(/^ABSK/, ""), "base64").toString("utf8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx > 0) {
      const accessKeyId     = decoded.substring(0, colonIdx);
      const secretAccessKey = decoded.substring(colonIdx + 1);
      log.info(`🔑 Decoded ABSK → keyId=${accessKeyId.substring(0,20)}...`);

      // Use AWS SigV4 signing via SDK with decoded credentials
      const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
      const client = new BedrockRuntimeClient({
        region: AWS_REGION,
        credentials: { accessKeyId, secretAccessKey },
      });
      const cmd = new InvokeModelCommand({
        modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body,
      });
      const resp = await client.send(cmd);
      const json = JSON.parse(new TextDecoder().decode(resp.body));
      log.info(`✅ Bedrock OK (decoded ABSK)`);
      return json;
    }
  } catch (e2) {
    log.error(`Decoded ABSK attempt: ${e2.message}`);
  }

  // ── Attempt 3: Direct IAM credentials if set in env ─────────────────────
  if (BEDROCK_KEY_NAME && BEDROCK_KEY_NAME.startsWith("AKIA")) {
    try {
      const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
      const client = new BedrockRuntimeClient({
        region: AWS_REGION,
        credentials: { accessKeyId: BEDROCK_KEY_NAME, secretAccessKey: BEDROCK_API_KEY },
      });
      const cmd = new InvokeModelCommand({
        modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body,
      });
      const resp = await client.send(cmd);
      return JSON.parse(new TextDecoder().decode(resp.body));
    } catch (e3) {
      log.error(`IAM attempt: ${e3.message}`);
    }
  }

  throw new Error("All Bedrock authentication methods failed. Check your credentials.");
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function updateMetrics(s, inc) {
  s.responseCount++;
  const n = s.responseCount, m = s.metrics;
  m.clarity       = Math.round((m.clarity       * (n-1) + (inc.clarity||6))       / n);
  m.depth         = Math.round((m.depth         * (n-1) + (inc.depth||6))         / n);
  m.communication = Math.round((m.communication * (n-1) + (inc.communication||6)) / n);
  m.overall       = Math.round(((m.clarity + m.depth + m.communication) / 3) * 10);
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────
async function tts(text) {
  if (!ELEVENLABS_API_KEY || !text) return null;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!r.ok) { log.error(`TTS ${r.status}: ${await r.text()}`); return null; }
    const buf = await r.arrayBuffer();
    log.info(`🎵 TTS ${(buf.byteLength/1024).toFixed(1)}KB "${text.substring(0,50)}"`);
    return Buffer.from(buf).toString("base64");
  } catch (e) {
    log.error(`TTS error: ${e.message}`);
    return null;
  }
}

// ── n8n ───────────────────────────────────────────────────────────────────────
async function sendToN8n(s) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: s.id, role: s.role, metrics: s.metrics,
        questionsAsked: s.currentQ + 1, transcript: s.history,
        timestamp: new Date().toISOString(),
      }),
    });
    log.info("📊 Results → n8n");
  } catch (e) { log.error(`n8n: ${e.message}`); }
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log.info(`\n🚀 AI Interview Bot — port ${PORT}`);
  log.info(`   /meeting-page?server=DOMAIN&role=Frontend+Developer`);
  log.info(`   POST /api/start`);
  log.info(`   POST /api/respond\n`);
});
