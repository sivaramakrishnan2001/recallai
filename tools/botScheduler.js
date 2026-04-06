// Bot Scheduler — Create & schedule Recall.ai bots for automated AI interviews
// Docs: https://docs.recall.ai/docs/creating-and-scheduling-bots

/**
 * Schedule an AI interview bot to auto-join a meeting.
 *
 * @param {Object} config
 * @param {string} config.candidate_name   - Candidate full name
 * @param {string} config.role             - Job role
 * @param {string} config.resume           - Resume text (plain text)
 * @param {string} config.meeting_url      - Zoom / Teams / Google Meet URL
 * @param {string|Date} config.meeting_time - ISO 8601 datetime (>10 min future for guaranteed join)
 * @param {string} config.interview_type   - "technical" | "behavioral" | "mixed"
 * @param {string} config.difficulty       - "easy" | "medium" | "hard"
 * @param {string} config.ngrok_url        - Public HTTPS URL of this server
 *
 * @returns {Promise<{success, bot_id, joined_at, meeting_url, candidate_name, role, interview_config}>}
 */
export async function scheduleInterviewBot(config) {
  // Validate and use RECALL_REGION
  const VALID_REGIONS = ["us-east-1", "eu-west-1", "ap-northeast-1", "ap-south-1"];
  let RECALL_REGION = process.env.RECALL_REGION || "us-east-1";
  
  if (!VALID_REGIONS.includes(RECALL_REGION)) {
    console.warn(`[BotScheduler] Invalid RECALL_REGION: "${RECALL_REGION}". Using default "us-east-1"`);
    RECALL_REGION = "us-east-1";
  }
  
  const RECALL_API    = `https://${RECALL_REGION}.recall.ai/api/v1`;

  const {
    candidate_name,
    role,
    resume,
    meeting_url,
    meeting_time,
    interview_type  = "mixed",
    difficulty      = "medium",
    language        = "en-US",
    ngrok_url,
  } = config;

  // --- Validate required fields ---
  if (!candidate_name) return { success: false, error: "candidate_name is required" };
  if (!role)           return { success: false, error: "role is required" };
  if (!meeting_url)    return { success: false, error: "meeting_url is required" };
  if (!meeting_time)   return { success: false, error: "meeting_time is required" };
  if (!ngrok_url)      return { success: false, error: "server_url (ngrok_url) is required" };

  // --- Parse and validate meeting time (before API key check) ---
  const joinTime = meeting_time instanceof Date
    ? meeting_time
    : new Date(meeting_time);

  if (isNaN(joinTime.getTime())) {
    return { success: false, error: "meeting_time is not a valid date" };
  }

  const minutesUntilJoin = (joinTime.getTime() - Date.now()) / 60000;
  if (minutesUntilJoin < 10) {
    return {
      success: false,
      error: `meeting_time must be at least 10 minutes in the future for guaranteed bot join (${minutesUntilJoin.toFixed(1)} min given)`,
    };
  }

  if (!process.env.RECALL_API_KEY) {
    return { success: false, error: "RECALL_API_KEY environment variable not set" };
  }

  // --- Dedup key: prevents duplicate bots on same meeting ---
  const dedupKey = `${joinTime.toISOString().substring(0, 16)}-${meeting_url}`;

  // --- Pre-computed session ID (predictable, known before bot creation) ---
  // Uses dedup key hash so the meeting page can connect to the right session.
  const { createHash } = await import("crypto");
  const sessionHash = createHash("md5").update(dedupKey).digest("hex").substring(0, 12);
  const preSessionId = `bot_${sessionHash}`;

  // --- Build meeting page URL (served by this server as bot's camera) ---
  const params = new URLSearchParams({
    server:    ngrok_url.replace(/^https?:\/\//, ""),
    role,
    candidate: candidate_name,
    difficulty,
    type:      interview_type,
    sessionId: preSessionId,
  });
  const meetingPageUrl = `${ngrok_url}/meeting-page?${params}`;

  // Map BCP-47 language tag (e.g. "hi-IN", "ja-JP") to Recall.ai language code (e.g. "hi", "ja")
  const recallLangCode = language.split("-")[0];

  // Truncate bot_name to Recall.ai's 100-character limit
  const rawBotName = `AI Interview: ${candidate_name}`;
  const botName    = rawBotName.length > 100 ? rawBotName.substring(0, 97) + "..." : rawBotName;

  // --- Build Recall.ai bot payload ---
  const payload = {
    bot_name:   botName,
    meeting_url,
    join_at:    joinTime.toISOString(),
    // NOTE: dedup_key is intentionally omitted — not a documented Recall.ai field.
    // dedupKey is used only for generating a stable preSessionId above.

    // Bot camera shows the interview UI page
    output_media: {
      camera: {
        kind:   "webpage",
        config: { url: meetingPageUrl },
      },
    },

    // Use high-quality web variant for all platforms
    variant: {
      microsoft_teams: "web_4_core"
      // zoom:            "web_4_core",
      // google_meet:     "web_4_core",
    },

    // Enable real-time streaming transcription (low latency)
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
            mode:          "prioritize_low_latency",
            language_code: recallLangCode,
          },
        },
      },
      // Real-time transcript delivery via webhook (CRITICAL: must be configured here)
      realtime_endpoints: [
        {
          type: "webhook",
          url: `${ngrok_url}/webhook/recall/transcript`,
          events: ["transcript.data", "transcript.partial_data"],
        },
      ],
    },

    // Store interview metadata on the bot for lookup later.
    // IMPORTANT: session_id and language are included so webhooks can recover
    // the correct session even after a server restart (botSessionMap is in-memory).
    metadata: {
      candidate_name,
      role,
      interview_type,
      difficulty,
      language,
      session_id: preSessionId,
      server_url: ngrok_url,
    },
  };

  // --- Create the bot ---
  try {
    const response = await fetch(`${RECALL_API}/bot/`, {
      method: "POST",
      headers: {
        Authorization:  `Token ${process.env.RECALL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[BotScheduler] Recall.ai ${response.status}:`, body.substring(0, 300));
      return { success: false, error: `Recall.ai API error ${response.status}: ${body.substring(0, 200)}` };
    }

    const bot = await response.json();
    const botId = bot.id;

    if (!botId) {
      return { success: false, error: "Bot created but no ID returned" };
    }

    console.log(`[BotScheduler] ✓ Bot: ${botId}`);
    console.log(`[BotScheduler] ✓ Joins: ${joinTime.toISOString()}`);
    console.log(`[BotScheduler] ✓ Meeting page: ${meetingPageUrl}`);

    return {
      success:          true,
      bot_id:           botId,
      session_id:       preSessionId,
      joined_at:        joinTime.toISOString(),
      meeting_url,
      candidate_name,
      role,
      resume,
      interview_config: { interview_type, difficulty },
    };
  } catch (err) {
    console.error("[BotScheduler] Error:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Schedule multiple interview bots (e.g. a full day of interviews).
 * Runs in parallel — returns array of results.
 */
export async function batchScheduleInterviews(interviews) {
  console.log(`[BotScheduler] Scheduling ${interviews.length} interviews…`);
  const results = await Promise.all(interviews.map(scheduleInterviewBot));
  const ok  = results.filter(r => r.success).length;
  const bad = results.filter(r => !r.success).length;
  console.log(`[BotScheduler] ${ok} scheduled, ${bad} failed`);
  return results;
}

/**
 * Calculate the bot join time: join `bufferMinutes` before the meeting starts.
 * Default 2 minutes early so the bot is ready when the host opens the meeting.
 *
 * @param {Date|string} meetingStartTime - Scheduled meeting start
 * @param {number}      bufferMinutes    - How many minutes before to join (default 2)
 * @returns {Date}
 */
export function calculateBotJoinTime(meetingStartTime, bufferMinutes = 2) {
  const start = meetingStartTime instanceof Date
    ? meetingStartTime
    : new Date(meetingStartTime);

  if (isNaN(start.getTime())) {
    throw new Error("meetingStartTime is not a valid date");
  }

  const joinTime = new Date(start.getTime() - bufferMinutes * 60 * 1000);

  if (joinTime.getTime() - Date.now() < 2 * 60 * 1000) {
    throw new Error("Calculated join time is too soon — must be at least 2 minutes in the future");
  }

  return joinTime;
}

/**
 * Parse resume text to extract key candidate info for interview personalization.
 */
export function parseResume(resumeText) {
  if (!resumeText) return {};

  const email   = resumeText.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phone   = resumeText.match(/\+?[\d\s()./-]{7,}/);
  const years   = resumeText.match(/(\d+)\+?\s*years?\s*(of\s+)?experience/i);

  const techs = [];
  const patterns = [
    /\b(React|Vue|Angular|Svelte|Next\.?js)\b/gi,
    /\b(Node\.?js|Python|Java|Go|Rust|TypeScript|JavaScript|C\+\+|C#)\b/gi,
    /\b(AWS|Azure|GCP|Kubernetes|Docker|Terraform)\b/gi,
    /\b(PostgreSQL|MySQL|MongoDB|Redis|Elasticsearch|DynamoDB)\b/gi,
    /\b(GraphQL|REST|gRPC|WebSocket)\b/gi,
  ];
  patterns.forEach(p => {
    const m = resumeText.match(p);
    if (m) techs.push(...m.map(t => t.toLowerCase()));
  });

  return {
    email:            email ? email[0] : null,
    phone:            phone ? phone[0].trim() : null,
    experience_years: years ? parseInt(years[1]) : null,
    technologies:     [...new Set(techs)],
  };
}

/**
 * Retrieve bot artifacts after interview completes.
 * Called when bot.done or bot.call_ended event fires.
 *
 * @param {string} botId - Recall.ai bot ID
 * @returns {Promise<{success, transcript_url, report_url, media_shortcuts, error}>}
 */
export async function retrieveBotArtifacts(botId) {
  const RECALL_REGION = process.env.RECALL_REGION || "us-east-1";
  const RECALL_API    = `https://${RECALL_REGION}.recall.ai/api/v1`;
  const RECALL_API_KEY = process.env.RECALL_API_KEY;

  if (!RECALL_API_KEY) {
    return { success: false, error: "RECALL_API_KEY not set" };
  }

  if (!botId) {
    return { success: false, error: "botId is required" };
  }

  try {
    console.log(`[Artifacts] Retrieving for bot ${botId}`);

    const response = await fetch(`${RECALL_API}/bots/${botId}`, {
      method: "GET",
      headers: {
        "Authorization": `Token ${RECALL_API_KEY}`,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Recall.ai API error: ${response.status} ${errorText}`,
      };
    }

    const data = await response.json();
    const bot = data.data || data; // Handle both response structures

    // Extract media shortcuts (transcript, report, summary)
    const transcriptUrl = bot.media_shortcuts?.transcript || null;
    const reportUrl     = bot.media_shortcuts?.report     || null;
    const summaryUrl    = bot.media_shortcuts?.summary    || null;

    console.log(`[Artifacts] Retrieved: transcript=${!!transcriptUrl}, report=${!!reportUrl}, summary=${!!summaryUrl}`);

    return {
      success: true,
      botId,
      transcript_url:  transcriptUrl,
      report_url:      reportUrl,
      summary_url:     summaryUrl,
      media_shortcuts: bot.media_shortcuts || {},
      status:          bot.status,
    };
  } catch (err) {
    console.error(`[Artifacts] Fetch error:`, err.message);
    return { success: false, error: err.message };
  }
}
