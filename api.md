# AI Interview Bot API Documentation

Base URL: `http://localhost:3000` (or your public server URL / ngrok tunnel)

---

## Endpoints

### `GET /health`

Returns server health and current session stats.

**Response**
```json
{
  "ok": true,
  "version": "3.0",
  "architecture": "openai-realtime",
  "sessions": 2,
  "activeConnections": 1
}
```

---

### `POST /api/schedule-bot`

Schedules a Recall.ai bot to join a meeting and conduct a voice interview.

**Content-Type:** `application/json`

#### Request Body

| Field            | Type   | Required | Description                                                                                     |
| :--------------- | :----- | :------- | :---------------------------------------------------------------------------------------------- |
| `candidate_name` | String | Yes      | Full name of the candidate.                                                                     |
| `role`           | String | Yes      | Job role being interviewed for.                                                                 |
| `meeting_url`    | String | Yes      | Google Meet, Zoom, or other meeting URL.                                                        |
| `meeting_time`   | String | Yes      | ISO 8601 scheduled join time.                                                                   |
| `server_url`     | String | No       | Public-facing URL of this server. Defaults to `PUBLIC_URL` env. Required for local ngrok.      |
| `resume`         | String | No       | Candidate resume text for the AI to reference.                                                  |
| `difficulty`     | String | No       | `"easy"`, `"medium"`, `"hard"`. Defaults to `"medium"`.                                         |
| `interview_type` | String | No       | `"mixed"`, `"technical"`, `"behavioral"`. Defaults to `"mixed"`.                                |
| `language`       | String | No       | BCP-47 language code (see Language Support). Defaults to `"en-US"`.                             |

#### Sample Request

```bash
curl -X POST http://localhost:3000/api/schedule-bot \
  -H "Content-Type: application/json" \
  -d '{
    "candidate_name": "Jane Doe",
    "role": "Senior Backend Engineer",
    "meeting_url": "https://meet.google.com/xyz-abc-pqr",
    "meeting_time": "2025-06-15T14:30:00Z",
    "server_url": "https://your-ngrok-url.ngrok-free.app",
    "resume": "Experienced Node.js developer with 7 years backend experience.",
    "difficulty": "hard",
    "interview_type": "technical"
  }'
```

#### Response

```json
{
  "success": true,
  "bot_id": "recall_bot_abc123",
  "session_id": "bot_1718461800000",
  "joined_at": "2025-06-15T14:30:00.000Z",
  "meeting_url": "https://meet.google.com/xyz-abc-pqr",
  "message": "Bot scheduled to join at 6/15/2025, 2:30:00 PM"
}
```

---

### `POST /api/batch-schedule`

Schedules multiple interviews in a single call.

**Content-Type:** `application/json`

#### Request Body

| Field        | Type   | Required | Description                                                                              |
| :----------- | :----- | :------- | :--------------------------------------------------------------------------------------- |
| `interviews` | Array  | Yes      | Array of interview objects. Each uses the same fields as `/api/schedule-bot`.            |
| `server_url` | String | No       | Public-facing URL of this server. Applies to all interviews. Defaults to `PUBLIC_URL`.  |

#### Sample Request

```bash
curl -X POST http://localhost:3000/api/batch-schedule \
  -H "Content-Type: application/json" \
  -d '{
    "server_url": "https://your-ngrok-url.ngrok-free.app",
    "interviews": [
      {
        "candidate_name": "John Smith",
        "role": "Product Manager",
        "meeting_url": "https://meet.google.com/aaa-bbb-ccc",
        "meeting_time": "2025-06-16T10:00:00Z"
      },
      {
        "candidate_name": "Kenji Tanaka",
        "role": "Data Scientist",
        "meeting_url": "https://meet.google.com/ddd-eee-fff",
        "meeting_time": "2025-06-16T11:00:00Z",
        "language": "ja-JP"
      }
    ]
  }'
```

#### Response

```json
{
  "summary": { "total": 2, "scheduled": 2, "failed": 0 },
  "scheduled": [
    { "success": true, "bot_id": "recall_bot_111", "session_id": "bot_111", "candidate_name": "John Smith" },
    { "success": true, "bot_id": "recall_bot_222", "session_id": "bot_222", "candidate_name": "Kenji Tanaka" }
  ],
  "errors": []
}
```

---

### `GET /api/report/:sessionId`

Retrieves the interview evaluation report for a completed session.

#### Sample Request

```bash
curl http://localhost:3000/api/report/bot_1718461800000
```

#### Response

```json
{
  "session_id": "bot_1718461800000",
  "candidate": "Jane Doe",
  "role": "Senior Backend Engineer",
  "overall_score": 82,
  "phases": { ... },
  "transcript_url": "https://...",
  "report_url": "https://..."
}
```

---

### `POST /webhook/recall/events`

Recall.ai lifecycle webhook. Configure this in your Recall.ai dashboard.

**Events handled:**
- `bot.in_call_recording` — bot has joined the meeting; session is auto-created if not already present.
- `bot.call_ended` / `bot.done` — interview finalised; report sent to n8n webhook; WebSocket closed.

#### Sample Payload (bot.call_ended)

```json
{
  "event": "bot.call_ended",
  "data": {
    "bot": {
      "id": "recall_bot_abc123",
      "metadata": {
        "candidate_name": "Jane Doe",
        "role": "Senior Backend Engineer"
      }
    }
  }
}
```

---

### `POST /webhook/recall/transcript`

Recall.ai transcript webhook (fallback). Used when direct audio capture from the meeting page is unavailable.

**Events handled:**
- `transcript.data` — finalised transcript segment forwarded to OpenAI Realtime API.
- `transcript.partial_data` — ignored.

---

### `GET /meeting-page`

Interview UI served to the Recall.ai bot's virtual camera. Connects via WebSocket to stream audio to OpenAI Realtime API and plays back TTS responses.

#### Query Parameters

| Parameter   | Description                          | Example                    |
| :---------- | :----------------------------------- | :------------------------- |
| `sessionId` | Interview session ID                 | `bot_1718461800000`        |
| `candidate` | Candidate name (display only)        | `Jane Doe`                 |
| `role`      | Job role (display only)              | `Senior Backend Engineer`  |
| `difficulty`| Interview difficulty                 | `hard`                     |
| `type`      | Interview type                       | `technical`                |
| `server`    | Override server host for WebSocket   | `your-ngrok-url.ngrok-free.app` |

---

### WebSocket `/ws`

Real-time audio bridge between the meeting page and OpenAI Realtime API.

#### Client → Server Messages

| `type`        | Payload                              | Description                                    |
| :------------ | :----------------------------------- | :--------------------------------------------- |
| `init`        | `{ sessionId, candidate, role, difficulty, interviewType }` | Initialise session and start OpenAI connection. |
| `audio`       | `{ data: "<base64 PCM16 24kHz>" }`   | Raw microphone audio chunk.                    |
| `text`        | `{ text: "..." }`                    | Text input fallback (no mic).                  |
| `clear_audio` | `{}`                                 | Signal that audio playback finished.           |

#### Server → Client Messages

| `type`         | Payload                              | Description                                    |
| :------------- | :----------------------------------- | :--------------------------------------------- |
| `ready`        | `{}`                                 | Session initialised; client should start audio capture. |
| `audio`        | `{ data: "<base64 MP3>", phase, text }` | TTS audio chunk to play.                     |
| `transcript`   | `{ text, partial }`                  | Speech recognised from the candidate.          |
| `text_delta`   | `{ text }`                           | Streaming AI text token.                       |
| `phase`        | `{ phase }`                          | Interview phase change.                        |
| `speech_start` | `{}`                                 | Candidate started speaking.                    |
| `speech_stop`  | `{}`                                 | Candidate stopped speaking.                    |
| `done`         | `{}`                                 | Interview complete.                            |
| `error`        | `{ message }`                        | Server error.                                  |

---

## Language Support

| Code    | Language             |
| :------ | :------------------- |
| `en-US` | English (default)    |
| `es-ES` | Spanish              |
| `fr-FR` | French               |
| `de-DE` | German               |
| `it-IT` | Italian              |
| `pt-PT` | Portuguese           |
| `hi-IN` | Hindi                |
| `ja-JP` | Japanese             |
| `ko-KR` | Korean               |
| `zh-CN` | Chinese (Simplified) |
