import express from "express";
import { WebSocketServer } from "ws";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

// Simple logger (replace emoji spam with structured messages)
const log = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  debug: (msg) => {
    if (process.env.DEBUG) console.log(`[DEBUG] ${msg}`);
  }
};

const app = express();
const PORT = process.env.PORT || 3000;
const RECALL_API_KEY = process.env.RECALL_API_KEY;
const BEDROCK_API_KEY = process.env.BEDROCK_API_KEY;
const BEDROCK_API_KEY_NAME = process.env.BEDROCK_API_KEY_NAME;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

// Security middleware
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Verify configuration
if (!RECALL_API_KEY) {
  log.warn("RECALL_API_KEY not set - webhook verification disabled");
}

if (!BEDROCK_API_KEY || !BEDROCK_API_KEY_NAME) {
  log.error("AWS Bedrock credentials required");
  process.exit(1);
}

log.info("AWS Bedrock credentials configured");

// Verify all required configuration at startup
log.info("=== VERIFYING CONFIGURATION ===");
log.info(`✅ RECALL_API_KEY: ${RECALL_API_KEY ? "Configured" : "❌ MISSING"}`);
log.info(`✅ BEDROCK_API_KEY: ${BEDROCK_API_KEY ? "Configured" : "❌ MISSING"}`);
log.info(`✅ ELEVENLABS_API_KEY: ${process.env.ELEVENLABS_API_KEY ? "Configured" : "❌ MISSING"}`);
log.info(`✅ ELEVENLABS_VOICE_ID: ${process.env.ELEVENLABS_VOICE_ID || "❌ MISSING"}`);
log.info(`✅ N8N_WEBHOOK_URL: ${process.env.N8N_WEBHOOK_URL || "Not configured"}`);
log.info("================================");

// Initialize Bedrock client
const bedrockClient = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: BEDROCK_API_KEY_NAME || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: BEDROCK_API_KEY || process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Verify Bedrock is configured
if (!bedrockClient) {
  log.error("Failed to initialize Bedrock client - check AWS credentials");
}

// Store active interview sessions
const interviewSessions = new Map();

// Session cleanup: delete sessions older than 2 hours
setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours

  for (const [key, session] of interviewSessions.entries()) {
    if (now - session.start_time > maxAge) {
      interviewSessions.delete(key);
      console.log(`[Cleanup] Removed stale session: ${key}`);
    }
  }
}, 15 * 60 * 1000); // Run every 15 minutes

// Interview configuration
const INTERVIEW_CONFIG = {
  position: "Software Engineer",
  duration: 30, // minutes
  questions: [
    {
      id: 1,
      text: "Tell me about your experience with backend development.",
      category: "experience",
      timeLimit: 120,
    },
    {
      id: 2,
      text: "How would you design a scalable REST API?",
      category: "technical",
      timeLimit: 180,
    },
    {
      id: 3,
      text: "Describe a challenging project you worked on and how you overcame obstacles.",
      category: "problem_solving",
      timeLimit: 150,
    },
    {
      id: 4,
      text: "What are your strongest technical skills and why?",
      category: "strengths",
      timeLimit: 120,
    },
    {
      id: 5,
      text: "Where do you see yourself in 5 years?",
      category: "culture_fit",
      timeLimit: 90,
    },
  ],
};

// Define system prompt after INTERVIEW_CONFIG is created
INTERVIEW_CONFIG.systemPrompt = `You are a professional technical interviewer conducting an interview for a ${INTERVIEW_CONFIG.position} position.

Your responsibilities:
1. Ask questions in order from the provided list
2. Listen carefully to candidate responses
3. Ask follow-up questions to understand their depth of knowledge
4. Rate responses on: clarity (0-10), technical depth (0-10), communication (0-10)
5. Keep track of interview progress
6. After all questions, provide a summary score (0-100)

Format your response with:
- [METRIC] key:value pairs for tracking
- Natural conversational responses
- Follow-up questions when needed

Example: "[METRIC] clarity:8 depth:9 communication:7" followed by your question or comment.`;

// ============================================================================
// RECALL.AI WEBHOOK ENDPOINTS
// ============================================================================

/**
 * Verify webhook signature from Recall.ai
 */
function verifyWebhookSignature(body, signature) {
  if (!RECALL_API_KEY) return true; // Skip if not configured
  if (!signature) return false;

  const hash = crypto
    .createHmac("sha256", RECALL_API_KEY)
    .update(JSON.stringify(body))
    .digest("hex");

  return hash === signature;
}

/**
 * POST /webhook/recall/events
 * Receives events from Recall.ai bot
 */
app.post("/webhook/recall/events", async (req, res) => {
  try {
    // Verify webhook signature
    const signature = req.headers["x-recall-signature"];
    if (!verifyWebhookSignature(req.body, signature)) {
      console.warn("❌ Invalid webhook signature");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const event = req.body.event;
    // Actual Recall.ai payload: bot_id is at data.bot.id (NOT top-level)
    const bot_id = req.body.data?.bot?.id;
    const call_id = req.body.data?.recording?.id || req.body.data?.bot?.id;

    log.info(`📨 Webhook event: "${event}" | bot: ${bot_id}`);

    if (!bot_id) {
      log.warn(`Missing bot_id in webhook payload. Body: ${JSON.stringify(req.body).substring(0, 300)}`);
      return res.status(200).json({ status: "ok", note: "no bot_id" });
    }

    // Session key uses bot_id only (call_id is not always present in initial events)
    const sessionKey = bot_id;
    let session = interviewSessions.get(sessionKey);

    // Only require session to exist for non-initial events
    if (!session && event !== "bot.in_call_recording") {
      log.warn(`Session not found for bot: ${bot_id}, event: ${event}`);
      // Don't block — return ok to avoid Recall.ai retrying endlessly
      return res.status(200).json({ status: "ok", note: "session not found" });
    }

    // Handle different event types (matching Recall.ai actual events)
    switch (event) {
      // Bot lifecycle events
      case "bot.in_call_recording":
        if (!session) {
          log.info(`\n🎉 Bot in call and recording: ${sessionKey}`);

          // Create new interview session
          session = createInterviewSession(bot_id, call_id, data);
          interviewSessions.set(sessionKey, session);
          log.info(`✅ Session created`);
          log.info(`   Bot ID: ${bot_id}`);
          log.info(`   Call ID: ${call_id}`);
          log.info(`   Interview for position: ${session.position}`);

          // Initialize greeting and first question after a delay
          // This allows Recall.ai to stabilize the connection
          setTimeout(async () => {
            const greeting = `Hello! I'm your AI interview assistant. Today we'll be conducting a ${session.position} interview. Let's begin with our first question.`;

            log.info(`\n🎤 Greeting candidate...`);
            const greetingSuccess = await textToSpeech(greeting, bot_id, call_id);

            if (greetingSuccess) {
              log.info(`✅ Greeting sent successfully`);
            } else {
              log.error(`⚠️  Greeting failed - but continuing anyway`);
            }

            // Ask first question after greeting finishes
            setTimeout(async () => {
              const currentSession = interviewSessions.get(sessionKey);
              if (currentSession && currentSession.current_question < currentSession.questions.length) {
                const firstQuestion = currentSession.questions[0].text;
                log.info(`\n🎤 Asking first question...`);
                await textToSpeech(firstQuestion, bot_id, call_id);

                // Broadcast to meeting page
                broadcastToMeetingPage(currentSession);
              }
            }, 1500); // Wait for greeting to finish
          }, 1000); // Initial delay for connection stability
        }
        break;

      case "bot.call_ended":
        log.info(`✅ Bot call ended: ${sessionKey}`);
        if (session) {
          const results = finalizeInterview(session);
          log.info(`Interview completed. Final score: ${results.metrics.overall}/100`);
          await sendResultsToN8n(results);
        }
        interviewSessions.delete(sessionKey);
        break;

      // Participant speech events (monitoring only)
      case "participant_events.speech_on":
        log.debug(`🎤 Participant started speaking`);
        if (session) session.isListening = true;
        break;

      case "participant_events.speech_off":
        log.debug(`🤫 Participant stopped speaking`);
        if (session) session.isListening = false;
        break;

      // Real-time transcript — FINALIZED (primary processing trigger)
      case "transcript.data": {
        // Payload: req.body.data.data.words[]
        const tData = req.body.data?.data;
        const participant = tData?.participant;
        const words = tData?.words;

        if (session && words && words.length > 0) {
          // Skip bot's own speech (participant is host or named "AI Interview Bot")
          const participantName = participant?.name || "";
          if (participantName.toLowerCase().includes("interview bot") ||
              participantName.toLowerCase().includes("ai bot")) {
            log.debug(`Skipping bot's own transcript`);
            break;
          }

          const text = words.map(w => w.text).join(" ").trim();
          if (text.length > 2) {
            log.info(`📝 Transcript [${participantName || "Participant"}]: "${text.substring(0, 100)}"`);
            session.currentTranscript = text;
            session.lastActivity = Date.now();
            await processParticipantResponse(session, text);
          }
        }
        break;
      }

      // Partial transcript — update display only (don't process)
      case "transcript.partial_data": {
        const pData = req.body.data?.data;
        if (session && pData?.words?.length > 0) {
          const partialText = pData.words.map(w => w.text).join(" ");
          session.partialTranscript = partialText;
        }
        break;
      }

      default:
        log.debug(`Received event: ${event}`);
    }

    res.json({
      status: "ok",
      session_key: sessionKey,
      interview_progress: session
        ? {
            current_question: session.current_question + 1,
            total_questions: INTERVIEW_CONFIG.questions.length,
            metrics: session.metrics,
          }
        : null,
    });
  } catch (error) {
    log.error(`Webhook error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /webhook/recall/verify
 * Webhook verification endpoint
 */
app.get("/webhook/recall/verify", (req, res) => {
  res.json({
    status: "ok",
    service: "recall-ai-interviewer",
    version: "1.0",
  });
});

// ============================================================================
// MEETING PAGE ENDPOINT
// ============================================================================

/**
 * GET /meeting-page
 * Returns the webpage that streams into Zoom/Teams/Meet
 */
app.get("/meeting-page", (req, res) => {
  // Get server URL from query parameter or default to localhost
  const serverUrl = req.query.server || 'localhost:3000';
  const wsProtocol = req.query.server ? 'wss' : 'ws';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Interview Bot</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 800px;
      width: 100%;
      padding: 40px;
    }

    .header {
      text-align: center;
      margin-bottom: 40px;
    }

    .header h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
    }

    .header p {
      color: #666;
      font-size: 14px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      margin-bottom: 30px;
    }

    .metric {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 10px;
      text-align: center;
    }

    .metric label {
      display: block;
      color: #666;
      font-size: 12px;
      margin-bottom: 5px;
      text-transform: uppercase;
    }

    .metric value {
      display: block;
      font-size: 24px;
      font-weight: bold;
      color: #667eea;
    }

    .question-box {
      background: #f9f9f9;
      padding: 20px;
      border-radius: 10px;
      margin-bottom: 20px;
      border-left: 4px solid #667eea;
    }

    .question-box label {
      color: #999;
      font-size: 12px;
      text-transform: uppercase;
    }

    .question-box p {
      color: #333;
      font-size: 16px;
      margin-top: 8px;
    }

    .status {
      padding: 15px;
      border-radius: 8px;
      text-align: center;
      margin-bottom: 20px;
      font-weight: 500;
    }

    .status.listening {
      background: #e8f5e9;
      color: #2e7d32;
    }

    .status.thinking {
      background: #fff3e0;
      color: #e65100;
    }

    .status.speaking {
      background: #e3f2fd;
      color: #1565c0;
    }

    .progress {
      margin-top: 20px;
      text-align: center;
      color: #999;
      font-size: 14px;
    }

    .waveform {
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-around;
      margin: 20px 0;
    }

    .bar {
      width: 3px;
      height: 20px;
      background: #667eea;
      border-radius: 2px;
      animation: wave 0.6s ease-in-out infinite;
    }

    .bar:nth-child(1) { animation-delay: 0s; }
    .bar:nth-child(2) { animation-delay: 0.1s; }
    .bar:nth-child(3) { animation-delay: 0.2s; }
    .bar:nth-child(4) { animation-delay: 0.3s; }
    .bar:nth-child(5) { animation-delay: 0.4s; }

    @keyframes wave {
      0%, 100% { height: 20px; }
      50% { height: 40px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎤 AI Interview Bot</h1>
      <p>Technical Interview Assistant</p>
    </div>

    <div class="status listening">
      👂 Listening to candidate...
    </div>

    <div class="waveform">
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
    </div>

    <div class="metrics">
      <div class="metric">
        <label>Clarity</label>
        <value id="clarity">--</value>
      </div>
      <div class="metric">
        <label>Technical Depth</label>
        <value id="depth">--</value>
      </div>
      <div class="metric">
        <label>Communication</label>
        <value id="communication">--</value>
      </div>
    </div>

    <div class="question-box">
      <label>Current Question</label>
      <p id="current-question">Initializing interview...</p>
    </div>

    <div class="progress">
      <p id="progress">Connecting to interview bot...</p>
    </div>
  </div>

  <!-- Hidden audio element - Recall.ai captures this audio into the Teams meeting -->
  <audio id="bot-audio" autoplay playsinline></audio>

  <script>
    const serverUrl = '${serverUrl}';
    const wsProtocol = '${wsProtocol}';
    const statusEl = document.querySelector('.status');
    const audioEl = document.getElementById('bot-audio');

    // Audio queue to prevent overlapping playback
    const audioQueue = [];
    let isPlaying = false;

    function playNextAudio() {
      if (isPlaying || audioQueue.length === 0) return;
      isPlaying = true;

      const { base64, text } = audioQueue.shift();

      try {
        // Convert base64 MP3 → Blob → Object URL → play
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);

        audioEl.src = url;
        audioEl.onended = () => {
          URL.revokeObjectURL(url);
          isPlaying = false;
          statusEl.className = 'status listening';
          statusEl.textContent = '👂 Listening to candidate...';
          playNextAudio(); // Play next in queue
        };
        audioEl.onerror = (e) => {
          console.error('Audio play error', e);
          isPlaying = false;
          playNextAudio();
        };

        statusEl.className = 'status speaking';
        statusEl.textContent = '🗣️ AI is speaking...';
        audioEl.play().catch(e => {
          console.error('Play failed:', e);
          isPlaying = false;
          playNextAudio();
        });
      } catch (e) {
        console.error('Audio decode error:', e);
        isPlaying = false;
        playNextAudio();
      }
    }

    // WebSocket connection with auto-reconnect
    let ws;
    function connectWS() {
      ws = new WebSocket(wsProtocol + '://' + serverUrl + '/ws/interview');

      ws.onopen = () => {
        console.log('✅ Connected to interview bot server');
        document.getElementById('progress').textContent = 'Connected - waiting for interview to start...';
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // 🔊 Audio message — queue and play
          if (data.type === 'audio' && data.audio) {
            console.log('🔊 Audio received, queuing playback');
            audioQueue.push({ base64: data.audio, text: data.text || '' });
            playNextAudio();
            return;
          }

          // 📊 Metrics update
          if (data.metrics) {
            document.getElementById('clarity').textContent = data.metrics.clarity ?? '--';
            document.getElementById('depth').textContent = data.metrics.depth ?? '--';
            document.getElementById('communication').textContent = data.metrics.communication ?? '--';
          }

          // ❓ Question update
          if (data.question) {
            document.getElementById('current-question').textContent = data.question;
          }

          // 📈 Progress update
          if (data.progress) {
            document.getElementById('progress').textContent = data.progress;
          }

        } catch (e) {
          console.error('Message parse error:', e);
        }
      };

      ws.onerror = (e) => console.error('WebSocket error:', e);

      ws.onclose = () => {
        console.log('⚠️ WebSocket closed, reconnecting in 3s...');
        document.getElementById('progress').textContent = 'Reconnecting...';
        setTimeout(connectWS, 3000);
      };
    }

    // Start connection
    connectWS();
  </script>
</body>
</html>
  `;

  res.type("text/html").send(html);
});

// ============================================================================
// WEBSOCKET FOR MEETING PAGE UPDATES
// ============================================================================

const wss = new WebSocketServer({ noServer: true });

app.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws/interview") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  }
});

wss.on("connection", (ws) => {
  console.log("✅ Meeting page connected");

  ws.on("message", (data) => {
    const message = JSON.parse(data);
    // Handle messages from meeting page
  });

  ws.on("close", () => {
    console.log("❌ Meeting page disconnected");
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createInterviewSession(botId, callId, data) {
  return {
    bot_id: botId,
    call_id: callId,
    candidate_name: data.participant_name || "Candidate",
    position: INTERVIEW_CONFIG.position,
    start_time: Date.now(),
    current_question: 0,
    questions: INTERVIEW_CONFIG.questions,
    metrics: {
      clarity: 0,
      depth: 0,
      communication: 0,
      overall: 0,
    },
    responses: [],
    conversation_history: [],
    // Real-time state tracking
    isProcessing: false,
    isListening: false,
    lastActivity: Date.now(),
    lastAudioTime: Date.now(),
    lastProcessedResponse: null,
    response_count: 0,
  };
}

/**
 * Process participant response and generate interviewer follow-up
 * This is called when we receive a complete transcript.data event
 */
async function processParticipantResponse(session, candidateResponse) {
  try {
    // Prevent duplicate processing
    if (session.isProcessing || session.lastProcessedResponse === candidateResponse) {
      log.debug(`Skipping duplicate response processing`);
      return;
    }

    session.isProcessing = true;
    session.lastProcessedResponse = candidateResponse;

    const currentQuestion = session.questions[session.current_question];

    if (!currentQuestion) {
      log.info(`✅ All questions completed`);
      return;
    }

    log.info(`\n📋 Processing response to question ${session.current_question + 1}:`);
    log.info(`   Q: ${currentQuestion.text.substring(0, 60)}...`);
    log.info(`   A: ${candidateResponse.substring(0, 80)}...`);

    // Add candidate response to conversation history
    session.conversation_history.push({
      role: "user",
      content: candidateResponse,
      timestamp: Date.now(),
    });

    // Generate interviewer response and metrics using Bedrock
    log.info(`🧠 Sending to Bedrock for evaluation...`);
    const response = await generateInterviewerResponse(
      session,
      currentQuestion,
      candidateResponse
    );

    if (!response || !response.text) {
      log.error(`❌ No response from Bedrock`);
      session.isProcessing = false;
      return;
    }

    // Update metrics from Bedrock analysis
    updateMetrics(session, response);
    log.info(`📊 Metrics updated: Clarity=${session.metrics.clarity}, Depth=${session.metrics.depth}, Communication=${session.metrics.communication}`);

    // Add interviewer response to conversation history
    session.conversation_history.push({
      role: "assistant",
      content: response.text,
      timestamp: Date.now(),
    });

    // Broadcast metrics update to meeting page in real-time
    broadcastToMeetingPage(session);

    // Convert bot response to speech and play in meeting
    log.info(`🎵 Converting bot response to speech...`);
    const botSpeechResult = await textToSpeech(response.text, session.bot_id, session.call_id);

    if (!botSpeechResult) {
      log.error(`❌ Failed to convert bot response to speech`);
      session.isProcessing = false;
      return;
    }

    // Check if we should move to next question
    if (response.next_question && session.current_question < session.questions.length - 1) {
      session.current_question++;
      log.info(`✅ Moving to question ${session.current_question + 1}/${session.questions.length}`);

      // Ask next question after a brief delay to let audio finish
      setTimeout(async () => {
        const nextQuestion = session.questions[session.current_question];
        if (nextQuestion) {
          log.info(`\n🎤 Asking next question: ${nextQuestion.text.substring(0, 60)}...`);
          await textToSpeech(nextQuestion.text, session.bot_id, session.call_id);
        }
      }, 2000);
    } else if (session.current_question >= session.questions.length - 1) {
      log.info(`✅ All questions completed`);
    }

    session.isProcessing = false;

  } catch (error) {
    log.error(`❌ Error processing response: ${error.message}`);
    session.isProcessing = false;
  }
}

/**
 * Generate interviewer response using AWS Bedrock Claude 3 Sonnet
 * Evaluates candidate response and generates follow-up or next question
 */
async function generateInterviewerResponse(session, question, candidateResponse) {
  try {
    // Build conversation history for context
    const messages = session.conversation_history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Add current candidate response if not already there
    if (!messages.some(m => m.content === candidateResponse && m.role === "user")) {
      messages.push({
        role: "user",
        content: candidateResponse,
      });
    }

    const params = {
      modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-06-01",
        max_tokens: 500,
        system: INTERVIEW_CONFIG.systemPrompt,
        messages,
      }),
    };

    const command = new InvokeModelCommand(params);
    log.debug(`Invoking Bedrock model...`);
    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const text = responseBody.content?.[0]?.text || "";

    if (!text) {
      log.error(`❌ No response from Bedrock`);
      return {
        text: "I see. Thank you for that response. Next question:",
        metrics: { clarity: 5, depth: 5, communication: 5 },
        next_question: true,
      };
    }

    // Extract metrics from response (looking for [METRIC] format)
    const metricsMatch = text.match(
      /\[METRIC\]\s*clarity:(\d+)\s*depth:(\d+)\s*communication:(\d+)/i
    );

    const metrics = metricsMatch
      ? {
          clarity: Math.min(10, Math.max(0, parseInt(metricsMatch[1]))),
          depth: Math.min(10, Math.max(0, parseInt(metricsMatch[2]))),
          communication: Math.min(10, Math.max(0, parseInt(metricsMatch[3]))),
        }
      : { clarity: 5, depth: 5, communication: 5 }; // Default if not found

    // Determine if next question should be asked
    const nextQuestion =
      text.toLowerCase().includes("next question") ||
      text.toLowerCase().includes("moving on") ||
      text.toLowerCase().includes("thank you") ||
      session.current_question >= session.questions.length - 1;

    return {
      text,
      metrics,
      next_question: nextQuestion,
    };

  } catch (error) {
    log.error(`❌ Bedrock error: ${error.message}`);
    return {
      text: "Thank you for that response. Next question:",
      metrics: { clarity: 5, depth: 5, communication: 5 },
      next_question: true,
    };
  }
}

function updateMetrics(session, response) {
  // Update response count FIRST
  session.response_count = (session.response_count || 0) + 1;
  const count = session.response_count;

  const { clarity, depth, communication } = response.metrics;

  // Calculate running average properly: (old_avg * (n-1) + new_value) / n
  session.metrics.clarity = Math.round(
    (session.metrics.clarity * (count - 1) + clarity) / count
  );
  session.metrics.depth = Math.round(
    (session.metrics.depth * (count - 1) + depth) / count
  );
  session.metrics.communication = Math.round(
    (session.metrics.communication * (count - 1) + communication) / count
  );

  // Calculate overall score (0-100): avg of 0-10 scales × 10
  const avg = (session.metrics.clarity + session.metrics.depth + session.metrics.communication) / 3;
  session.metrics.overall = Math.round(avg * 10);
}

function finalizeInterview(session) {
  const duration = Math.round((Date.now() - session.start_time) / 1000 / 60);

  const results = {
    bot_id: session.bot_id,
    call_id: session.call_id,
    candidate_name: session.candidate_name,
    position: session.position,
    duration_minutes: duration,
    timestamp: new Date().toISOString(),
    metrics: session.metrics,
    questions_asked: session.current_question,
    total_questions: session.questions.length,
    transcript: session.conversation_history,
  };

  return results;
}

async function sendResultsToN8n(results, retries = 3) {
  const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL;

  if (!N8N_WEBHOOK) {
    console.warn("[n8n] Webhook URL not configured");
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(N8N_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(results),
        timeout: 10000,
      });

      if (response.ok) {
        console.log("[n8n] Results sent successfully");
        return true;
      }

      if (response.status >= 500 && attempt < retries) {
        console.warn(`[n8n] Server error (${response.status}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }

      console.error(`[n8n] Failed: ${response.status} ${response.statusText}`);
      return false;
    } catch (error) {
      if (attempt < retries) {
        console.warn(`[n8n] Connection error, retry ${attempt}/${retries}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } else {
        console.error(`[n8n] Failed after ${retries} attempts: ${error.message}`);
        return false;
      }
    }
  }

  return false;
}

/**
 * Convert text to speech using ElevenLabs API.
 * Audio is sent to the meeting page via WebSocket — the webpage plays it,
 * and Recall.ai captures the webpage's audio output into the meeting.
 *
 * NOTE: output_audio API endpoint CANNOT be used when output_media is active.
 * The webpage IS the audio source. See: https://docs.recall.ai/docs/output-audio-in-meetings
 */
async function textToSpeech(text, botId, callId) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

  if (!ELEVENLABS_API_KEY) {
    log.error("❌ ElevenLabs API key NOT configured");
    return false;
  }

  if (!botId) {
    log.error(`❌ Missing bot_id for TTS`);
    return false;
  }

  try {
    const textPreview = text.length > 60 ? text.substring(0, 60) + "..." : text;
    log.info(`🎵 TTS: "${textPreview}"`);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_monolingual_v1",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      log.error(`❌ ElevenLabs ${response.status}: ${err}`);
      return false;
    }

    const audioBuffer = await response.arrayBuffer();
    if (audioBuffer.byteLength === 0) {
      log.error(`❌ ElevenLabs returned empty audio`);
      return false;
    }

    log.info(`✅ TTS generated ${(audioBuffer.byteLength / 1024).toFixed(1)} KB`);

    // Send base64 audio to meeting page via WebSocket.
    // The webpage plays it with <audio> element — Recall.ai captures that audio into Teams.
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    const sent = sendAudioToMeetingPage(base64Audio, text);

    if (!sent) {
      log.warn(`⚠️  No meeting page connected to receive audio (WebSocket clients: ${wss.clients.size})`);
      // Still return true — audio was generated, page just not connected yet
    }

    return true;

  } catch (error) {
    log.error(`❌ TTS error: ${error.message}`);
    return false;
  }
}

/**
 * Send base64 MP3 audio to the meeting page via WebSocket.
 *
 * Architecture (output_media mode):
 *   Server → WebSocket → Meeting page (Recall.ai headless browser)
 *   Meeting page plays <audio> element
 *   Recall.ai captures webpage audio → streams into Teams meeting
 *
 * WHY NOT output_audio API:
 *   output_media (webpage) and output_audio API are mutually exclusive.
 *   When using output_media, the webpage IS the audio source.
 */
function sendAudioToMeetingPage(base64Audio, text) {
  if (!wss || !wss.clients) return false;

  const payload = JSON.stringify({
    type: "audio",
    audio: base64Audio,           // base64 MP3
    text: text || "",             // for display in UI
    timestamp: Date.now(),
  });

  let sentCount = 0;
  wss.clients.forEach((client) => {
    if (client && client.readyState === 1) {
      try {
        client.send(payload);
        sentCount++;
      } catch (e) {
        log.debug(`WS send failed: ${e.message}`);
      }
    }
  });

  if (sentCount > 0) {
    log.info(`📤 Audio sent to ${sentCount} meeting page(s) via WebSocket`);
  }

  return sentCount > 0;
}

/**
 * Broadcast interview updates to all connected meeting pages via WebSocket
 */
function broadcastToMeetingPage(session) {
  if (!wss || !wss.clients) {
    log.debug(`No WebSocket clients connected`);
    return;
  }

  const currentQuestion = session.questions[session.current_question];
  const messagePayload = {
    question: currentQuestion?.text || "All questions completed",
    metrics: session.metrics,
    progress: `Question ${Math.min(session.current_question + 1, session.questions.length)} of ${session.questions.length}`,
    timestamp: new Date().toISOString(),
  };

  let broadcastCount = 0;
  wss.clients.forEach((client) => {
    if (client && client.readyState === 1) { // WebSocket.OPEN = 1
      try {
        client.send(JSON.stringify(messagePayload));
        broadcastCount++;
      } catch (error) {
        log.debug(`Failed to send to WebSocket client: ${error.message}`);
      }
    }
  });

  if (broadcastCount > 0) {
    log.debug(`Broadcast to ${broadcastCount} meeting page(s)`);
  }
}

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  log.info(`\n🚀 AI Interview Bot Server Started\n`);
  log.info(`Server running on port: ${PORT}`);
  log.info(`Webhook endpoint: https://your-render-url/webhook/recall/events`);
  log.info(`Meeting page: https://your-render-url/meeting-page?server=your-render-url`);
  log.info(`\n✅ Ready to receive Recall.ai webhook events\n`);
  log.info(`TTS: ${process.env.ELEVENLABS_API_KEY ? "Enabled" : "Disabled"}`);
});
