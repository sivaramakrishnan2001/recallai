# DataAlchemist Interview AI Agent — API Documentation

> **Stack:** Node.js 18+ · Express · OpenAI Realtime API · ElevenLabs TTS · Recall.ai · WebSocket

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
| `RECALL_API_KEY`      | ✅ Yes   | Recall.ai API key for meeting bot creation                                  |
| `RECALL_REGION`       | ✅ Yes   | Recall.ai region. E.g. `ap-northeast-1`, `us-east-1`                       |
| `PORT`                | No       | HTTP port. Defaults to `3000`                                               |
| `N8N_WEBHOOK_URL`     | No       | n8n webhook to receive completed interview reports                          |
| `NGROK_AUTHTOKEN`     | No       | ngrok auth token for auto-tunnel setup                                      |
| `COMPOSIO_API_KEY`    | No       | Composio key for Gmail / Calendar / Slack / Notion integrations             |
| `COMPOSIO_USER_ID`    | No       | Composio user ID                                                            |

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

Recall.ai lifecycle webhook. Configure this URL in your Recall.ai dashboard under **Bot Webhooks**.

**URL:** `POST /webhook/recall/events`

### Events Handled

| Event                  | Action                                                                    |
| :--------------------- | :------------------------------------------------------------------------ |
| `bot.in_call_recording`| Auto-creates session if not already present using bot metadata            |
| `bot.call_ended`       | Finalises interview, fetches artifacts, sends report to n8n webhook       |
| `bot.done`             | Same as `bot.call_ended`                                                  |

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
        "role": "Senior Backend Engineer"
      }
    }
  }
}
```

### Response — 200 OK

```json
{ "ok": true }
```

---

## 9. POST /webhook/recall/transcript

Fallback transcript webhook from Recall.ai. Used when the meeting page's direct microphone capture fails — Recall.ai's own transcription is forwarded into the active OpenAI Realtime session instead.

**URL:** `POST /webhook/recall/transcript`

### Events Handled

| Event                     | Action                                               |
| :------------------------ | :--------------------------------------------------- |
| `transcript.data`         | Finalised text forwarded to OpenAI Realtime session  |
| `transcript.partial_data` | Ignored (only final transcripts are processed)       |

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
