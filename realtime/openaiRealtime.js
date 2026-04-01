// OpenAI Realtime API Client
// WebSocket-based real-time conversation with audio input + text output
// Uses ElevenLabs for TTS instead of OpenAI's built-in voices

import WebSocket from "ws";

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
const RECONNECT_MAX = 3;
const RECONNECT_DELAY = 2000;

export class RealtimeSession {
  /**
   * @param {Object} options
   * @param {Function} options.onResponseText  - (text) => void — full text response from model
   * @param {Function} options.onResponseDelta - (delta) => void — streaming text delta
   * @param {Function} options.onToolCall      - (name, args, callId) => void
   * @param {Function} options.onTranscript    - (text) => void — what OpenAI heard (Whisper)
   * @param {Function} options.onSpeechStart   - () => void — VAD detected speech start
   * @param {Function} options.onSpeechStop    - () => void — VAD detected speech end
   * @param {Function} options.onError         - (error) => void
   * @param {Function} options.onClose         - () => void
   */
  constructor(options = {}) {
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;

    // Callbacks
    this.onResponseText  = options.onResponseText  || (() => {});
    this.onResponseDelta = options.onResponseDelta || (() => {});
    this.onToolCall      = options.onToolCall      || (() => {});
    this.onTranscript    = options.onTranscript    || (() => {});
    this.onSpeechStart   = options.onSpeechStart   || (() => {});
    this.onSpeechStop    = options.onSpeechStop    || (() => {});
    this.onError         = options.onError         || (() => {});
    this.onClose         = options.onClose         || (() => {});

    // Accumulate response text and tool call arguments
    this._responseText = "";
    this._toolCallArgs = {};
    this._currentResponseId = null;
    this._pendingToolResults = 0; // Track how many tool calls need results before triggering response
  }

  /**
   * Connect to OpenAI Realtime API and configure the session
   * @param {string} instructions - System prompt / instructions
   * @param {Array} tools - Tool definitions for function calling
   * @returns {Promise<void>}
   */
  async connect(instructions, tools = []) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      const timeout = setTimeout(() => {
        reject(new Error("OpenAI Realtime connection timeout (10s)"));
        this.close();
      }, 10000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        console.log("[Realtime] Connected to OpenAI");

        // Configure session
        this._sendEvent("session.update", {
          session: {
            modalities: ["text"],
            instructions,
            tools: tools.map(t => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
            input_audio_format: "pcm16",
            input_audio_transcription: {
              model: "whisper-1",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 800,
            },
            temperature: 0.7,
            max_response_output_tokens: 300,
          },
        });

        resolve();
      });

      this.ws.on("message", (raw) => {
        try {
          const event = JSON.parse(raw.toString());
          this._handleEvent(event);
        } catch (err) {
          console.error("[Realtime] Parse error:", err.message);
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        console.error("[Realtime] WS error:", err.message);
        this.onError(err);
        if (!this.connected) reject(err);
      });

      this.ws.on("close", (code, reason) => {
        this.connected = false;
        console.log(`[Realtime] Disconnected (${code})`);
        this.onClose();
      });
    });
  }

  /**
   * Handle incoming events from OpenAI Realtime API
   */
  _handleEvent(event) {
    switch (event.type) {
      // Session confirmed
      case "session.created":
        console.log("[Realtime] Session created");
        break;
      case "session.updated":
        console.log("[Realtime] Session configured");
        break;

      // VAD events
      case "input_audio_buffer.speech_started":
        this.onSpeechStart();
        break;
      case "input_audio_buffer.speech_stopped":
        this.onSpeechStop();
        break;
      case "input_audio_buffer.committed":
        console.log("[Realtime] Audio committed for processing");
        break;

      // Transcription of user's speech (Whisper)
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.onTranscript(event.transcript.trim());
        }
        break;
      case "conversation.item.input_audio_transcription.failed":
        console.warn("[Realtime] Transcription failed:", event.error?.message);
        break;

      // Response lifecycle
      case "response.created":
        this._responseText = "";
        this._toolCallArgs = {};
        this._currentResponseId = event.response?.id;
        break;

      // Text response streaming
      case "response.text.delta":
        this._responseText += event.delta || "";
        this.onResponseDelta(event.delta || "");
        break;
      case "response.text.done":
        this.onResponseText(event.text || this._responseText);
        break;

      // Tool/function call streaming
      case "response.function_call_arguments.delta":
        if (!this._toolCallArgs[event.call_id]) {
          this._toolCallArgs[event.call_id] = { name: event.name, args: "" };
        }
        this._toolCallArgs[event.call_id].args += event.delta || "";
        break;
      case "response.function_call_arguments.done":
        this._pendingToolResults++;
        try {
          const parsed = JSON.parse(event.arguments);
          this.onToolCall(event.name, parsed, event.call_id);
        } catch (err) {
          console.error("[Realtime] Tool call parse error:", err.message);
          // Submit error result so model can recover
          this.submitToolResult(event.call_id, { error: "Invalid arguments" });
        }
        break;

      // Response complete — all tool calls in this response are done
      case "response.done":
        if (event.response?.status === "failed") {
          console.error("[Realtime] Response failed:", event.response?.status_details);
          this.onError(new Error("Response generation failed"));
        }
        // If there were pending tool results, trigger one response.create now
        if (this._pendingToolResults > 0) {
          this._pendingToolResults = 0;
          this._sendEvent("response.create", {});
        }
        break;

      // Rate limit info
      case "rate_limits.updated":
        // Log if getting close to limits
        for (const limit of (event.rate_limits || [])) {
          if (limit.remaining < 5) {
            console.warn(`[Realtime] Rate limit warning: ${limit.name} = ${limit.remaining} remaining`);
          }
        }
        break;

      // Errors
      case "error":
        console.error("[Realtime] API error:", event.error?.message, event.error?.code);
        this.onError(new Error(event.error?.message || "Unknown API error"));
        break;

      default:
        // Ignore other events (conversation.item.created, response.output_item.*, etc.)
        break;
    }
  }

  /**
   * Send raw PCM16 audio chunk (base64 encoded)
   * @param {string} base64Audio - Base64-encoded PCM16 audio at 24kHz mono
   */
  sendAudio(base64Audio) {
    if (!this.connected || !base64Audio) return;
    this._sendEvent("input_audio_buffer.append", {
      audio: base64Audio,
    });
  }

  /**
   * Clear the audio input buffer (e.g., on echo cancellation)
   */
  clearAudioBuffer() {
    if (!this.connected) return;
    this._sendEvent("input_audio_buffer.clear", {});
  }

  /**
   * Send text message (fallback when audio not available)
   * @param {string} text - User's text message
   */
  sendText(text) {
    if (!this.connected || !text?.trim()) return;
    this._sendEvent("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: text.trim() }],
      },
    });
    this._sendEvent("response.create", {});
  }

  /**
   * Submit tool call result back to OpenAI
   * @param {string} callId - The call_id from the tool call event
   * @param {Object} result - Result data to return to the model
   */
  /**
   * Submit tool call result back to OpenAI.
   * Does NOT auto-trigger response.create — that's handled by response.done
   * to batch multiple tool results before triggering one response.
   */
  submitToolResult(callId, result) {
    if (!this.connected) return;
    this._sendEvent("conversation.item.create", {
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
  }

  /**
   * Update session configuration (e.g., change instructions mid-interview)
   * @param {Object} config - Partial session config to merge
   */
  updateInstructions(instructions) {
    if (!this.connected) return;
    this._sendEvent("session.update", {
      session: { instructions },
    });
  }

  /**
   * Trigger a response from the model (e.g., for greeting)
   * @param {string} text - Optional instruction/prompt for this response
   */
  triggerResponse(text) {
    if (!this.connected) return;
    if (text) {
      // Add a system-like instruction as user message, then trigger
      this._sendEvent("conversation.item.create", {
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
    }
    this._sendEvent("response.create", {});
  }

  /**
   * Close the connection
   */
  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // Ignore close errors
      }
      this.ws = null;
      this.connected = false;
    }
  }

  /**
   * Send a typed event to OpenAI
   */
  _sendEvent(type, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type, ...data }));
    } catch (err) {
      console.error(`[Realtime] Send error (${type}):`, err.message);
    }
  }

  get isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}
