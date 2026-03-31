// Text-to-Speech — ElevenLabs Integration
// Uses eleven_turbo_v2_5 for low latency (ideal for real-time interview audio)

export async function textToSpeech(text) {
  // Read environment variables dynamically (after dotenv.config() loads them)
  const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";

  if (!text || !text.trim()) return null;

  // Return null if no API key (allows dev/test without ElevenLabs)
  if (!ELEVENLABS_KEY) {
    console.log("[TTS] ELEVENLABS_API_KEY not set — audio disabled");
    return null;
  }

  const clean = text.replace(/\[META\].*$/ims, "").trim();
  if (!clean) return null;

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      {
        method: "POST",
        headers: {
          "xi-api-key":   ELEVENLABS_KEY,
          "Content-Type": "application/json",
          "Accept":       "audio/mpeg",
        },
        body: JSON.stringify({
          text: clean,
          model_id: MODEL_ID,
          voice_settings: {
            stability:        0.4,
            similarity_boost: 0.8,
            style:            0.2,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error(`[TTS] ${response.status}: ${err.substring(0, 200)}`);
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    console.log(`[TTS] Generated ${(buffer.byteLength / 1024).toFixed(1)}KB for: "${clean.substring(0, 60)}…"`);
    return Buffer.from(buffer).toString("base64");
  } catch (err) {
    console.error(`[TTS] Error: ${err.message}`);
    throw err; // Propagate the error instead of silently returning null
  }
}
