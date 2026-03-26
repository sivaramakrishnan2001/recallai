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

    const { event, bot_id, call_id, transcript, audio, ...data } = req.body;

    log.debug(`Webhook event: ${event}`);

    // Get or create session
    const sessionKey = `${bot_id}-${call_id}`;
    let session = interviewSessions.get(sessionKey);

    if (!session && event !== "bot.started") {
      log.warn(`Session not found for ${sessionKey}`);
      return res.status(400).json({ error: "Session not found" });
    }

    // Handle different event types
    switch (event) {
      case "bot.started":
        session = createInterviewSession(bot_id, call_id, data);
        interviewSessions.set(sessionKey, session);
        log.info(`✅ Interview started: ${sessionKey}`);
        log.info(`Bot ID: ${bot_id}, Call ID: ${call_id}`);

        // Greet candidate and ask first question with voice
        setTimeout(async () => {
          const greeting = `Hello! I'm your AI interview assistant. Let's begin with our first question.`;
          log.info(`🎤 Speaking greeting...`);
          const greetingResult = await textToSpeech(greeting, bot_id, call_id);
          if (!greetingResult) {
            log.error("❌ Failed to generate greeting audio - check ElevenLabs API key");
          }

          setTimeout(async () => {
            const firstQuestion = session.questions[0].text;
            log.info(`🎤 Speaking first question: ${firstQuestion}`);
            const questionResult = await textToSpeech(firstQuestion, bot_id, call_id);
            if (!questionResult) {
              log.error("❌ Failed to generate question audio");
            }
          }, 2000);
        }, 1000);
        break;

      case "bot.ended":
        if (session) {
          const results = finalizeInterview(session);
          log.info(`Interview completed. Final score: ${results.metrics.overall}/100`);
          await sendResultsToN8n(results);
        }
        interviewSessions.delete(sessionKey);
        break;

      case "participant.audio":
        if (session && audio) {
          await processParticipantAudio(session, audio, transcript);
        }
        break;

      case "participant.transcript":
        if (session && transcript) {
          session.currentTranscript = transcript;
          session.lastActivity = Date.now();
        }
        break;

      default:
        log.debug(`Unknown event: ${event}`);
    }

    res.json({
      status: "ok",
      session_key: sessionKey,
      interview_progress: session
        ? {
            current_question: session.currentQuestion + 1,
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

  <script>
    // Connect to interview bot via WebSocket
    const serverUrl = '${serverUrl}';
    const wsProtocol = '${wsProtocol}';
    const ws = new WebSocket(wsProtocol + '://' + serverUrl + '/ws/interview');

    ws.onopen = () => {
      console.log('Connected to interview bot');
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Update metrics
      if (data.metrics) {
        document.getElementById('clarity').textContent = data.metrics.clarity || '--';
        document.getElementById('depth').textContent = data.metrics.depth || '--';
        document.getElementById('communication').textContent = data.metrics.communication || '--';
      }

      // Update question
      if (data.question) {
        document.getElementById('current-question').textContent = data.question;
      }

      // Update progress
      if (data.progress) {
        document.getElementById('progress').textContent = data.progress;
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
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
  };
}

async function processParticipantAudio(session, audioData, transcript) {
  try {
    const currentQuestion = session.questions[session.current_question];

    if (!currentQuestion) {
      console.log("✅ All questions completed");
      return;
    }

    // Add to conversation history
    session.conversation_history.push({
      role: "user",
      content: transcript,
      timestamp: Date.now(),
    });

    // Generate interviewer response and metrics using Bedrock
    const response = await generateInterviewerResponse(
      session,
      currentQuestion,
      transcript
    );

    // Update metrics
    updateMetrics(session, response);

    // Add response to conversation
    session.conversation_history.push({
      role: "assistant",
      content: response.text,
      timestamp: Date.now(),
    });

    // Log response
    log.info(`Bot response: ${response.text.substring(0, 100)}...`);

    // Convert bot response to speech and play in meeting
    await textToSpeech(response.text, session.bot_id, session.call_id);

    // Move to next question if needed
    if (response.next_question) {
      session.current_question++;
      log.info(`Moving to question ${session.current_question + 1}/${session.questions.length}`);

      // Ask next question after a brief delay
      setTimeout(async () => {
        if (session.current_question < session.questions.length) {
          const nextQuestion = session.questions[session.current_question];
          log.info(`Asking: ${nextQuestion.text}`);

          // Convert question to speech
          await textToSpeech(nextQuestion.text, session.bot_id, session.call_id);
        } else {
          log.info("All questions completed");
        }
      }, 2000);
    }

    // Broadcast update to meeting page
    broadcastToMeetingPage(session);
  } catch (error) {
    console.error("❌ Error processing audio:", error.message);
  }
}

async function generateInterviewerResponse(session, question, candidateResponse) {
  const messages = session.conversation_history.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

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
  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const text = responseBody.content?.[0]?.text || "";

  // Extract metrics from response
  const metricsMatch = text.match(
    /\[METRIC\]\s*clarity:(\d+)\s*depth:(\d+)\s*communication:(\d+)/
  );
  const metrics = metricsMatch
    ? {
        clarity: parseInt(metricsMatch[1]),
        depth: parseInt(metricsMatch[2]),
        communication: parseInt(metricsMatch[3]),
      }
    : { clarity: 0, depth: 0, communication: 0 };

  return {
    text,
    metrics,
    next_question:
      text.toLowerCase().includes("next question") ||
      text.toLowerCase().includes("thank you"),
  };
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
 * Convert text to speech using ElevenLabs API
 * Returns audio buffer that can be sent to meeting
 */
async function textToSpeech(text, botId, callId) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

  if (!ELEVENLABS_API_KEY) {
    log.error("❌ ElevenLabs API key NOT configured - TTS disabled. Add ELEVENLABS_API_KEY to Render environment variables");
    return null;
  }

  if (!ELEVENLABS_VOICE_ID) {
    log.error("❌ ElevenLabs Voice ID NOT configured - Add ELEVENLABS_VOICE_ID to Render environment variables");
    return null;
  }

  try {
    log.info(`🎵 Converting text to speech (${text.length} chars): "${text.substring(0, 50)}..."`);

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ ElevenLabs TTS failed with status ${response.status}: ${errorText}`);
      return null;
    }

    const audioBuffer = await response.arrayBuffer();
    log.info(`✅ TTS generated ${audioBuffer.byteLength} bytes`);

    // Send audio to Recall.ai to play in meeting
    const sendResult = await sendAudioToMeeting(botId, callId, audioBuffer);
    if (!sendResult) {
      log.error("❌ Failed to send audio to Recall.ai");
      return null;
    }

    log.info(`✅ Audio sent to meeting successfully`);
    return audioBuffer;
  } catch (error) {
    log.error(`❌ TTS error: ${error.message}`);
    return null;
  }
}

/**
 * Send audio to Recall.ai bot to play in meeting
 */
async function sendAudioToMeeting(botId, callId, audioBuffer) {
  const RECALL_API_KEY = process.env.RECALL_API_KEY;

  if (!RECALL_API_KEY) {
    log.error("❌ RECALL_API_KEY not configured - cannot send audio to meeting");
    return false;
  }

  if (!botId) {
    log.error("❌ Bot ID missing - cannot send audio");
    return false;
  }

  if (!audioBuffer || audioBuffer.byteLength === 0) {
    log.error("❌ Audio buffer is empty");
    return false;
  }

  try {
    // Convert buffer to base64 for API
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    log.info(`📤 Sending ${audioBuffer.byteLength} bytes to Recall.ai bot ${botId}`);

    const response = await fetch(
      `https://ap-northeast-1.recall.ai/api/v1/bot/${botId}/output_audio`,
      {
        method: "POST",
        headers: {
          "Authorization": `Token ${RECALL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_buffer_base64: base64Audio,
          encoding: "mp3",
          sample_rate: 44100,
        }),
      }
    );

    if (response.ok) {
      log.info(`✅ Audio sent to meeting successfully`);
      return true;
    } else {
      const errorText = await response.text();
      log.error(`❌ Recall.ai API error ${response.status}: ${errorText}`);
      return false;
    }
  } catch (error) {
    log.error(`❌ Error sending audio to meeting: ${error.message}`);
    return false;
  }
}

function broadcastToMeetingPage(session) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      // OPEN
      client.send(
        JSON.stringify({
          question: session.questions[session.current_question]?.text,
          metrics: session.metrics,
          progress: `Question ${session.current_question + 1} of ${session.questions.length}`,
        })
      );
    }
  });
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
