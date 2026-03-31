// ============================================================================
// ElevenLabs Audio Handler for Interview Bot
// Generates speech from text and serves audio back to agent page
// ============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generate audio from text using ElevenLabs API
 * @param {string} text - Text to convert to speech
 * @param {Object} options - Generation options
 * @returns {Promise<{audioBuffer, duration, voiceId}>}
 */
export async function generateInterviewerAudio(text, options = {}) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Default: Rachel

  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY not set');
  }

  if (!text || text.trim().length < 2) {
    throw new Error('Text too short to synthesize');
  }

  const voiceId = options.voiceId || ELEVENLABS_VOICE_ID;
  const modelId = options.modelId || 'eleven_monolingual_v1';
  const stability = options.stability ?? 0.7;
  const similarityBoost = options.similarityBoost ?? 0.8;

  try {
    console.log(`[ElevenLabs] Generating audio: "${text.substring(0, 60)}..."`);

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ElevenLabs] Error: ${response.status} ${errorText}`);
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    const audioBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(audioBuffer);

    console.log(`[ElevenLabs] Generated ${buffer.length} bytes`);

    return {
      audioBuffer: buffer,
      audioBase64: buffer.toString('base64'),
      voiceId,
      textLength: text.length,
    };
  } catch (err) {
    console.error('[ElevenLabs] Generation failed:', err.message);
    throw err;
  }
}

/**
 * Save audio buffer to temporary file and return URL
 * Useful for streaming to HTML5 <audio> tag
 * @param {Buffer} audioBuffer - Audio data
 * @param {string} sessionId - Session ID for file naming
 * @returns {string} Relative URL to audio file
 */
export function saveAudioFile(audioBuffer, sessionId) {
  const tempDir = path.join(__dirname, '../../public/audio');
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `${sessionId}_${Date.now()}.mp3`;
  const filepath = path.join(tempDir, filename);

  fs.writeFileSync(filepath, audioBuffer);
  console.log(`[Audio] Saved: ${filepath}`);

  return `/audio/${filename}`; // Relative URL for client
}

/**
 * Generate audio and save to file in one step
 * @param {string} text - Text to synthesize
 * @param {string} sessionId - Session ID
 * @param {Object} options - Voice options (voiceId, stability, etc.)
 * @returns {Promise<{audioUrl, base64, duration}>}
 */
export async function generateAndSaveAudio(text, sessionId, options = {}) {
  try {
    const result = await generateInterviewerAudio(text, options);
    const audioUrl = saveAudioFile(result.audioBuffer, sessionId);

    return {
      audioUrl,
      audioBase64: result.audioBase64,
      voiceId: result.voiceId,
      textLength: result.textLength,
    };
  } catch (err) {
    console.error('[Audio] Generate and save failed:', err.message);
    throw err;
  }
}

/**
 * Cleanup old audio files (> 1 hour old)
 * Call periodically to save disk space
 */
export function cleanupOldAudioFiles(maxAgeMs = 3600000) {
  const audioDir = path.join(__dirname, '../../public/audio');
  
  if (!fs.existsSync(audioDir)) {
    return; // Directory doesn't exist
  }

  const now = Date.now();
  let deleted = 0;

  fs.readdirSync(audioDir).forEach((file) => {
    const filepath = path.join(audioDir, file);
    const stat = fs.statSync(filepath);
    const age = now - stat.mtimeMs;

    if (age > maxAgeMs) {
      fs.unlinkSync(filepath);
      deleted++;
    }
  });

  if (deleted > 0) {
    console.log(`[Audio] Cleaned up ${deleted} old files`);
  }
}

/**
 * Batch cleanup on a schedule (e.g., every 30 minutes)
 * Call this once at server startup
 */
export function scheduleAudioCleanup(intervalMs = 1800000) {
  setInterval(() => {
    cleanupOldAudioFiles();
  }, intervalMs);

  console.log('[Audio] Cleanup scheduler started');
}

export default {
  generateInterviewerAudio,
  generateAndSaveAudio,
  saveAudioFile,
  cleanupOldAudioFiles,
  scheduleAudioCleanup,
};
