// =============================================================================
// AI Interview Bot v3.0 — Production
//
// Architecture:
//   OpenAI Realtime API (WebSocket) for conversation
//   ElevenLabs for text-to-speech
//   Recall.ai bot for meeting integration
//
// Flow:
//   POST /api/schedule-bot  →  Recall.ai creates bot with join_at
//   Bot joins meeting       →  bot camera loads /meeting-page
//   /meeting-page           →  WebSocket to server → OpenAI Realtime API
//   Audio: getUserMedia → PCM16 24kHz → server → OpenAI
//   Response: OpenAI text → ElevenLabs TTS → MP3 audio → meeting page
//   Interview completes    →  report sent to n8n webhook
// =============================================================================

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
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

import { RealtimeSession } from "./realtime/openaiRealtime.js";
import { buildRealtimeInstructions, buildGreetingPrompt, INTERVIEW_TOOLS } from "./tools/questionGenerator.js";
import { processToolCall, generateReport } from "./tools/evaluator.js";
import { sendResultsToN8n } from "./tools/webhookSender.js";
import { textToSpeech } from "./voice/tts.js";
import { scheduleInterviewBot, batchScheduleInterviews, retrieveBotArtifacts } from "./tools/botScheduler.js";
import { createGoogleMeetSpace } from "./tools/googleMeet.js";
import { createTeamsMeeting } from "./tools/teamsMeeting.js";

const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";

// Public-facing URL — used when building meeting-page links for Recall.ai bots.
// In Replit, REPLIT_DEV_DOMAIN is the proxied public domain (no port needed).
const PUBLIC_URL = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}`
  : `http://localhost:${PORT}`;

console.log("\n=== AI Interview Bot v3.0 (Realtime) ===");
console.log(`OPENAI_API_KEY        : ${process.env.OPENAI_API_KEY        ? "set" : "MISSING"}`);
console.log(`RECALL_API_KEY        : ${process.env.RECALL_API_KEY        ? "set" : "MISSING"}`);
console.log(`ELEVENLABS_KEY        : ${process.env.ELEVENLABS_API_KEY    ? "set" : "MISSING"}`);
console.log(`GOOGLE_MEET_TOKEN     : ${process.env.GOOGLE_MEET_ACCESS_TOKEN ? "set" : "not set (pass per-request)"}`);
console.log(`TEAMS_TOKEN           : ${process.env.TEAMS_ACCESS_TOKEN    ? "set" : "not set (pass per-request)"}`);
console.log(`N8N_WEBHOOK_URL       : ${process.env.N8N_WEBHOOK_URL       ? "set" : "not set"}`);
console.log(`PUBLIC_URL            : ${PUBLIC_URL}`);
console.log("=========================================\n");

initializeGarbageCollection();

const app = express();
const server = createServer(app);

app.use(express.json({ limit: "10mb" }));

// CORS — restrict to configured origins in production; allow all in development
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : null;
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, curl, Recall.ai webhooks)
    if (!origin) return cb(null, true);
    // Allow all if ALLOWED_ORIGINS not configured (dev mode)
    if (!ALLOWED_ORIGINS) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// =============================================================================
// Active Realtime Sessions — Map<sessionId, { realtime, clientWs }>
// =============================================================================
const activeConnections = new Map();

// Map<botId, sessionId> — resolves Recall.ai botId to our sessionId
const botSessionMap = new Map();

// =============================================================================
// WebSocket Server — Meeting page connects here for real-time audio streaming
// =============================================================================
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  console.log("[WS] New client connected");
  let sessionId = null;
  let realtimeSession = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      // ── Initialize interview session ─────────────────────
      case "init": {
        sessionId = msg.sessionId || `ws_${Date.now()}`;

        let session = getSession(sessionId);
        if (!session) {
          session = createSession(sessionId, {
            candidateName: msg.candidate || "Candidate",
            role:          msg.role || "Software Engineer",
            resume:        msg.resume || null,
            difficulty:    msg.difficulty || "medium",
            interviewType: msg.interviewType || "mixed",
            maxDuration:   msg.maxDuration || 30,
          });
        }

        console.log(`[WS] Init session: ${sessionId} (${session.candidateName} / ${session.role})`);

        try {
          // Create OpenAI Realtime session
          const instructions = buildRealtimeInstructions(session);
          realtimeSession = new RealtimeSession({
            // Text response complete — TTS and send to client
            onResponseText: async (text) => {
              if (!text?.trim()) return;
              console.log(`[Realtime] Response: "${text.substring(0, 80)}..."`);

              // Record in session history
              session.history.push({ role: "assistant", content: text, phase: session.phase });

              // Always push text + phase to client immediately (UI update must not
              // wait on TTS — avoids Bug 3 where null audio swallows the phase update)
              wsSend(ws, { type: "text", text, phase: session.phase });

              // Generate TTS audio — null returned on failure, interview continues
              let audioBase64 = null;
              try {
                audioBase64 = await textToSpeech(text);
              } catch (err) {
                console.error("[TTS] Error:", err.message);
              }

              // Send audio separately — only if TTS produced data
              if (audioBase64) {
                wsSend(ws, { type: "audio", data: audioBase64, phase: session.phase });
              }

              // Check if interview is done — guard with resultsSent to prevent
              // duplicate n8n deliveries (WS path + Recall.ai webhook both trigger this).
              // Bug 7 fix: delay the "done" signal until the audio queue drains on the
              // client — we signal "done_pending" so the client shows it after playback.
              if (session.done && !session.resultsSent) {
                session.resultsSent = true;
                await sendResultsToN8n(session);
                const report = generateReport(session);
                // done_pending: client shows overlay only after TTS queue finishes
                wsSend(ws, { type: "done_pending", report });
                console.log(`[Interview] Complete [${sessionId}] score=${report.overall_score}`);
              }
            },

            onResponseDelta: (delta) => {
              // Optional: stream text to client for live preview
              wsSend(ws, { type: "text_delta", delta });
            },

            // Tool call from OpenAI — process scoring/transitions
            onToolCall: (name, args, callId) => {
              console.log(`[Realtime] Tool call: ${name}`, JSON.stringify(args).substring(0, 100));
              const result = processToolCall(session, name, args);

              // Bug 1 fix: realtimeSession may not yet be assigned if OpenAI fires a
              // tool call synchronously during connect(). Guard before every use.
              if (!realtimeSession) {
                console.warn("[Realtime] Tool call arrived before session assigned — queuing result");
                // Store for submittal after connect resolves
                setImmediate(() => {
                  if (realtimeSession?.isConnected) {
                    realtimeSession.submitToolResult(callId, result);
                  }
                });
                return;
              }

              // Submit result back to OpenAI
              realtimeSession.submitToolResult(callId, result);

              // Notify client of phase changes
              wsSend(ws, { type: "phase", phase: session.phase });

              // Rebuild instructions whenever anything that affects the prompt changes:
              // language switch, phase transition, or question limit signal
              if (name === "transition_phase" || name === "change_language" ||
                  name === "evaluate_response") {
                const updatedInstructions = buildRealtimeInstructions(session);
                realtimeSession.updateInstructions(updatedInstructions);
              }
            },

            // Whisper transcription of candidate's speech
            onTranscript: (text) => {
              if (!text?.trim()) return;
              // Fix 11: Normalised dedup — catches near-duplicates (punctuation/case variations)
              const normalize = s => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
              const lastUser = session.history.filter(h => h.role === "user").pop();
              if (lastUser && normalize(lastUser.content) === normalize(text)) return;
              console.log(`[Transcript] "${text.substring(0, 80)}..."`);
              session.history.push({ role: "user", content: text.trim(), phase: session.phase });
              wsSend(ws, { type: "transcript", text: text.trim(), partial: false });
            },

            onSpeechStart: () => {
              wsSend(ws, { type: "speech_start" });
            },
            onSpeechStop: () => {
              wsSend(ws, { type: "speech_stop" });
            },

            onError: (err) => {
              console.error("[Realtime] Error:", err.message);
              wsSend(ws, { type: "error", message: err.message });
            },
            onClose: () => {
              console.log(`[Realtime] OpenAI session closed for ${sessionId}`);
            },
          });

          await realtimeSession.connect(instructions, INTERVIEW_TOOLS);

          // Store active connection
          activeConnections.set(sessionId, { realtime: realtimeSession, clientWs: ws });

          wsSend(ws, { type: "ready", sessionId, phase: session.phase });

          // If session has history (reconnect), replay context to OpenAI
          if (session.history.length > 0) {
            console.log(`[WS] Replaying ${session.history.length} messages for reconnect`);
            for (const entry of session.history.slice(-20)) { // Last 20 messages for context
              realtimeSession._sendEvent("conversation.item.create", {
                item: {
                  type: "message",
                  role: entry.role,
                  // Fix 2: assistant items must use type "text", not "input_text"
                  content: entry.role === "assistant"
                    ? [{ type: "text", text: entry.content }]
                    : [{ type: "input_text", text: entry.content }],
                },
              });
            }
            if (msg.isReconnect) {
              // Fix 12: true client-side reconnect — history replayed, wait for candidate to speak
              console.log(`[WS] Reconnect: history replayed for ${sessionId} — awaiting candidate`);
            } else {
              // First load but session already existed (e.g. bot restart) — AI continues
              realtimeSession.triggerResponse("Continue the interview from where we left off. Ask the next question.");
            }
          } else {
            // Fresh interview — send greeting
            const greetingPrompt = buildGreetingPrompt(session);
            realtimeSession.triggerResponse(greetingPrompt);
          }

        } catch (err) {
          console.error("[WS] Init error:", err.message);
          wsSend(ws, { type: "error", message: `Failed to start: ${err.message}` });
          // Clean up orphaned session so it doesn't leak memory
          if (sessionId) {
            deleteSession(sessionId);
            activeConnections.delete(sessionId);
          }
        }
        break;
      }

      // ── Audio chunk from meeting page (PCM16 24kHz base64) ─
      case "audio": {
        // Silently drop audio if not connected (high frequency, don't spam errors)
        if (realtimeSession?.isConnected && msg.data) {
          realtimeSession.sendAudio(msg.data);
        }
        break;
      }

      // ── Text input (fallback / testing / Recall.ai transcript) ─
      case "text": {
        if (!realtimeSession?.isConnected) {
          wsSend(ws, { type: "error", message: "Realtime session not connected" });
          break;
        }
        if (msg.text?.trim()) {
          console.log(`[WS] Text input: "${msg.text.substring(0, 60)}..."`);
          realtimeSession.sendText(msg.text);
        }
        break;
      }

      // ── Clear audio buffer (echo cancellation) ────────────
      case "clear_audio": {
        if (realtimeSession?.isConnected) {
          realtimeSession.clearAudioBuffer();
        }
        break;
      }

      default:
        console.warn(`[WS] Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    console.log(`[WS] Client disconnected: ${sessionId || "unknown"}`);
    if (realtimeSession) {
      realtimeSession.close();
    }
    if (sessionId) {
      activeConnections.delete(sessionId);
    }
  });

  ws.on("error", (err) => {
    console.error(`[WS] Client error:`, err.message);
  });
});

function wsSend(ws, data) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data));
  }
}

// =============================================================================
// Deduplication (for Recall.ai webhook reliability)
// =============================================================================
const processedEvents = new Map();
const EVENT_DEDUP_TTL = 5 * 60 * 1000;

function createDedupKey(botId, event, text) {
  const textHash = createHash("md5").update(text).digest("hex").substring(0, 16);
  return `${botId}_${event}_${textHash}`;
}

function isDuplicate(key) {
  if (processedEvents.has(key)) return true;
  // Bug 4 fix: GC before inserting, not after — keeps map bounded at all times
  if (processedEvents.size >= 1000) {
    const now = Date.now();
    for (const [k, v] of processedEvents.entries()) {
      if (now - v > EVENT_DEDUP_TTL) processedEvents.delete(k);
    }
  }
  processedEvents.set(key, Date.now());
  return false;
}

// =============================================================================
// GET /health
// =============================================================================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "3.0",
    architecture: "openai-realtime",
    sessions: getAllSessions().length,
    activeConnections: activeConnections.size,
  });
});

// =============================================================================
// POST /api/schedule-bot
// =============================================================================
app.post("/api/schedule-bot", async (req, res) => {
  try {
    const {
      candidate_name, role, resume, meeting_url, meeting_time,
      server_url, interview_type, difficulty, language,
    } = req.body || {};

    if (!candidate_name || !role || !meeting_url || !meeting_time) {
      return res.status(400).json({
        error: "Required: candidate_name, role, meeting_url, meeting_time",
      });
    }

    // server_url is optional — defaults to this server's public URL
    const resolvedServerUrl = server_url || PUBLIC_URL;

    const result = await scheduleInterviewBot({
      candidate_name, role, resume, meeting_url, meeting_time,
      interview_type, difficulty, language, ngrok_url: resolvedServerUrl,
    });

    if (!result.success) return res.status(400).json({ error: result.error });

    const sessionId = result.session_id;
    createSession(sessionId, {
      candidateName: candidate_name,
      role,
      resume,
      interviewType: interview_type || "mixed",
      difficulty: difficulty || "medium",
      language: language || "en-US",
    });

    // Map botId → sessionId so webhooks can find the session
    botSessionMap.set(result.bot_id, sessionId);

    console.log(`[schedule-bot] Session ready: ${sessionId} (bot: ${result.bot_id})`);
    return res.json({
      success: true,
      bot_id: result.bot_id,
      session_id: sessionId,
      joined_at: result.joined_at,
      meeting_url: result.meeting_url,
      message: `Bot scheduled to join at ${new Date(result.joined_at).toLocaleString()}`,
    });
  } catch (err) {
    console.error("[schedule-bot] Unexpected error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================================
// POST /api/batch-schedule
// =============================================================================
app.post("/api/batch-schedule", async (req, res) => {
  const { interviews, server_url } = req.body || {};
  if (!Array.isArray(interviews) || interviews.length === 0) {
    return res.status(400).json({ error: "Required: interviews[] array" });
  }

  const resolvedServerUrl = server_url || PUBLIC_URL;
  const configs = interviews.map((i) => ({ ...i, ngrok_url: resolvedServerUrl }));
  const results = await batchScheduleInterviews(configs);

  const successful = [];
  const failed = [];
  for (const r of results) {
    if (r.success) {
      const sid = r.session_id;
      createSession(sid, {
        candidateName: r.candidate_name,
        role:          r.role,
        resume:        r.resume,
        interviewType: r.interview_config?.interview_type || "mixed",
        difficulty:    r.interview_config?.difficulty     || "medium",
        language:      r.interview_config?.language       || "en-US",
      });
      botSessionMap.set(r.bot_id, sid);
      successful.push(r);
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
// POST /api/create-google-meet
// Creates a Google Meet space via the Google Meet REST API.
// Auth: OAuth 2.0 Bearer token — pass access_token in body or set
//       GOOGLE_MEET_ACCESS_TOKEN environment variable.
// Optional: include schedule_bot fields to also schedule a Recall.ai bot.
// =============================================================================
app.post("/api/create-google-meet", async (req, res) => {
  try {
    const {
      access_token,
      access_type,
      entry_point_access,
      // Optional: auto-schedule a Recall.ai bot after creating the meeting
      schedule_bot,
      candidate_name,
      role,
      resume,
      meeting_time,
      interview_type,
      difficulty,
      language,
      server_url,
    } = req.body || {};

    // Step 1 — Create the Google Meet space
    const meetResult = await createGoogleMeetSpace({
      access_token,
      access_type,
      entry_point_access,
    });

    if (!meetResult.success) {
      return res.status(400).json({ error: meetResult.error, details: meetResult.details });
    }

    const response = {
      success:      true,
      platform:     "google_meet",
      meeting_url:  meetResult.meeting_url,
      meeting_code: meetResult.meeting_code,
      space_name:   meetResult.space_name,
      config:       meetResult.config,
    };

    // Step 2 (optional) — Schedule a Recall.ai bot to join the meeting
    if (schedule_bot && candidate_name && role && meeting_time) {
      const resolvedServerUrl = server_url || PUBLIC_URL;
      const botResult = await scheduleInterviewBot({
        candidate_name,
        role,
        resume,
        meeting_url:  meetResult.meeting_url,
        meeting_time,
        interview_type,
        difficulty,
        language,
        ngrok_url: resolvedServerUrl,
      });

      if (botResult.success) {
        createSession(botResult.session_id, {
          candidateName: candidate_name,
          role,
          resume,
          interviewType: interview_type || "mixed",
          difficulty:    difficulty     || "medium",
          language:      language       || "en-US",
        });
        botSessionMap.set(botResult.bot_id, botResult.session_id);
        response.bot = {
          bot_id:     botResult.bot_id,
          session_id: botResult.session_id,
          joined_at:  botResult.joined_at,
        };
        console.log(`[create-google-meet] Bot scheduled: ${botResult.bot_id} → ${meetResult.meeting_url}`);
      } else {
        // Meeting was created — include bot error as warning, not a full failure
        response.bot_warning = `Meeting created but bot scheduling failed: ${botResult.error}`;
        console.warn("[create-google-meet] Bot scheduling failed:", botResult.error);
      }
    }

    console.log(`[create-google-meet] ✓ ${meetResult.meeting_url}`);
    return res.json(response);

  } catch (err) {
    console.error("[create-google-meet] Unexpected error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================================
// POST /api/create-teams-meeting
// Creates a Microsoft Teams online meeting via Microsoft Graph API.
// Auth: Azure AD / Microsoft Entra ID Bearer token — pass access_token in body
//       or set TEAMS_ACCESS_TOKEN environment variable.
// Optional: include schedule_bot fields to also schedule a Recall.ai bot.
// =============================================================================
app.post("/api/create-teams-meeting", async (req, res) => {
  try {
    const {
      access_token,
      subject,
      start_datetime,
      end_datetime,
      lobby_bypass,
      dial_in_bypass,
      // Optional: auto-schedule a Recall.ai bot after creating the meeting
      schedule_bot,
      candidate_name,
      role,
      resume,
      meeting_time,
      interview_type,
      difficulty,
      language,
      server_url,
    } = req.body || {};

    // Step 1 — Create the Teams meeting
    const teamsResult = await createTeamsMeeting({
      access_token,
      subject,
      start_datetime,
      end_datetime,
      lobby_bypass,
      dial_in_bypass,
    });

    if (!teamsResult.success) {
      return res.status(400).json({ error: teamsResult.error, details: teamsResult.details });
    }

    const response = {
      success:        true,
      platform:       "teams",
      meeting_url:    teamsResult.meeting_url,
      meeting_id:     teamsResult.meeting_id,
      subject:        teamsResult.subject,
      start_datetime: teamsResult.start_datetime,
      end_datetime:   teamsResult.end_datetime,
      lobby_bypass_settings: teamsResult.lobby_bypass_settings,
    };

    // Step 2 (optional) — Schedule a Recall.ai bot to join the meeting
    if (schedule_bot && candidate_name && role && meeting_time) {
      const resolvedServerUrl = server_url || PUBLIC_URL;
      const botResult = await scheduleInterviewBot({
        candidate_name,
        role,
        resume,
        meeting_url:  teamsResult.meeting_url,
        meeting_time,
        interview_type,
        difficulty,
        language,
        ngrok_url: resolvedServerUrl,
      });

      if (botResult.success) {
        createSession(botResult.session_id, {
          candidateName: candidate_name,
          role,
          resume,
          interviewType: interview_type || "mixed",
          difficulty:    difficulty     || "medium",
          language:      language       || "en-US",
        });
        botSessionMap.set(botResult.bot_id, botResult.session_id);
        response.bot = {
          bot_id:     botResult.bot_id,
          session_id: botResult.session_id,
          joined_at:  botResult.joined_at,
        };
        console.log(`[create-teams-meeting] Bot scheduled: ${botResult.bot_id} → ${teamsResult.meeting_url}`);
      } else {
        response.bot_warning = `Meeting created but bot scheduling failed: ${botResult.error}`;
        console.warn("[create-teams-meeting] Bot scheduling failed:", botResult.error);
      }
    }

    console.log(`[create-teams-meeting] ✓ ${teamsResult.meeting_url}`);
    return res.json(response);

  } catch (err) {
    console.error("[create-teams-meeting] Unexpected error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================================
// GET /api/report/:sessionId
// =============================================================================
app.get("/api/report/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  return res.json(generateReport(session));
});

// =============================================================================
// POST /webhook/recall/events — Bot lifecycle
// =============================================================================
app.post("/webhook/recall/events", async (req, res) => {
  const event  = req.body?.event;
  const botId  = req.body?.data?.bot?.id;
  const meta   = req.body?.data?.bot?.metadata || {};
  res.json({ ok: true });

  console.log(`[Recall webhook] ${event} — bot: ${botId}`);
  if (!botId) return;

  // Resolve botId → sessionId.
  // Priority: 1) in-memory botSessionMap (set at schedule time)
  //           2) session_id stored in bot metadata (survives server restarts)
  //           3) fallback to bot_<botId> UUID (last resort)
  const sessionId = botSessionMap.get(botId) || meta.session_id || `bot_${botId}`;

  if (event === "bot.in_call_recording") {
    if (!hasSession(sessionId) && meta.candidate_name && meta.role) {
      createSession(sessionId, {
        candidateName: meta.candidate_name,
        role:          meta.role,
        interviewType: meta.interview_type || "mixed",
        difficulty:    meta.difficulty     || "medium",
        language:      meta.language       || "en-US",
      });
      botSessionMap.set(botId, sessionId);
      console.log(`[Recall webhook] Session auto-created: ${sessionId} for bot ${botId}`);
    }
  }

  if (event === "bot.call_ended" || event === "bot.done") {
    const session = getSession(sessionId);
    if (session && !session.resultsSent) {
      session.done        = true;
      session.resultsSent = true;
      setImmediate(async () => {
        try {
          const artifacts = await retrieveBotArtifacts(botId);
          if (artifacts.success) {
            session.transcript_url = artifacts.transcript_url;
            session.report_url     = artifacts.report_url;
            session.summary_url    = artifacts.summary_url;
          }
        } catch (err) {
          console.error(`[Bot.done] Artifact error:`, err.message);
        }
        await sendResultsToN8n(session);
        console.log(`[Recall webhook] Interview finalised: ${sessionId}`);
      });
    }

    // Close active WebSocket connection
    const conn = activeConnections.get(sessionId);
    if (conn) {
      conn.realtime?.close();
      activeConnections.delete(sessionId);
    }

    // Clean up bot→session mapping
    botSessionMap.delete(botId);
  }
});

// =============================================================================
// POST /webhook/recall/transcript — Fallback transcript from Recall.ai
// If audio capture fails, Recall.ai transcript feeds into the active session
// =============================================================================
app.post("/webhook/recall/transcript", (req, res) => {
  res.json({ ok: true });

  const event = req.body?.event;
  const data  = req.body?.data?.data || {};
  const words = data.words || [];
  const participant = data.participant || {};

  if (!words.length) return;

  const text = words.map(w => w.text).join(" ");
  const isPartial = event === "transcript.partial_data";
  const botId = req.body?.data?.bot?.id;

  if (!botId) return;

  const sessionId = botSessionMap.get(botId) || `bot_${botId}`;
  const conn = activeConnections.get(sessionId);
  if (!conn?.realtime?.isConnected) return;

  // Filter bot's own speech — use exact/prefix checks, NOT substring "ai"
  // which incorrectly drops candidates named Abigail, Mikail, etc. (Bug 8)
  const nameStr = (participant.name || "").toLowerCase();
  const isBotSpeaker =
    nameStr === "ai interview" ||
    nameStr.startsWith("dataalchemist") ||
    nameStr.startsWith("ai interview") ||
    nameStr === "bot" ||
    nameStr.includes("recall") ||
    nameStr.includes("notetaker");
  if (isBotSpeaker) return;

  if (isPartial) return; // Only process finalized transcript

  // Dedup
  const dedupKey = createDedupKey(botId, event, text);
  if (isDuplicate(dedupKey)) return;

  // Send as text to OpenAI Realtime (fallback path)
  console.log(`[Recall transcript] Forwarding to OpenAI: "${text.substring(0, 60)}..."`);
  conn.realtime.sendText(text);
});

// =============================================================================
// GET /meeting-page — Interview UI served to Recall.ai bot camera
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
  // Determine the correct public host — never expose 0.0.0.0 to the client.
  // Priority: ?server query param → x-forwarded-host → host header → PUBLIC_URL fallback.
  const rawHost    = req.query.server || req.get("x-forwarded-host") || req.get("host") || "";
  const publicHost = PUBLIC_URL.replace(/^https?:\/\//, "");
  const serverHost = (rawHost && !rawHost.startsWith("0.0.0.0")) ? rawHost : publicHost;

  const role       = req.query.role       || "Software Engineer";
  const candidate  = req.query.candidate  || "Candidate";
  const difficulty = req.query.difficulty  || "medium";
  const type       = req.query.type       || "mixed";
  const sessionId  = req.query.sessionId || "";
  const session    = sessionId ? getSession(sessionId) : null;
  const resumeText = session?.resume || req.query.resume || "";
  const maxDurationMinutes = session?.maxDurationMs ? Math.round(session.maxDurationMs / 60000) : 30;
  const proto      = req.get("x-forwarded-proto") || req.protocol || "https";
  const wsProto    = proto === "https" ? "wss" : "ws";
  const serverUrl  = `${proto}://${serverHost}`;
  const wsUrl      = `${wsProto}://${serverHost}/ws`;

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="permissions-policy" content="microphone=*; camera=*; speaker-selection=*">
<title>Interview - ${esc(candidate)}</title>
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
  font-family:var(--font);background:var(--bg);
  color:var(--text);display:flex;align-items:center;justify-content:center;
}
.page{
  width:100%;max-width:480px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;padding:32px 24px;height:100vh;
}
.top-bar{display:flex;align-items:center;justify-content:space-between;width:100%;margin-bottom:24px}
.top-left{display:flex;align-items:center;gap:8px}
.phase-tag{
  font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;
  padding:4px 10px;border-radius:20px;background:rgba(167,139,250,.12);color:var(--accent);
}
.timer{font-size:13px;font-weight:600;color:var(--text-light);font-variant-numeric:tabular-nums}
.timer.warning{color:#f59e0b}.timer.expired{color:#ef4444}
.phase-dots{display:flex;gap:6px;align-items:center;margin-bottom:28px}
.pdot{width:8px;height:8px;border-radius:50%;background:var(--bg2);border:1.5px solid #d1d5db;transition:all .4s ease}
.pdot.done{background:var(--accent);border-color:var(--accent)}
.pdot.active{background:var(--white);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.orb-wrap{position:relative;display:flex;align-items:center;justify-content:center;margin-bottom:24px}
.ring{position:absolute;border-radius:50%;border:1px solid rgba(167,139,250,.1);animation:ring-pulse 3s ease-in-out infinite}
.ring-1{width:260px;height:260px}.ring-2{width:310px;height:310px;animation-delay:.5s;border-color:rgba(167,139,250,.06)}
.ring-3{width:360px;height:360px;animation-delay:1s;border-color:rgba(167,139,250,.03)}
@keyframes ring-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.04);opacity:.5}}
.orb-wrap.speaking .ring{animation:ring-speak 1.5s ease-in-out infinite}
@keyframes ring-speak{0%,100%{transform:scale(1);opacity:.8}50%{transform:scale(1.08);opacity:.3}}
.orb{
  width:180px;height:180px;border-radius:50%;position:relative;z-index:2;
  background:linear-gradient(135deg,#c4b5fd,#818cf8,#6366f1,#a78bfa);background-size:300% 300%;
  animation:orb-gradient 6s ease infinite;
  box-shadow:0 8px 40px rgba(129,140,248,.3),0 0 80px rgba(167,139,250,.15);
  display:flex;align-items:center;justify-content:center;transition:transform .3s ease;
}
.orb-wrap.speaking .orb{transform:scale(1.05)}
.orb-wrap.processing .orb{animation:orb-gradient 2s ease infinite}
.orb-wrap.listening .ring{animation:ring-listen 2s ease-in-out infinite}
@keyframes ring-listen{0%,100%{transform:scale(1);opacity:.6}50%{transform:scale(1.02);opacity:.3}}
@keyframes orb-gradient{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.orb-icon{width:48px;height:48px;color:rgba(255,255,255,.9);filter:drop-shadow(0 2px 4px rgba(0,0,0,.1))}
.waveform{display:flex;align-items:center;justify-content:center;gap:3px;height:48px;margin-bottom:20px;width:200px}
.wbar{width:4px;border-radius:3px;background:linear-gradient(180deg,var(--accent),var(--accent2));height:8px;transition:height .1s ease;opacity:.5}
.waveform.active .wbar{opacity:1;animation:wbar-dance .5s ease-in-out infinite}
.wbar:nth-child(1){animation-delay:0s;--h:16px}.wbar:nth-child(2){animation-delay:.05s;--h:28px}
.wbar:nth-child(3){animation-delay:.1s;--h:20px}.wbar:nth-child(4){animation-delay:.15s;--h:36px}
.wbar:nth-child(5){animation-delay:.2s;--h:24px}.wbar:nth-child(6){animation-delay:.25s;--h:40px}
.wbar:nth-child(7){animation-delay:.3s;--h:32px}.wbar:nth-child(8){animation-delay:.2s;--h:44px}
.wbar:nth-child(9){animation-delay:.15s;--h:28px}.wbar:nth-child(10){animation-delay:.1s;--h:36px}.wbar:nth-child(11){animation-delay:.05s;--h:20px}.wbar:nth-child(12){animation-delay:.08s;--h:32px}.wbar:nth-child(13){animation-delay:.18s;--h:24px}.wbar:nth-child(14){animation-delay:.12s;--h:16px}.wbar:nth-child(15){animation-delay:.22s;--h:12px}
@keyframes wbar-dance{0%,100%{height:8px}50%{height:calc(8px + var(--h,24px))}}
.status-label{font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px;text-align:center;min-height:20px}
.status-sub{font-size:12px;color:var(--text-light);text-align:center;margin-bottom:16px;min-height:18px}
.mic-bar{
  width:100%;margin-top:12px;flex-shrink:0;display:flex;align-items:center;gap:10px;
  padding:10px 16px;border-radius:14px;background:var(--white);border:1px solid #e2e8f0;box-shadow:var(--shadow);
}
.mic-bar.active{border-color:rgba(167,139,250,.3)}
.mic-dot{width:10px;height:10px;border-radius:50%;background:#d1d5db;flex-shrink:0;transition:background .3s}
.mic-bar.active .mic-dot{background:#22c55e;animation:mic-pulse 1.5s ease-in-out infinite}
@keyframes mic-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.mic-text{font-size:12px;color:var(--text-light);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mic-bar.active .mic-text{color:var(--text-dim)}
.overlay{position:fixed;inset:0;background:rgba(248,249,252,.95);display:none;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(12px)}
.overlay.show{display:flex}
.done-card{background:var(--white);border:1px solid #e2e8f0;border-radius:24px;padding:48px 40px;text-align:center;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.08)}
.done-icon{width:72px;height:72px;border-radius:50%;margin:0 auto 20px;background:linear-gradient(135deg,#34d399,#22c55e);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(52,211,153,.3)}
.done-icon svg{width:36px;height:36px;color:#fff}
.done-card h2{font-size:22px;font-weight:700;margin-bottom:8px;color:var(--text)}
.done-card p{font-size:14px;color:var(--text-dim);line-height:1.6}
.ai-text{font-size:13px;color:var(--text-dim);text-align:center;margin:0 auto 8px;min-height:40px;line-height:1.55;max-width:380px;opacity:0;transition:opacity .35s;word-break:break-word}
.ai-text.visible{opacity:1}
</style>
</head>
<body>
<div class="page">
  <div class="top-bar">
    <div class="top-left"><div class="phase-tag" id="phaseTag">INTRO</div></div>
    <div class="timer" id="timer">00:00</div>
  </div>
  <div class="phase-dots" id="phaseDots">
    <div class="pdot active"></div><div class="pdot"></div><div class="pdot"></div><div class="pdot"></div><div class="pdot"></div>
  </div>
  <div class="orb-wrap" id="orbWrap">
    <div class="ring ring-3"></div><div class="ring ring-2"></div><div class="ring ring-1"></div>
    <div class="orb" id="orb">
      <svg class="orb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>
    </div>
  </div>
  <div class="waveform" id="waveform">
    <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
    <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
    <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
  </div>
  <div class="status-label" id="statusLabel">Connecting...</div>
  <div class="ai-text" id="aiText"></div>
  <div class="status-sub" id="statusSub">${esc(candidate)} &middot; ${esc(role)}</div>
  <div class="mic-bar" id="micBar">
    <div class="mic-dot"></div>
    <div class="mic-text" id="micText">Waiting for microphone...</div>
  </div>
</div>
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
    sessionId:     '${esc(sessionId)}' || ('ws_' + Date.now()),
    wsUrl:         '${wsUrl}',
    role:          '${esc(role)}',
    candidate:     '${esc(candidate)}',
    difficulty:    '${esc(difficulty)}',
    interviewType: '${esc(type)}',
    resume:        '${esc(resumeText)}',
    maxDuration:   ${maxDurationMinutes},
  };

  var PHASE_NAMES  = ['introduction','resume','technical','behavioral','closing','done'];
  var PHASE_LABELS = ['INTRO','RESUME','TECHNICAL','BEHAVIORAL','CLOSING','DONE'];

  // ── State ──────────────────────────────────────────────
  var ws = null;
  var playing = false, interviewDone = false;
  var audioQueue = [], currentAudio = null;
  var pendingDone = false;         // Bug 7: set true when done_pending arrives
  var pendingDoneReport = null;    // holds report until audio queue drains
  var clearAudioTimer = null;      // Fix 10: debounce clear_audio between TTS segments
  var sessionEstablished = false;  // Fix 12: true after first successful ready event
  var startTime = null;
  var currentPhase = 'introduction';
  var audioContext = null, micStream = null, timerInterval = null;

  // ── DOM ────────────────────────────────────────────────
  var $orbWrap  = document.getElementById('orbWrap');
  var $wave     = document.getElementById('waveform');
  var $label    = document.getElementById('statusLabel');
  var $sub      = document.getElementById('statusSub');
  var $aiText   = document.getElementById('aiText');
  var $timer    = document.getElementById('timer');
  var $phaseTag = document.getElementById('phaseTag');
  var $micBar   = document.getElementById('micBar');
  var $micText  = document.getElementById('micText');
  var $overlay  = document.getElementById('overlay');

  // ── UI Helpers ─────────────────────────────────────────
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
    // Fix 5: dynamic warning thresholds based on actual session maxDuration
    var warnAt   = Math.max(5, CFG.maxDuration - 8);
    var expireAt = Math.max(warnAt + 1, CFG.maxDuration - 2);
    $timer.className = 'timer' + (m >= expireAt ? ' expired' : m >= warnAt ? ' warning' : '');
  }

  function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function setMic(text, active) {
    $micText.textContent = text || 'Waiting for speech...';
    $micBar.className = 'mic-bar' + (active ? ' active' : '');
  }

  // ── Audio Playback Queue ───────────────────────────────
  function enqueueAudio(b64) {
    if (!b64) { if (!audioQueue.length) playing = false; return; }
    // Fix 10: cancel pending clear_audio — new audio chunk arrived before debounce fired
    if (clearAudioTimer) { clearTimeout(clearAudioTimer); clearAudioTimer = null; }
    audioQueue.push(b64);
    if (!playing) playNext();
  }

  // Stop TTS immediately — used for barge-in when user speaks during playback.
  // Does NOT send clear_audio so OpenAI keeps the user's speech already buffered.
  function stopPlayback() {
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.pause();
      currentAudio = null;
    }
    if (clearAudioTimer) { clearTimeout(clearAudioTimer); clearAudioTimer = null; }
    audioQueue = [];
    playing = false;
  }

  // Fix 10: debounced clear_audio — only fires if no new TTS chunk arrives within 600ms.
  // Prevents flushing candidate speech in the gap between ElevenLabs audio segments.
  function scheduleClearAudio() {
    if (clearAudioTimer) clearTimeout(clearAudioTimer);
    clearAudioTimer = setTimeout(function() {
      clearAudioTimer = null;
      if (!playing && audioQueue.length === 0 && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'clear_audio' }));
      }
    }, 600);
  }

  function playNext() {
    if (audioQueue.length === 0) {
      playing = false;
      currentAudio = null;
      // TTS finished naturally — schedule debounced echo flush
      scheduleClearAudio();
      // Bug 7 fix: show done overlay only after the last TTS chunk finishes playing
      if (pendingDone) {
        pendingDone = false;
        interviewDone = true;
        setTimeout(function() { $overlay.classList.add('show'); }, 800);
        return;
      }
      setMode('listening', 'Listening...', CFG.candidate + ' - ' + CFG.role);
      return;
    }
    playing = true;
    // Mic stays ACTIVE during playback — browser echoCancellation handles feedback.
    // Audio continues flowing to OpenAI so its VAD can detect user interruptions.
    setMode('speaking', 'DataAlchemist is speaking...', $sub.textContent);

    var b64 = audioQueue.shift();
    var audio = new Audio('data:audio/mpeg;base64,' + b64);
    currentAudio = audio;
    audio.onended = function() { currentAudio = null; playNext(); };
    audio.onerror = function() { currentAudio = null; playNext(); };
    audio.play().catch(function(err) {
      console.warn('[Audio] Autoplay blocked:', err.message);
      setTimeout(function() { audio.play().catch(function() { currentAudio = null; playNext(); }); }, 300);
    });
  }

  // ── Audio Capture (getUserMedia → PCM16 24kHz via AudioWorklet) ──────────
  async function startAudioCapture() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 24000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

      // Fix 8: browsers suspend AudioContext until user gesture — resume explicitly
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      var source = audioContext.createMediaStreamSource(micStream);

      // Fix 4+9: AudioWorkletProcessor replaces deprecated ScriptProcessorNode.
      // Runs off the main thread → lower latency, no deprecation warnings.
      // Loaded via inline Blob URL so no separate file is needed.
      var workletSrc = [
        'class PCM16Processor extends AudioWorkletProcessor {',
        '  process(inputs) {',
        '    var ch = inputs[0] && inputs[0][0];',
        '    if (ch && ch.length) this.port.postMessage(ch.slice());',
        '    return true;',
        '  }',
        '}',
        "registerProcessor('pcm16-processor', PCM16Processor);"
      ].join('\n');
      var workletBlob = new Blob([workletSrc], { type: 'application/javascript' });
      var workletUrl  = URL.createObjectURL(workletBlob);
      await audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      var workletNode = new AudioWorkletNode(audioContext, 'pcm16-processor');
      workletNode.port.onmessage = function(e) {
        if (interviewDone || !ws || ws.readyState !== 1) return;
        var float32 = e.data;

        // Convert Float32 → Int16 (PCM16)
        var pcm16 = new Int16Array(float32.length);
        for (var i = 0; i < float32.length; i++) {
          var s = Math.max(-1, Math.min(1, float32[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Base64 encode and send
        var bytes = new Uint8Array(pcm16.buffer);
        var binary = '';
        for (var j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
        ws.send(JSON.stringify({ type: 'audio', data: btoa(binary) }));
      };

      // Fix 4: source → workletNode only. NOT connected to destination —
      // avoids playing captured mic audio back through the speakers.
      source.connect(workletNode);

      setMic('Microphone active', true);
      console.log('[Audio] Capture started (24kHz PCM16, AudioWorklet)');
      return true;

    } catch (err) {
      // Fallback: AudioWorklet not supported (older browsers) — use ScriptProcessorNode
      console.warn('[Audio] AudioWorklet failed, trying ScriptProcessorNode:', err.message);
      try {
        if (!micStream) {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 24000, echoCancellation: true,
                     noiseSuppression: true, autoGainControl: true },
            video: false,
          });
        }
        if (!audioContext) {
          audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        }
        if (audioContext.state === 'suspended') await audioContext.resume();

        var source2   = audioContext.createMediaStreamSource(micStream);
        var processor = audioContext.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = function(e) {
          if (interviewDone || !ws || ws.readyState !== 1) return;
          var inputData = e.inputBuffer.getChannelData(0);
          var pcm16 = new Int16Array(inputData.length);
          for (var i = 0; i < inputData.length; i++) {
            var s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          var bytes = new Uint8Array(pcm16.buffer);
          var binary = '';
          for (var j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
          ws.send(JSON.stringify({ type: 'audio', data: btoa(binary) }));
        };
        // Fix 4: deliberately NOT connecting to destination — no mic feedback loop
        source2.connect(processor);
        setMic('Microphone active', true);
        console.log('[Audio] Fallback ScriptProcessorNode active');
        return true;
      } catch (fallbackErr) {
        console.warn('[Audio] All capture methods failed:', fallbackErr.message);
        setMic('Microphone unavailable', false);
        return false;
      }
    }
  }

  // ── WebSocket Connection ───────────────────────────────
  function connectWS() {
    setMode('processing', 'Connecting...', 'Establishing real-time connection');
    
    ws = new WebSocket(CFG.wsUrl);

    ws.onopen = function() {
      console.log('[WS] Connected');
      // Fix 12: on reconnect send isReconnect=true so server replays history
      // without triggering a new greeting or AI response
      ws.send(JSON.stringify({
        type: 'init',
        sessionId:     CFG.sessionId,
        candidate:     CFG.candidate,
        role:          CFG.role,
        difficulty:    CFG.difficulty,
        interviewType: CFG.interviewType,
        resume:        CFG.resume,
        isReconnect:   sessionEstablished,
      }));
    };

    ws.onmessage = function(e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case 'ready':
          sessionEstablished = true;  // Fix 12: mark established for reconnect detection
          if (!startTime) startTime = Date.now();
          if (!timerInterval) timerInterval = setInterval(updateTimer, 1000);
          setMode('processing', 'Starting interview...', 'AI is preparing');
          startAudioCapture();
          break;

        case 'text':
          // Fix 6: AI response text goes to dedicated $aiText element, not $sub
          // $sub is reserved for candidate transcript only
          if (msg.phase) updatePhase(msg.phase);
          if (msg.text) {
            $aiText.textContent = msg.text;
            $aiText.classList.add('visible');
          }
          break;

        case 'audio':
          if (msg.phase) updatePhase(msg.phase);
          enqueueAudio(msg.data);
          break;

        case 'transcript':
          // Show what OpenAI heard from the candidate
          if (!msg.partial && msg.text) {
            $sub.textContent = msg.text;
            setMic(msg.text, true);
          } else if (msg.partial && msg.text) {
            $sub.textContent = msg.text + '...';
            setMic(msg.text + '...', true);
          }
          break;

        case 'text_delta':
          // Fix 7: stream AI text deltas into $aiText for live preview
          if (msg.delta) {
            if (!$aiText.classList.contains('visible')) {
              $aiText.textContent = '';  // clear stale text before streaming new response
              $aiText.classList.add('visible');
            }
            $aiText.textContent += msg.delta;
          }
          break;

        case 'phase':
          updatePhase(msg.phase);
          break;

        case 'speech_start':
          setMic('Speaking detected...', true);
          // Fix 6: clear AI text when candidate begins speaking — it's no longer current
          $aiText.textContent = '';
          $aiText.classList.remove('visible');
          // Barge-in: user started speaking while bot TTS is playing — stop immediately.
          // Do NOT send clear_audio here — OpenAI's VAD already has the user's speech
          // buffered and sending clear_audio would erase it.
          if (playing) {
            stopPlayback();
            setMode('listening', 'Listening...', CFG.candidate + ' - ' + CFG.role);
            console.log('[Barge-in] User interrupted — TTS stopped');
          }
          break;

        case 'speech_stop':
          setMic('Processing speech...', true);
          setMode('processing', 'Thinking...', '');
          break;

        case 'done_pending':
          // Bug 7 fix: defer overlay until TTS audio queue is empty
          pendingDone = true;
          pendingDoneReport = msg.report || null;
          // If nothing is playing right now, show immediately
          if (!playing && audioQueue.length === 0) {
            pendingDone = false;
            interviewDone = true;
            setTimeout(function() { $overlay.classList.add('show'); }, 800);
          }
          break;

        case 'done':
          // Legacy / direct done (e.g. from Recall.ai webhook path)
          interviewDone = true;
          setTimeout(function() { $overlay.classList.add('show'); }, 2000);
          break;

        case 'error':
          console.error('[WS] Server error:', msg.message);
          break;
      }
    };

    ws.onclose = function() {
      console.log('[WS] Disconnected');
      if (!interviewDone) {
        setTimeout(connectWS, 3000);
      }
    };

    ws.onerror = function(err) {
      console.error('[WS] Error:', err);
    };
  }

  // ── Init ───────────────────────────────────────────────
  window.addEventListener('load', function() {
    connectWS();
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
  console.error(`[ERROR] ${err.message}`);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// =============================================================================
// Start Server
// =============================================================================
server.listen(PORT, HOST, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Public URL   : ${PUBLIC_URL}`);
  console.log(`Meeting page : ${PUBLIC_URL}/meeting-page`);
  console.log(`  POST /api/create-google-meet  - create Google Meet space`);
  console.log(`  POST /api/create-teams-meeting- create Teams online meeting`);
  console.log(`  POST /api/schedule-bot        - schedule bot for existing meeting`);
  console.log(`  POST /api/batch-schedule      - schedule multiple interviews`);
  console.log(`  GET  /api/report/:id          - get interview report`);
  console.log(`  GET  /meeting-page            - interview UI`);
  console.log(`  GET  /health                  - health check\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
  } else {
    console.error(`Server error:`, err.message);
  }
  process.exit(1);
});

export { app, server };
