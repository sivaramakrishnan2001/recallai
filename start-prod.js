// =============================================================================
// Production Startup Manager
// Manages: Local server + ngrok tunnel + automatic bot creation
// =============================================================================

import { spawn, exec } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const execAsync = promisify(exec);
const log = {
  info:  (msg) => console.log(`\n✅ ${msg}`),
  warn:  (msg) => console.warn(`\n⚠️  ${msg}`),
  error: (msg) => console.error(`\n❌ ${msg}`),
  step:  (msg) => console.log(`\n━━━ ${msg} ━━━`),
};

const config = {
  PORT:                process.env.PORT || 3000,
  NGROK_AUTHTOKEN:     process.env.NGROK_AUTHTOKEN,
  RECALL_API_KEY:      process.env.RECALL_API_KEY,
  OPENAI_API_KEY:      process.env.OPENAI_API_KEY,
  ELEVENLABS_API_KEY:  process.env.ELEVENLABS_API_KEY,
  MEETING_URL:         process.env.TEAMS_MEETING_URL,
  BOT_ROLE:            process.env.BOT_ROLE || "Software Engineer",
};

// =============================================================================
// Step 1: Start local server
// =============================================================================
function startLocalServer() {
  return new Promise((resolve) => {
    log.step("Starting local server on port " + config.PORT);

    const server = spawn("node", ["recall-webhook.js"], {
      stdio: "inherit",
      cwd: __dirname,
    });

    server.on("error", (err) => {
      log.error("Server startup failed: " + err.message);
      process.exit(1);
    });

    // Give server time to start
    setTimeout(() => {
      log.info("Local server started");
      resolve(server);
    }, 3000);
  });
}

// =============================================================================
// Step 2: Check ngrok auth token
// =============================================================================
function checkNgrokAuth() {
  if (!config.NGROK_AUTHTOKEN) {
    log.error("NGROK_AUTHTOKEN not set in .env");
    log.error("Get one free at: https://dashboard.ngrok.com/get-started/your-authtoken");
    process.exit(1);
  }
  log.info("ngrok auth token found");
}

// =============================================================================
// Step 3: Start ngrok tunnel
// =============================================================================
function startNgrok() {
  return new Promise((resolve, reject) => {
    log.step("Starting ngrok tunnel");

    const ngrok = spawn("ngrok", [
      "http",
      config.PORT,
      "--authtoken=" + config.NGROK_AUTHTOKEN,
      "--log=stdout",
    ]);

    let ngrokUrl = null;
    let resolved = false;

    ngrok.stdout.on("data", (data) => {
      const output = data.toString();
      console.log(output);

      // Extract ngrok URL from output: "url=https://abc123.ngrok.io"
      const match = output.match(/url=(https:\/\/[a-z0-9\-]+\.ngrok\.io)/);
      if (match && !resolved) {
        ngrokUrl = match[1];
        resolved = true;
        log.info("ngrok tunnel active: " + ngrokUrl);
        resolve(ngrokUrl);
      }
    });

    ngrok.stderr.on("data", (data) => {
      console.error("ngrok error:", data.toString());
    });

    ngrok.on("error", (err) => {
      log.error("ngrok startup failed: " + err.message);
      reject(err);
    });

    // Timeout if ngrok doesn't connect in 30s
    setTimeout(() => {
      if (!resolved) {
        log.error("ngrok timeout — check that ngrok is installed and auth token is valid");
        reject(new Error("ngrok timeout"));
      }
    }, 30000);
  });
}

// =============================================================================
// Step 4: Health check — ensure server is ready
// =============================================================================
async function healthCheck(maxRetries = 10) {
  log.step("Checking if server is healthy");

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://localhost:${config.PORT}/health`);
      if (response.ok) {
        log.info("Server health check passed");
        return true;
      }
    } catch (err) {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  log.error("Server health check failed after " + maxRetries + " retries");
  process.exit(1);
}

// =============================================================================
// Step 5: Create Recall.ai bot (optional, if TEAMS_MEETING_URL is set)
// =============================================================================
async function createRecallBot(ngrokUrl) {
  if (!config.MEETING_URL || !config.RECALL_API_KEY) {
    log.warn("TEAMS_MEETING_URL or RECALL_API_KEY not set — skipping bot creation");
    log.warn("To auto-create bot, add to .env: TEAMS_MEETING_URL=https://teams.microsoft.com/meet/...");
    return null;
  }

  log.step("Creating Recall.ai bot for Teams meeting");

  const payload = {
    bot_name: "AI Interview Bot",
    meeting_url: config.MEETING_URL,
    output_media: {
      camera: {
        kind: "webpage",
        config: {
          url: `${ngrokUrl}/meeting-page?server=${ngrokUrl.replace("https://", "")}&role=${encodeURIComponent(config.BOT_ROLE)}`,
        },
      },
    },
    variant: {
      microsoft_teams: "web_4_core",
      zoom: "web_4_core",
      google_meet: "web_4_core",
    },
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
            mode: "prioritize_low_latency",
            language_code: "en",
          },
        },
      },
      audio: { enabled: true },
    },
  };

  try {
    const response = await fetch("https://ap-northeast-1.recall.ai/api/v1/bot/", {
      method: "POST",
      headers: {
        "Authorization": `Token ${config.RECALL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error(`Recall.ai API error ${response.status}: ${error.substring(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const botId = data.data?.bot?.id || data.bot_id;
    log.info(`Bot created successfully — ID: ${botId}`);
    return botId;
  } catch (err) {
    log.error("Failed to create Recall.ai bot: " + err.message);
    return null;
  }
}

// =============================================================================
// Main: Orchestrate startup
// =============================================================================
async function main() {
  try {
    console.log("\n╔════════════════════════════════════════════════════════╗");
    console.log("║       AI Interview Bot — Production Startup            ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");

    // Validation
    checkNgrokAuth();
    if (!config.OPENAI_API_KEY || !config.ELEVENLABS_API_KEY) {
      log.error("Missing required env vars: OPENAI_API_KEY, ELEVENLABS_API_KEY");
      process.exit(1);
    }

    // Start services
    await startLocalServer();
    await healthCheck();

    const ngrokUrl = await startNgrok();

    // Auto-create bot if meeting URL is provided
    const botId = await createRecallBot(ngrokUrl);

    // Final summary
    console.log("\n╔════════════════════════════════════════════════════════╗");
    console.log("║                   🎉 Ready to go!                     ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");

    console.log(`📡 Server          : http://localhost:${config.PORT}`);
    console.log(`🔗 Public URL      : ${ngrokUrl}`);
    console.log(`📋 Meeting page    : ${ngrokUrl}/meeting-page?role=${encodeURIComponent(config.BOT_ROLE)}`);
    if (botId) {
      console.log(`🤖 Bot created     : ${botId}`);
    }

    console.log("\n📚 API Endpoints:");
    console.log(`   POST ${ngrokUrl}/api/start      — Start interview (generate questions)`);
    console.log(`   POST ${ngrokUrl}/api/respond     — Answer evaluation`);
    console.log(`   GET  ${ngrokUrl}/health         — Health check\n`);

    console.log("⏸️  Press Ctrl+C to stop\n");

  } catch (err) {
    log.error("Startup failed: " + err.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  log.info("Shutting down...");
  process.exit(0);
});

main();
