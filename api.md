Of course. Here is the API documentation with sample values for the core endpoints of this application.

---

### AI Interview Bot API Documentation

This document provides instructions and examples for using the AI Interview Bot's API to schedule and manage interviews.

### **1. Schedule a Single Interview**

This endpoint schedules an AI bot to join a specific meeting URL at a designated time.

*   **Endpoint:** `POST /api/schedule-bot`
*   **Description:** Schedules a single interview bot.
*   **Content-Type:** `application/json`

#### **Request Body**

| Field            | Type   | Required | Description                                                                                                    | Sample Value                                  |
| :--------------- | :----- | :------- | :------------------------------------------------------------------------------------------------------------- | :-------------------------------------------- |
| `candidate_name` | String | Yes      | The full name of the candidate.                                                                                | `"Jane Doe"`                                  |
| `role`           | String | Yes      | The job role the candidate is being interviewed for.                                                           | `"Senior Backend Engineer"`                   |
| `meeting_url`    | String | Yes      | The full URL for the Google Meet, Zoom, or other meeting platform.                                             | `"https://meet.google.com/xyz-abc-pqr"`        |
| `meeting_time`   | String | Yes      | The scheduled join time for the bot in ISO 8601 format.                                                        | `"2024-10-26T14:30:00Z"`                       |
| `server_url`     | String | Yes      | The public-facing URL of this server (e.g., your ngrok tunnel for local testing).                                | `"https://your-ngrok-url.ngrok-free.app"`       |
| `resume`         | String | No       | The full text of the candidate's resume for the AI to reference.                                               | `"Experienced developer with skills in Node.js..."` |
| `difficulty`     | String | No       | The interview difficulty. Enum: `"easy"`, `"medium"`, `"hard"`. Defaults to `"medium"`.                         | `"hard"`                                      |
| `interview_type` | String | No       | The topics to cover. Enum: `"mixed"`, `"technical"`, `"behavioral"`. Defaults to `"mixed"`.                     | `"technical"`                                 |
| `language`       | String | No       | The language for the interview. See the "Language Support" section below for available codes. Defaults to `en-US`. | `'es-ES'`                                     |

#### **Sample cURL Request**

```bash
curl -X POST http://localhost:3000/api/schedule-bot \
-H "Content-Type: application/json" \
-d '{
  "candidate_name": "Maria Garcia",
  "role": "Frontend Developer",
  "meeting_url": "https://meet.google.com/xyz-abc-pqr",
  "meeting_time": "2024-10-26T15:00:00Z",
  "server_url": "https://your-ngrok-url.ngrok-free.app",
  "resume": "Maria is a frontend developer with 5 years of experience in React and Vue.js.",
  "difficulty": "medium",
  "interview_type": "mixed",
  "language": "es-ES"
}'
```

---

### **2. Schedule Multiple Interviews (Batch)**

This endpoint allows for scheduling multiple interviews in a single API call.

*   **Endpoint:** `POST /api/batch-schedule`
*   **Description:** Schedules a batch of interviews.
*   **Content-Type:** `application/json`

#### **Request Body**

| Field        | Type  | Required | Description                                                                       |
| :----------- | :---- | :------- | :-------------------------------------------------------------------------------- |
| `server_url` | String| Yes      | The public-facing URL of this server.                                             |
| `interviews` | Array | Yes      | An array of interview objects. Each object uses the same format as `/api/schedule-bot`. |

#### **Sample cURL Request**

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
      "meeting_time": "2024-10-27T10:00:00Z"
    },
    {
      "candidate_name": "Kenji Tanaka",
      "role": "Data Scientist",
      "meeting_url": "https://meet.google.com/ddd-eee-fff",
      "meeting_time": "2024-10-27T11:00:00Z",
      "language": "ja-JP"
    }
  ]
}'
```

---

### **3. Get Interview Report**

This endpoint retrieves the final evaluation report for a completed interview session.

*   **Endpoint:** `GET /api/report/:sessionId`
*   **Description:** Retrieves the final report for a given session ID.

#### **Sample cURL Request**

```bash
cURL -X GET http://localhost:3000/api/report/bot_123456789abcdef
```

---

### **Language Support**

You can conduct interviews in multiple languages by providing the `language` code when scheduling an interview. The AI will greet the candidate, ask questions, and conduct the entire interview in the selected language.

The available languages and their codes are:

| Code    | Language             |
| :------ | :------------------- |
| `en-US` | English              |
| `es-ES` | Spanish              |
| `fr-FR` | French               |
| `de-DE` | German               |
| `it-IT` | Italian              |
| `pt-PT` | Portuguese           |
| `hi-IN` | Hindi                |
| `ja-JP` | Japanese             |
| `ko-KR` | Korean               |
| `zh-CN` | Chinese (Simplified) |

