// ============================================================================
// Real-Time Transcript WebSocket Handler
// Serves live transcripts to agent page via WebSocket
// 
// Usage: WS clients connect to /rt/transcript?session=SESSION_ID
// They receive: { type: "transcript_partial"|"transcript_final", text: "..." }
// ============================================================================

import { WebSocketServer } from 'ws';
import { getSession } from '../sessions/sessionManager.js';

const transcriptSockets = new Map(); // { sessionId -> [WebSocket, ...] }

/**
 * Initialize WebSocket server for real-time transcripts
 * @param {http.Server} server - HTTP server instance
 */
export function initializeTranscriptWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/rt/transcript' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('session');

    if (!sessionId) {
      console.warn('[WS] No session ID provided');
      ws.close(1008, 'Missing session ID');
      return;
    }

    if (!getSession(sessionId)) {
      console.warn(`[WS] Session not found: ${sessionId}`);
      ws.close(1008, `Session ${sessionId} not found`);
      return;
    }

    console.log(`[WS] Client connected: ${sessionId}`);

    // Register socket for this session
    if (!transcriptSockets.has(sessionId)) {
      transcriptSockets.set(sessionId, []);
    }
    transcriptSockets.get(sessionId).push(ws);

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connection',
      message: `Connected to session ${sessionId}`,
      timestamp: Date.now(),
    }));

    ws.on('close', () => {
      console.log(`[WS] Client disconnected: ${sessionId}`);
      const sockets = transcriptSockets.get(sessionId);
      if (sockets) {
        const idx = sockets.indexOf(ws);
        if (idx > -1) sockets.splice(idx, 1);
      }
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error in ${sessionId}:`, err.message);
    });
  });

  console.log('[WS] Transcript WebSocket server initialized');
  return wss;
}

/**
 * Broadcast transcript update to all connected clients for a session
 * @param {string} sessionId - Session ID
 * @param {string} text - Transcript text
 * @param {boolean} isFinal - Is this the final transcript for this turn?
 */
export function broadcastTranscript(sessionId, text, isFinal = false) {
  const sockets = transcriptSockets.get(sessionId);
  if (!sockets || sockets.length === 0) {
    return; // No clients connected
  }

  const payload = JSON.stringify({
    type: isFinal ? 'transcript_final' : 'transcript_partial',
    text,
    sessionId,
    timestamp: Date.now(),
  });

  console.log(`[WS] Broadcasting to ${sockets.length} clients (${sessionId}): "${text.substring(0, 60)}..."`);

  sockets.forEach((ws) => {
    if (ws.readyState === 1) { // OPEN
      ws.send(payload);
    }
  });
}

/**
 * Broadcast phase change to agent page
 * @param {string} sessionId - Session ID
 * @param {number} phaseIndex - New phase (0-4)
 */
export function broadcastPhaseChange(sessionId, phaseIndex) {
  const sockets = transcriptSockets.get(sessionId);
  if (!sockets) return;

  const payload = JSON.stringify({
    type: 'phase_change',
    phase: phaseIndex,
    sessionId,
    timestamp: Date.now(),
  });

  sockets.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
  });
}

/**
 * Send a score update notification
 * @param {string} sessionId - Session ID
 * @param {number} score - Score (0-100)
 * @param {string} feedback - Feedback text
 */
export function broadcastScore(sessionId, score, feedback) {
  const sockets = transcriptSockets.get(sessionId);
  if (!sockets) return;

  const payload = JSON.stringify({
    type: 'score_update',
    score,
    feedback,
    sessionId,
    timestamp: Date.now(),
  });

  sockets.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
  });
}

export default { initializeTranscriptWebSocket, broadcastTranscript, broadcastPhaseChange, broadcastScore };
