# DataAlchemist Interview AI Agent — API Documentation

> **Stack:** Node.js 18+ · Express · OpenAI Realtime API · ElevenLabs TTS · Recall.ai · WebSocket
> **Version:** 3.1.0

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Environment Variables](#2-environment-variables)
3. [GET /health](#3-get-health)
4. [POST /api/schedule-bot](#4-post-apischedule-bot)
5. [POST /api/batch-schedule](#5-post-apibatch-schedule)
6. [GET /api/report/:sessionId](#6-get-apireportsessionid)
7. [GET /meeting-page](#7-get-meeting-page)
8. [POST /webhook/recall/events](#8-post-webhookrecallevents)
9. [POST /webhook/recall/transcript](#9-post-webhookrecalltranscript)
10. [WebSocket /ws](#10-websocket-ws)
11. [Error Responses](#11-error-responses)
12. [Language Support](#12-language-support)
13. [Changelog](#13-changelog)

---

## 1. Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm
- A public HTTPS URL for webhooks (use [ngrok](https://ngrok.com) for local dev)

### Installation

```bash
# Clone and install
cd server
npm install

# Copy environment template
cp .env.example .env
# Fill in your API keys in .env
```

### Running the Server

```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start

# Production with NODE_ENV set
npm run start:prod
```

Server starts on **port 3000** by default (override with `PORT` in `.env`).

### Expose to the Internet (local dev)

```bash
# Install ngrok globally
npm install -g ngrok

# Expose port 3000
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL — this is your `server_url` for all API calls.

### Configure Recall.ai Webhooks

In your [Recall.ai dashboard](https://app.recall.ai), add two webhook URLs:

| Event                  | Webhook URL                                    |
| :--------------------- | :--------------------------------------------- |
| Bot lifecycle events   | `https://your-server/webhook/recall/events`    |
| Transcript data        | `https://your-server/webhook/recall/transcript`|

### Verify Server is Running

```bash
curl http://localhost:3000/health
```

---

## 2. Environment Variables

Copy `.env.example` to `.env` and fill in the values below.

| Variable              | Required | Description                                                                 |
| :-------------------- | :------- | :-------------------------------------------------------------------------- |
| `OPENAI_API_KEY`      | ✅ Yes   | OpenAI API key with Realtime API access (`sk-proj-...`)                     |
| `ELEVENLABS_API_KEY`  | ✅ Yes   | ElevenLabs API key for TTS (`sk_...`)                                       |
| `ELEVENLABS_VOICE_ID` | ✅ Yes   | ElevenLabs voice ID. Default: `21m00Tcm4TlvDq8ikWAM` (Rachel)              |
| `RECALL_API_KEY`          | ✅ Yes   | Recall.ai API key for meeting bot creation                                  |
| `RECALL_REGION`           | ✅ Yes   | Recall.ai region. E.g. `ap-northeast-1`, `us-east-1`                       |
| `PORT`                    | No       | HTTP port. Defaults to `3000`                                               |
| `OPENAI_REALTIME_MODEL`   | No       | OpenAI Realtime model ID. Defaults to `gpt-4o-realtime-preview`            |
| `ELEVENLABS_MODEL_ID`     | No       | ElevenLabs model. Defaults to `eleven_multilingual_v2`                     |
| `N8N_WEBHOOK_URL`         | No       | n8n webhook to receive completed interview reports (retries 3×)            |
| `NGROK_AUTHTOKEN`         | No       | ngrok auth token for auto-tunnel setup                                      |
| `COMPOSIO_API_KEY`        | No       | Composio key for Gmail / Calendar / Slack / Notion integrations             |
| `COMPOSIO_USER_ID`        | No       | Composio user ID                                                            |

**Example `.env`:**

```env
OPENAI_API_KEY=sk-proj-abc123...
ELEVENLABS_API_KEY=sk_xyz789...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
RECALL_API_KEY=your_recall_key_here
RECALL_REGION=ap-northeast-1
PORT=3000
N8N_WEBHOOK_URL=https://your-n8n.app/webhook/interview-complete
```

---

## 3. GET /health

Returns server status and active session counts.

```bash
curl http://localhost:3000/health
```

**Response — 200 OK**

```json
{
  "ok": true,
  "version": "3.0",
  "architecture": "openai-realtime",
  "sessions": 3,
  "activeConnections": 1
}
```

| Field                | Type    | Description                              |
| :------------------- | :------ | :--------------------------------------- |
| `ok`                 | Boolean | Always `true` when server is running     |
| `version`            | String  | Server version                           |
| `architecture`       | String  | AI pipeline in use                       |
| `sessions`           | Number  | Total active interview sessions in memory|
| `activeConnections`  | Number  | Open WebSocket connections right now     |

---

## 4. POST /api/schedule-bot

Schedules a Recall.ai bot to join a meeting and conduct a full voice interview.

**URL:** `POST /api/schedule-bot`
**Content-Type:** `application/json`

### Request Body

| Field            | Type   | Required | Default    | Description                                                              |
| :--------------- | :----- | :------- | :--------- | :----------------------------------------------------------------------- |
| `candidate_name` | String | ✅ Yes   | —          | Full name of the candidate                                               |
| `role`           | String | ✅ Yes   | —          | Job role being interviewed for                                           |
| `meeting_url`    | String | ✅ Yes   | —          | Full Google Meet, Zoom, or Teams URL                                     |
| `meeting_time`   | String | ✅ Yes   | —          | ISO 8601 scheduled join time (UTC)                                       |
| `server_url`     | String | No       | `PUBLIC_URL` | Public HTTPS URL of this server. Required when running locally with ngrok|
| `resume`         | String | No       | `null`     | Full resume text for AI to reference during interview                    |
| `difficulty`     | String | No       | `"medium"` | `"easy"` · `"medium"` · `"hard"`                                        |
| `interview_type` | String | No       | `"mixed"`  | `"mixed"` · `"technical"` · `"behavioral"`                              |
| `language`       | String | No       | `"en-US"`  | BCP-47 language code (see [Language Support](#12-language-support))      |

### Example Request

```bash
curl -X POST http://localhost:3000/api/schedule-bot \
  -H "Content-Type: application/json" \
  -d '{
    "candidate_name": "Priya Sharma",
    "role": "Senior Backend Engineer",
    "meeting_url": "https://meet.google.com/abc-defg-hij",
    "meeting_time": "2025-06-20T10:00:00Z",
    "server_url": "https://a1b2c3d4.ngrok-free.app",
    "resume": "5 years of experience in Node.js, Python, and distributed systems. Led backend team at Startup X scaling to 2M users. Strong in AWS, Kafka, PostgreSQL.",
    "difficulty": "hard",
    "interview_type": "technical",
    "language": "en-US"
  }'
```

### Response — 200 OK

```json
{
  "success": true,
  "bot_id": "7f3a1c2d-89ab-4ef0-b123-456789abcdef",
  "session_id": "bot_1750420800000",
  "joined_at": "2025-06-20T10:00:00.000Z",
  "meeting_url": "https://meet.google.com/abc-defg-hij",
  "message": "Bot scheduled to join at 6/20/2025, 10:00:00 AM"
}
```

| Field        | Description                                              |
| :----------- | :------------------------------------------------------- |
| `bot_id`     | Recall.ai bot ID — use this to track the bot             |
| `session_id` | Internal session ID — use this to fetch the report later |
| `joined_at`  | ISO timestamp when the bot will join                     |
| `message`    | Human-readable confirmation                              |

### Response — 400 Bad Request

```json
{
  "error": "Required: candidate_name, role, meeting_url, meeting_time"
}
```

---

## 5. POST /api/batch-schedule

Schedule multiple interviews in a single API call.

**URL:** `POST /api/batch-schedule`
**Content-Type:** `application/json`

### Request Body

| Field        | Type   | Required | Description                                                                |
| :----------- | :----- | :------- | :------------------------------------------------------------------------- |
| `interviews` | Array  | ✅ Yes   | Array of interview objects. Each uses the same fields as `/api/schedule-bot` |
| `server_url` | String | No       | Shared public server URL applied to all interviews in this batch           |

### Example Request

```bash
curl -X POST http://localhost:3000/api/batch-schedule \
  -H "Content-Type: application/json" \
  -d '{
    "server_url": "https://a1b2c3d4.ngrok-free.app",
    "interviews": [
      {
        "candidate_name": "John Smith",
        "role": "Product Manager",
        "meeting_url": "https://meet.google.com/aaa-bbb-ccc",
        "meeting_time": "2025-06-21T09:00:00Z",
        "difficulty": "medium",
        "interview_type": "behavioral"
      },
      {
        "candidate_name": "Kenji Tanaka",
        "role": "Data Scientist",
        "meeting_url": "https://meet.google.com/ddd-eee-fff",
        "meeting_time": "2025-06-21T11:00:00Z",
        "difficulty": "hard",
        "interview_type": "technical",
        "language": "ja-JP",
        "resume": "PhD in ML from Tokyo University. 4 years at Rakuten building recommendation systems."
      },
      {
        "candidate_name": "Amara Nwosu",
        "role": "DevOps Engineer",
        "meeting_url": "https://zoom.us/j/123456789",
        "meeting_time": "2025-06-21T14:00:00Z",
        "difficulty": "medium",
        "interview_type": "mixed"
      }
    ]
  }'
```

### Response — 200 OK

```json
{
  "summary": {
    "total": 3,
    "scheduled": 3,
    "failed": 0
  },
  "scheduled": [
    {
      "success": true,
      "bot_id": "bot-uuid-001",
      "session_id": "bot_1750503600000",
      "candidate_name": "John Smith",
      "role": "Product Manager",
      "joined_at": "2025-06-21T09:00:00.000Z"
    },
    {
      "success": true,
      "bot_id": "bot-uuid-002",
      "session_id": "bot_1750510800000",
      "candidate_name": "Kenji Tanaka",
      "role": "Data Scientist",
      "joined_at": "2025-06-21T11:00:00.000Z"
    },
    {
      "success": true,
      "bot_id": "bot-uuid-003",
      "session_id": "bot_1750521600000",
      "candidate_name": "Amara Nwosu",
      "role": "DevOps Engineer",
      "joined_at": "2025-06-21T14:00:00.000Z"
    }
  ],
  "errors": []
}
```

### Response — Partial Failure

```json
{
  "summary": {
    "total": 2,
    "scheduled": 1,
    "failed": 1
  },
  "scheduled": [
    {
      "success": true,
      "bot_id": "bot-uuid-001",
      "session_id": "bot_1750503600000",
      "candidate_name": "John Smith"
    }
  ],
  "errors": [
    {
      "success": false,
      "candidate_name": "Kenji Tanaka",
      "error": "Invalid meeting URL format"
    }
  ]
}
```

---

## 6. GET /api/report/:sessionId

Retrieves the evaluation report for a completed interview session.

**URL:** `GET /api/report/:sessionId`

```bash
curl http://localhost:3000/api/report/bot_1750420800000
```

### Response — 200 OK

```json
{
  "session_id": "bot_1750420800000",
  "candidate": "Priya Sharma",
  "role": "Senior Backend Engineer",
  "interview_type": "technical",
  "difficulty": "hard",
  "language": "en-US",
  "duration_minutes": 28,
  "completed_at": "2025-06-20T10:28:43.000Z",
  "overall_score": 84,
  "scores": {
    "communication": 8.5,
    "technical_knowledge": 9.0,
    "problem_solving": 8.0,
    "practical_experience": 8.5
  },
  "phases_completed": ["introduction", "resume", "technical", "behavioral", "closing"],
  "questions_asked": [
    "Walk me through your background.",
    "Tell me about the scaling work you led at Startup X.",
    "How would you design a distributed rate limiter for a high-traffic API?",
    "What tradeoffs did you consider when choosing Kafka over RabbitMQ?",
    "Describe a time a production incident went badly. How did you handle it?"
  ],
  "summary": "Strong candidate with deep backend experience. Demonstrated expert-level knowledge of distributed systems and Kafka. Excellent problem-solving approach. Recommend for next round.",
  "transcript_url": "https://api.recall.ai/v1/bots/7f3a1c2d/transcript",
  "report_url": "https://api.recall.ai/v1/bots/7f3a1c2d/report"
}
```

### Response — 404 Not Found

```json
{
  "error": "Session not found"
}
```

---

## 7. GET /meeting-page

The interview UI served to the Recall.ai bot's virtual camera. The bot loads this page, which connects via WebSocket to stream microphone audio to OpenAI Realtime API and plays back TTS audio responses.

> **Note:** You do not call this directly — Recall.ai loads it automatically when the bot joins the meeting. The URL is built from your `server_url` when you call `/api/schedule-bot`.

**URL:** `GET /meeting-page`

### Query Parameters

| Parameter   | Description                               | Example                         |
| :---------- | :---------------------------------------- | :------------------------------ |
| `sessionId` | Interview session ID                      | `bot_1750420800000`             |
| `candidate` | Candidate display name                    | `Priya Sharma`                  |
| `role`      | Job role (display only)                   | `Senior Backend Engineer`       |
| `difficulty`| Interview difficulty                      | `hard`                          |
| `type`      | Interview type                            | `technical`                     |
| `server`    | Server host for WebSocket connection      | `a1b2c3d4.ngrok-free.app`       |

### Example URL

```
https://a1b2c3d4.ngrok-free.app/meeting-page?sessionId=bot_1750420800000&candidate=Priya+Sharma&role=Senior+Backend+Engineer&difficulty=hard&type=technical
```

---

## 8. POST /webhook/recall/events

Recall.ai lifecycle webhook. Configure this URL in your Recall.ai dashboard under **Bot Webhooks → Webhook URL**.

**URL:** `POST /webhook/recall/events`
**Dashboard setting:** `https://your-server/webhook/recall/events`

---

### All Recall.ai Webhook Events

Below is the complete list of events Recall.ai can send. Subscribe to the ones you need in the dashboard.

#### 🤖 Bot Events

| Event                              | Description                                                         | Handled |
| :--------------------------------- | :------------------------------------------------------------------ | :-----: |
| `bot.joining_call`                 | Bot is in the process of joining the meeting                        | —       |
| `bot.in_waiting_room`              | Bot is in the waiting room, not yet admitted                        | —       |
| `bot.in_call_not_recording`        | Bot joined but recording has not started                            | —       |
| `bot.in_call_recording`            | Bot is in the call and actively recording — **session auto-created**| ✅      |
| `bot.recording_permission_allowed` | Host granted recording permission to the bot                        | —       |
| `bot.recording_permission_denied`  | Host denied recording permission                                    | —       |
| `bot.call_ended`                   | Call ended — triggers report generation and n8n webhook             | ✅      |
| `bot.done`                         | Bot fully finished all post-call processing                         | ✅      |
| `bot.fatal`                        | Bot encountered a fatal error and terminated                        | —       |
| `bot.breakout_room_entered`        | Bot entered a breakout room                                         | —       |
| `bot.breakout_room_left`           | Bot left a breakout room                                            | —       |
| `bot.breakout_room_opened`         | A breakout room was opened in the meeting                           | —       |
| `bot.breakout_room_closed`         | A breakout room was closed in the meeting                           | —       |

#### 🎙️ Audio Events

| Event                    | Description                                        |
| :----------------------- | :------------------------------------------------- |
| `audio_mixed.processing` | Mixed audio artifact is being processed            |
| `audio_mixed.done`       | Mixed audio artifact is ready                      |
| `audio_mixed.failed`     | Mixed audio processing failed                      |
| `audio_mixed.deleted`    | Mixed audio artifact was deleted                   |
| `audio_separate.processing` | Per-participant audio is being processed        |
| `audio_separate.done`    | Per-participant audio is ready                     |
| `audio_separate.failed`  | Per-participant audio processing failed            |
| `audio_separate.deleted` | Per-participant audio artifact was deleted         |

#### 🎥 Recording Events

| Event                  | Description                                          |
| :--------------------- | :--------------------------------------------------- |
| `recording.processing` | Recording is being processed                         |
| `recording.done`       | Recording is ready for download                      |
| `recording.failed`     | Recording processing failed                          |
| `recording.paused`     | Recording was paused                                 |
| `recording.deleted`    | Recording was deleted                                |

#### 🎞️ Video Events

| Event                     | Description                                       |
| :------------------------ | :------------------------------------------------ |
| `video_mixed.processing`  | Mixed video artifact is being processed           |
| `video_mixed.done`        | Mixed video artifact is ready                     |
| `video_mixed.failed`      | Mixed video processing failed                     |
| `video_mixed.deleted`     | Mixed video artifact was deleted                  |
| `video_separate.processing` | Per-participant video is being processed        |
| `video_separate.done`     | Per-participant video is ready                    |
| `video_separate.failed`   | Per-participant video processing failed           |
| `video_separate.deleted`  | Per-participant video artifact was deleted        |

#### 📝 Transcript Events

| Event                    | Description                                        | Handled |
| :----------------------- | :------------------------------------------------- | :-----: |
| `transcript.processing`  | Transcript is being generated                      | —       |
| `transcript.done`        | Transcript is ready                                | —       |
| `transcript.failed`      | Transcript generation failed                       | —       |
| `transcript.deleted`     | Transcript was deleted                             | —       |

#### 🧠 Meeting Metadata Events

| Event                         | Description                                   |
| :---------------------------- | :-------------------------------------------- |
| `meeting_metadata.processing` | Meeting metadata is being extracted           |
| `meeting_metadata.done`       | Meeting metadata extraction complete          |
| `meeting_metadata.failed`     | Meeting metadata extraction failed            |
| `meeting_metadata.deleted`    | Meeting metadata was deleted                  |

#### 👥 Participant Events

| Event                          | Description                                  |
| :----------------------------- | :------------------------------------------- |
| `participant_events.processing`| Participant event data is being processed    |
| `participant_events.done`      | Participant event data is ready              |
| `participant_events.failed`    | Participant event processing failed          |
| `participant_events.deleted`   | Participant event data was deleted           |

#### ⚡ Realtime Endpoint Events

| Event                       | Description                                     |
| :-------------------------- | :---------------------------------------------- |
| `realtime_endpoint.running` | Realtime endpoint is active and receiving data  |
| `realtime_endpoint.done`    | Realtime endpoint session completed             |
| `realtime_endpoint.failed`  | Realtime endpoint encountered an error          |

#### ☁️ SDK Upload Events

| Event                    | Description                                        |
| :----------------------- | :------------------------------------------------- |
| `sdk_upload.uploading`   | SDK artifact upload in progress                    |
| `sdk_upload.complete`    | SDK artifact upload completed                      |
| `sdk_upload.completed`   | Alias for `sdk_upload.complete`                    |
| `sdk_upload.failed`      | SDK artifact upload failed                         |

#### 📅 Calendar Events

| Event                  | Description                                          |
| :--------------------- | :--------------------------------------------------- |
| `calendar.sync_events` | Calendar events synced to Recall.ai                  |
| `calendar.update`      | Calendar entry was updated                           |

#### 💬 Slack Events

| Event                      | Description                                      |
| :------------------------- | :------------------------------------------------ |
| `slack.huddle_state`       | Slack huddle state changed                        |
| `slack_team.active`        | Slack workspace integration is active             |
| `slack_team.invited`       | Bot was invited to a Slack workspace              |
| `slack_team.access_revoked`| Slack workspace access was revoked                |

---

### Events This Server Handles

| Event                  | Action                                                                       |
| :--------------------- | :--------------------------------------------------------------------------- |
| `bot.in_call_recording`| Auto-creates interview session from bot metadata if not already present      |
| `bot.call_ended`       | Finalises session · fetches Recall.ai artifacts · sends report to n8n        |
| `bot.done`             | Same as `bot.call_ended` — whichever fires first triggers finalisation       |

---

### Example Payload — `bot.joining_call`

```json
{
  "event": "bot.joining_call",
  "data": {
    "bot": {
      "id": "7f3a1c2d-89ab-4ef0-b123-456789abcdef",
      "metadata": {
        "candidate_name": "Priya Sharma",
        "role": "Senior Backend Engineer",
        "session_id": "bot_1750420800000"
      }
    }
  }
}
```

### Example Payload — `bot.in_call_recording`

```json
{
  "event": "bot.in_call_recording",
  "data": {
    "bot": {
      "id": "7f3a1c2d-89ab-4ef0-b123-456789abcdef",
      "metadata": {
        "candidate_name": "Priya Sharma",
        "role": "Senior Backend Engineer",
        "interview_type": "technical",
        "difficulty": "hard",
        "session_id": "bot_1750420800000"
      }
    }
  }
}
```

### Example Payload — `bot.call_ended`

```json
{
  "event": "bot.call_ended",
  "data": {
    "bot": {
      "id": "7f3a1c2d-89ab-4ef0-b123-456789abcdef",
      "metadata": {
        "candidate_name": "Priya Sharma",
        "role": "Senior Backend Engineer",
        "session_id": "bot_1750420800000"
      }
    }
  }
}
```

### Example Payload — `recording.done`

```json
{
  "event": "recording.done",
  "data": {
    "bot": {
      "id": "7f3a1c2d-89ab-4ef0-b123-456789abcdef"
    },
    "recording": {
      "id": "rec_abc123",
      "download_url": "https://api.recall.ai/v1/recordings/rec_abc123/download",
      "expires_at": "2025-06-27T10:00:00.000Z"
    }
  }
}
```

### Example Payload — `transcript.done`

```json
{
  "event": "transcript.done",
  "data": {
    "bot": {
      "id": "7f3a1c2d-89ab-4ef0-b123-456789abcdef"
    },
    "transcript": {
      "id": "trs_xyz789",
      "download_url": "https://api.recall.ai/v1/transcripts/trs_xyz789/download"
    }
  }
}
```

### Example Payload — `realtime_endpoint.running`

```json
{
  "event": "realtime_endpoint.running",
  "data": {
    "bot": {
      "id": "7f3a1c2d-89ab-4ef0-b123-456789abcdef"
    },
    "realtime_endpoint": {
      "id": "rte_def456",
      "url": "wss://your-server/ws?session=bot_1750420800000"
    }
  }
}
```

### Response — 200 OK

```json
{ "ok": true }
```

> Always respond with `200 { ok: true }` immediately — Recall.ai will retry if it does not receive a timely response. Heavy processing should be done asynchronously (`setImmediate` / worker).

---

## 9. POST /webhook/recall/transcript

Fallback transcript webhook from Recall.ai. Used when the meeting page's direct microphone capture fails — Recall.ai's own transcription is forwarded into the active OpenAI Realtime session instead.

**URL:** `POST /webhook/recall/transcript`
**Dashboard setting:** `https://your-server/webhook/recall/transcript`

### Events Handled

| Event                     | Action                                               |
| :------------------------ | :--------------------------------------------------- |
| `transcript.data`         | Finalised segment forwarded to OpenAI Realtime API   |
| `transcript.partial_data` | Ignored — only finalised transcripts are processed   |

### Example Payload

```json
{
  "event": "transcript.data",
  "data": {
    "bot": {
      "id": "7f3a1c2d-89ab-4ef0-b123-456789abcdef"
    },
    "data": {
      "participant": {
        "name": "Priya Sharma"
      },
      "words": [
        { "text": "I", "start_time": 1.2, "end_time": 1.4 },
        { "text": "used", "start_time": 1.5, "end_time": 1.7 },
        { "text": "Kafka", "start_time": 1.8, "end_time": 2.1 },
        { "text": "for", "start_time": 2.2, "end_time": 2.3 },
        { "text": "event", "start_time": 2.4, "end_time": 2.6 },
        { "text": "streaming", "start_time": 2.7, "end_time": 3.1 }
      ]
    }
  }
}
```

### Response — 200 OK

```json
{ "ok": true }
```

---

## 10. WebSocket /ws

Real-time bidirectional audio bridge between the meeting page and OpenAI Realtime API.

**URL:** `ws://localhost:3000/ws` (or `wss://` over HTTPS)

### Connection Flow

```
Meeting Page ──[WebSocket]──► Server ──[WebSocket]──► OpenAI Realtime API
                                  └──[HTTP]──► ElevenLabs TTS
```

1. Meeting page connects to `/ws`
2. Sends `init` message with session metadata
3. Server responds with `ready` — page starts audio capture
4. Page streams raw PCM16 24kHz audio chunks as `audio` messages
5. Server forwards audio to OpenAI Realtime API
6. OpenAI responds with text → server sends to ElevenLabs → MP3 audio sent back to page
7. Page plays audio; cycle repeats until `done`

---

### Client → Server Messages

#### `init` — Initialise Session

Sent immediately after WebSocket connection opens.

```json
{
  "type": "init",
  "sessionId": "bot_1750420800000",
  "candidate": "Priya Sharma",
  "role": "Senior Backend Engineer",
  "difficulty": "hard",
  "interviewType": "technical"
}
```

---

#### `audio` — Microphone Audio Chunk

Sent continuously during listening state. Raw PCM16 at 24kHz, base64-encoded.

```json
{
  "type": "audio",
  "data": "//NExAALiAIIAUAAAP///wAA..."
}
```

---

#### `text` — Text Fallback

Used when microphone is unavailable.

```json
{
  "type": "text",
  "text": "I used Kafka for event streaming in my last role."
}
```

---

#### `clear_audio` — Playback Finished

Sent by the page when TTS audio playback ends — signals server to resume accepting audio input.

```json
{
  "type": "clear_audio"
}
```

---

### Server → Client Messages

#### `ready` — Session Initialised

```json
{
  "type": "ready"
}
```

Page starts audio capture on receiving this.

---

#### `audio` — TTS Audio Chunk

```json
{
  "type": "audio",
  "data": "//NExAALiAIIAUAAAP///wAA...",
  "phase": "technical",
  "text": "That's interesting. How does your rate limiter handle burst traffic?"
}
```

| Field   | Description                                           |
| :------ | :---------------------------------------------------- |
| `data`  | Base64-encoded MP3 audio to play                      |
| `phase` | Current interview phase                               |
| `text`  | AI's spoken text (for display / subtitle)             |

---

#### `transcript` — Candidate Speech Recognised

```json
{
  "type": "transcript",
  "text": "I used Kafka for event streaming",
  "partial": false
}
```

| `partial: false` | Finalised transcript — displayed in UI |
| `partial: true`  | Live partial — shown as preview        |

---

#### `phase` — Interview Phase Changed

```json
{
  "type": "phase",
  "phase": "technical"
}
```

Phases: `introduction` · `resume` · `technical` · `behavioral` · `closing` · `done`

---

#### `speech_start` — Candidate Started Speaking

```json
{ "type": "speech_start" }
```

---

#### `speech_stop` — Candidate Stopped Speaking

```json
{ "type": "speech_stop" }
```

---

#### `done` — Interview Complete

```json
{ "type": "done" }
```

Page shows the completion overlay. WebSocket closes after this.

---

#### `error` — Server Error

```json
{
  "type": "error",
  "message": "OpenAI Realtime connection failed"
}
```

---

## 11. Error Responses

All REST endpoints return errors in this format:

```json
{
  "error": "Human-readable error message"
}
```

| HTTP Status | Meaning                                           |
| :---------- | :------------------------------------------------ |
| `400`       | Bad request — missing or invalid fields           |
| `404`       | Session or resource not found                     |
| `500`       | Internal server error — check server logs         |

---

## 12. Language Support

Pass the code as the `language` field in `/api/schedule-bot` or `/api/batch-schedule`.
The AI will conduct the full interview — greetings, questions, follow-ups — in that language.

| Code    | Language              | Code    | Language             |
| :------ | :-------------------- | :------ | :------------------- |
| `en-US` | English *(default)*   | `ja-JP` | Japanese             |
| `hi-IN` | Hindi                 | `ko-KR` | Korean               |
| `ta-IN` | Tamil                 | `zh-CN` | Chinese (Simplified) |
| `te-IN` | Telugu                | `zh-TW` | Chinese (Traditional)|
| `kn-IN` | Kannada               | `ar-SA` | Arabic               |
| `ml-IN` | Malayalam             | `ru-RU` | Russian              |
| `mr-IN` | Marathi               | `tr-TR` | Turkish              |
| `gu-IN` | Gujarati              | `vi-VN` | Vietnamese           |
| `pa-IN` | Punjabi               | `th-TH` | Thai                 |
| `bn-IN` | Bengali               | `id-ID` | Indonesian           |
| `ur-PK` | Urdu                  | `ms-MY` | Malay                |
| `es-ES` | Spanish               | `sv-SE` | Swedish              |
| `fr-FR` | French                | `da-DK` | Danish               |
| `de-DE` | German                | `fi-FI` | Finnish              |
| `it-IT` | Italian               | `nb-NO` | Norwegian            |
| `pt-PT` | Portuguese            | `el-GR` | Greek                |
| `pt-BR` | Portuguese (Brazil)   | `he-IL` | Hebrew               |
| `nl-NL` | Dutch                 | `ro-RO` | Romanian             |
| `pl-PL` | Polish                | `hu-HU` | Hungarian            |
|         |                       | `cs-CZ` | Czech                |
|         |                       | `uk-UA` | Ukrainian            |

> **Language switching during interview:** The candidate can switch language mid-interview by saying *"can we speak in Hindi"*, *"switch to Tamil"*, etc. The AI will switch immediately and continue in that language.

---

## 13. Changelog

### v3.1.0 — Bug Fixes

| # | File | Bug | Fix |
| :- | :--- | :-- | :-- |
| 1 | `sessions/sessionManager.js` | `done` and `resultsSent` properties missing from session init — could cause undefined behaviour in completion checks | Added `done: false` and `resultsSent: false` to every new session |
| 2 | `sessions/sessionManager.js` | No validation on `difficulty`, `maxDuration`, or `language` — arbitrary/invalid values accepted silently | Added enum check for difficulty, clamp maxDuration to 5–120 min, validate language against `VALID_LANGUAGES` set |
| 3 | `sessions/sessionManager.js` | Stray `""` string literal at end of file — syntax noise | Removed |
| 4 | `sessions/sessionManager.js` | Unused `EventEmitter` import and `eventEmitter` export | Removed |
| 5 | `agent/stateMachine.js` | `"hr"` interview type used in phase-skip logic — never set by any API, so behavioral phase was never actually skipped | Replaced both occurrences with `"behavioral"` |
| 6 | `app.js` | Typo in error message: `"Realtime session not a connected"` | Fixed to `"Realtime session not connected"` |
| 7 | `app.js` | Race condition: `sendResultsToN8n` called from both the WebSocket `onResponseText` path and the Recall.ai `bot.call_ended` webhook — caused duplicate n8n deliveries | Added `resultsSent` boolean guard; first caller wins, second is skipped |
| 8 | `app.js` | `createSession()` called during WS `init` but never cleaned up if the subsequent `realtimeSession.connect()` threw — orphaned sessions leaked memory | Added `deleteSession(sessionId)` and `activeConnections.delete()` in the catch block |
| 9 | `voice/tts.js` | Threw on ElevenLabs API errors instead of returning `null` — caused unhandled rejection that crashed the WebSocket audio flow | Changed `throw err` to `return null` for graceful degradation |
| 10 | `tools/webhookSender.js` | `fetch()` to n8n not checked for `response.ok` — silent failures on HTTP 4xx/5xx | Added `response.ok` check, throws on failure; added 3× retry with exponential back-off |
| 11 | `realtime/openaiRealtime.js` | Hardcoded model `gpt-4o-realtime-preview-2024-12-17` — breaks when OpenAI retires the preview version | Model now reads from `OPENAI_REALTIME_MODEL` env var, defaults to `gpt-4o-realtime-preview` |
