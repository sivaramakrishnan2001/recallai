// Session Management Module
// Handles: session creation, lifecycle, GC, and storage

// Valid BCP-47 language codes supported by the interview AI
const VALID_LANGUAGES = new Set([
  'en-US','ta-IN','es-ES','fr-FR','de-DE','it-IT','pt-PT','pt-BR',
  'hi-IN','ja-JP','ko-KR','zh-CN','zh-TW','ar-SA','ru-RU','nl-NL',
  'pl-PL','tr-TR','vi-VN','th-TH','id-ID','ms-MY','bn-IN','ur-PK',
  'sv-SE','da-DK','fi-FI','nb-NO','el-GR','he-IL','ro-RO','hu-HU',
  'cs-CZ','uk-UA','te-IN','kn-IN','ml-IN','mr-IN','gu-IN','pa-IN',
]);

const PHASE = {
  INTRODUCTION: "introduction",
  RESUME:       "resume",
  TECHNICAL:    "technical",
  BEHAVIORAL:   "behavioral",
  CLOSING:      "closing",
  DONE:         "done",
};

// Max 3 questions total across the entire interview.
// Distribution: 2 resume-anchored + 1 technical/closing = 3.
const PHASE_QUESTION_COUNTS = {
  easy:   { resume: 2, technical: 1, behavioral: 0 },
  medium: { resume: 2, technical: 1, behavioral: 0 },
  hard:   { resume: 2, technical: 1, behavioral: 0 },
};

const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const SESSION_GC_MS  = 30 * 60 * 1000;
const MAX_HISTORY_SIZE = 100; // Prevent unbounded growth
const sessions = new Map();
let gcInterval = null; // Keep reference to clean up properly

export function createSession(id, config) {
  // Prevent overwriting existing sessions with the same ID
  if (sessions.has(id)) {
    return sessions.get(id);
  }

  const difficulty = ["easy", "medium", "hard"].includes(config.difficulty)
    ? config.difficulty
    : "medium";

  const counts = PHASE_QUESTION_COUNTS[difficulty] || PHASE_QUESTION_COUNTS.medium;

  // Clamp maxDuration: minimum 5 minutes, maximum 120 minutes
  const rawDuration = config.max_interview_duration || config.maxDuration || 30;
  const maxDurationMinutes = Math.min(120, Math.max(5, Number(rawDuration) || 30));

  // Validate language — fall back to en-US if unknown code provided
  const rawLang = config.language || 'en-US';
  const language = VALID_LANGUAGES.has(rawLang) ? rawLang : 'en-US';
  if (rawLang !== language) {
    console.warn(`[Session] Unknown language "${rawLang}" — defaulting to en-US`);
  }

  const session = {
    id,
    candidateName:  config.candidateName || "Candidate",
    role:           config.role || "Software Engineer",
    resume:         config.resume || null,
    interviewType:  config.interviewType || "mixed",
    difficulty,
    language,
    phaseCounts:    counts,
    phase:          PHASE.INTRODUCTION,
    phaseStep:      0,
    followUpCount:  0,
    maxFollowUps:   2,
    history:        [],
    questionsAsked: [],
    scores: {
      communication: [],
      technicalKnowledge: [],
      problemSolving: [],
      practicalExperience: [],
    },
    processing:       false,
    done:             false,   // set true by end_interview tool or close action
    resultsSent:      false,   // guard against duplicate n8n webhook delivery
    startTime:        Date.now(),
    maxDurationMs:    maxDurationMinutes * 60 * 1000,
    timeWarningGiven: false,
  };

  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id);
}

export function hasSession(id) {
  return sessions.has(id);
}

export function deleteSession(id) {
  sessions.delete(id);
}

export function getAllSessions() {
  return Array.from(sessions.values());
}

/**
 * Initialize garbage collection with proper cleanup
 * Deletes old sessions and warns about large history
 */
export function initializeGarbageCollection() {
  if (gcInterval) clearInterval(gcInterval); // Prevent duplicate intervals
  
  gcInterval = setInterval(() => {
    const now = Date.now();
    let deletedCount = 0;
    let largeHistorySessions = [];
    
    // Use iterator to avoid concurrent modification issues
    for (const [id, session] of sessions.entries()) {
      if (now - session.startTime > SESSION_TTL_MS) {
        sessions.delete(id);
        deletedCount++;
      } else {
        // Monitor but DON'T trim — keep full conversation history for LLM context
        if (session.history.length > MAX_HISTORY_SIZE) {
          largeHistorySessions.push({
            id,
            historySize: session.history.length,
            duration: Math.round((now - session.startTime) / 60000),
          });
        }
      }
    }
    
    if (deletedCount > 0) {
      console.log(`[GC] Cleaned up ${deletedCount} expired session(s). Active: ${sessions.size}`);
    }
    
    if (largeHistorySessions.length > 0) {
      console.warn(`[GC] ${largeHistorySessions.length} session(s) with large history:`);
      largeHistorySessions.forEach(s => {
        console.warn(`     ${s.id}: ${s.historySize} messages (${s.duration}m duration)`);
      });
    }
  }, SESSION_GC_MS);
}

/**
 * Get elapsed time in milliseconds since interview started
 */
export function getElapsedTime(session) {
  return Date.now() - session.startTime;
}

/**
 * Get remaining time in milliseconds
 */
export function getRemainingTime(session) {
  const elapsed = getElapsedTime(session);
  const remaining = session.maxDurationMs - elapsed;
  return Math.max(0, remaining);
}

/**
 * Get remaining time in minutes (for display)
 */
export function getRemainingMinutes(session) {
  return Math.ceil(getRemainingTime(session) / 60000);
}

/**
 * Check if time is almost up (< 2 minutes remaining)
 */
export function isTimeAlmostUp(session) {
  return getRemainingTime(session) < 2 * 60 * 1000;
}

/**
 * Check if interview time has expired
 */
export function isTimeExpired(session) {
  return getRemainingTime(session) <= 0;
}

export { PHASE, PHASE_QUESTION_COUNTS, SESSION_TTL_MS, VALID_LANGUAGES };