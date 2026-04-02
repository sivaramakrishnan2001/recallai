// Answer Evaluator — Process tool calls, record scores, generate reports
// Works with OpenAI Realtime API tool calling (primary) and [META] tags (legacy fallback)

import { advancePhase } from "../agent/stateMachine.js";
import { PHASE } from "../sessions/sessionManager.js";
import { LANGUAGES, MAX_INTERVIEW_QUESTIONS } from "./questionGenerator.js";

// Legacy regex for backward compatibility with non-Realtime API paths
const META_REGEX = /\[META\]\s*phase:(\w+)\s+action:(\w+)\s+comm:(\d+)\s+tech:(\d+)\s+solve:(\d+)\s+exp:(\d+)\s+question:(.*?)(?:\n|$)/i;

function calculateAllScoreAverages(scores) {
  const stat = (arr) => {
    if (arr.length === 0) return { avg: 0, count: 0 };
    const sum = arr.reduce((a, b) => a + b, 0);
    return { avg: Math.round((sum / arr.length) * 10) / 10, count: arr.length };
  };
  return {
    communication:       stat(scores.communication),
    technicalKnowledge:  stat(scores.technicalKnowledge),
    problemSolving:      stat(scores.problemSolving),
    practicalExperience: stat(scores.practicalExperience),
  };
}

/**
 * Process a tool call from OpenAI Realtime API
 * @param {Object} session - Interview session
 * @param {string} toolName - Name of the tool called
 * @param {Object} args - Tool call arguments
 * @returns {Object} Result to send back to OpenAI
 */
export function processToolCall(session, toolName, args) {
  switch (toolName) {
    case "evaluate_response": {
      const scores = {
        communication:       Math.min(10, Math.max(0, args.communication        || 0)),
        technicalKnowledge:  Math.min(10, Math.max(0, args.technical_knowledge  || 0)),
        problemSolving:      Math.min(10, Math.max(0, args.problem_solving      || 0)),
        practicalExperience: Math.min(10, Math.max(0, args.practical_experience || 0)),
      };

      // Record non-zero scores
      if (scores.communication > 0 || scores.technicalKnowledge > 0 ||
          scores.problemSolving > 0 || scores.practicalExperience > 0) {
        recordScores(session, scores);
      }

      // Track question for deduplication and limit enforcement
      if (args.question_asked) {
        session.questionsAsked.push(args.question_asked);
      }

      // Advance state machine
      advancePhase(session, "ask");

      const totalAsked = session.questionsAsked.length;
      console.log(`[Eval] Q${totalAsked}/${MAX_INTERVIEW_QUESTIONS} scored — comm:${scores.communication} tech:${scores.technicalKnowledge} solve:${scores.problemSolving} exp:${scores.practicalExperience}`);

      // Hard limit enforcement — signal AI to close and end when all questions are done
      if (totalAsked >= MAX_INTERVIEW_QUESTIONS) {
        console.log(`[Eval] Question limit reached (${totalAsked}/${MAX_INTERVIEW_QUESTIONS}) — signalling end`);
        return {
          status: "recorded",
          phase:  session.phase,
          limit_reached: true,
          instruction: `All ${MAX_INTERVIEW_QUESTIONS} questions have been asked and scored. Speak ONE warm closing sentence now, then IMMEDIATELY call end_interview with reason "all_questions_complete". Do NOT ask another question.`,
        };
      }

      const remaining = MAX_INTERVIEW_QUESTIONS - totalAsked;
      return {
        status:    "recorded",
        phase:     session.phase,
        remaining: remaining,
        instruction: `${remaining} question${remaining > 1 ? "s" : ""} remaining. Ask the next resume-anchored question.`,
      };
    }

    case "transition_phase": {
      const nextPhase = args.next_phase;
      const validPhases = Object.values(PHASE);

      if (!validPhases.includes(nextPhase)) {
        console.warn(`[Eval] Invalid phase transition: "${nextPhase}"`);
        return { status: "error", message: `Invalid phase: ${nextPhase}` };
      }

      console.log(`[Eval] Phase transition: ${session.phase} -> ${nextPhase} (${args.reason || "no reason"})`);
      advancePhase(session, "transition");

      return { status: "transitioned", phase: session.phase };
    }

    case "end_interview": {
      console.log(`[Eval] Interview ended: ${args.reason || "no reason"}`);
      session.phase = PHASE.DONE;
      session.done = true;
      return { status: "ended", phase: PHASE.DONE };
    }
    
    case "change_language": {
      const newLang = args.language;
      if (LANGUAGES[newLang]) {
        session.language = newLang;
        console.log(`[Eval] Language changed to: ${LANGUAGES[newLang]} (${newLang})`);
        return { status: "language_changed", language: newLang };
      } else {
        console.warn(`[Eval] Invalid language code: "${newLang}"`);
        return { status: "error", message: `Invalid language code: ${newLang}` };
      }
    }

    default:
      console.warn(`[Eval] Unknown tool: "${toolName}"`);
      return { status: "error", message: `Unknown tool: ${toolName}` };
  }
}

/**
 * Parse LLM Response — Legacy [META] tag parser (backward compatibility)
 */
export function parseLLMResponse(raw) {
  const metaMatch = raw.match(META_REGEX);

  const spokenText = raw.replace(/\[META\].*$/ims, "").trim()
    || "Thank you. Let's continue.";

  if (!metaMatch) {
    return {
      spokenText,
      phase:    null,
      action:   "ask",
      scores:   { communication: 0, technicalKnowledge: 0, problemSolving: 0, practicalExperience: 0 },
      question: "",
    };
  }

  return {
    spokenText,
    phase:  metaMatch[1],
    action: metaMatch[2],
    scores: {
      communication:      +metaMatch[3],
      technicalKnowledge:  +metaMatch[4],
      problemSolving:      +metaMatch[5],
      practicalExperience: +metaMatch[6],
    },
    question: metaMatch[7]?.trim() || "",
  };
}

/**
 * Record scores — Only adds non-zero values
 */
export function recordScores(session, scores) {
  const scoreKeys = ["communication", "technicalKnowledge", "problemSolving", "practicalExperience"];
  for (const key of scoreKeys) {
    if (scores[key] > 0) {
      session.scores[key].push(scores[key]);
    }
  }
}

/**
 * Calculate average
 */
export function avg(arr) {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10;
}

/**
 * Generate Report — Weighted scoring
 * Technical(40%) + Communication(20%) + Experience(20%) + ProblemSolving(20%)
 */
export function generateReport(session) {
  const stats = calculateAllScoreAverages(session.scores);

  const commScore  = stats.communication.avg;
  const techScore  = stats.technicalKnowledge.avg;
  const solveScore = stats.problemSolving.avg;
  const expScore   = stats.practicalExperience.avg;

  let overall = 0;
  if (stats.communication.count > 0 || stats.technicalKnowledge.count > 0 ||
      stats.problemSolving.count > 0 || stats.practicalExperience.count > 0) {

    let weightedSum = 0;
    let totalWeight = 0;

    if (stats.communication.count > 0)       { weightedSum += commScore  * 0.20; totalWeight += 0.20; }
    if (stats.technicalKnowledge.count > 0)   { weightedSum += techScore  * 0.40; totalWeight += 0.40; }
    if (stats.problemSolving.count > 0)       { weightedSum += solveScore * 0.20; totalWeight += 0.20; }
    if (stats.practicalExperience.count > 0)  { weightedSum += expScore   * 0.20; totalWeight += 0.20; }

    overall = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
  }

  const strengths  = [];
  const weaknesses = [];

  // Communication
  if (stats.communication.count > 0) {
    if      (commScore >= 8.5) strengths.push("Exceptionally clear communicator — structured, confident, and easy to follow under pressure");
    else if (commScore >= 7)   strengths.push("Communicates clearly and concisely with good structure");
    else if (commScore >= 5.5) weaknesses.push("Communication is adequate but could benefit from more precision and structure");
    else if (commScore >= 4)   weaknesses.push("Answers tended to be disorganised or hard to follow — communication needs development");
    else                       weaknesses.push("Struggled to express ideas clearly — significant communication gap for this level");
  }

  // Technical knowledge
  if (stats.technicalKnowledge.count > 0) {
    if      (techScore >= 8.5) strengths.push("Deep technical knowledge with real nuance — understands edge cases and underlying principles");
    else if (techScore >= 7)   strengths.push("Solid technical foundation with evidence of hands-on depth");
    else if (techScore >= 5.5) weaknesses.push("Technical knowledge is present but surface-level in places — may need support on complex problems");
    else if (techScore >= 4)   weaknesses.push("Noticeable gaps in technical understanding for a role at this level");
    else                       weaknesses.push("Technical knowledge did not meet the bar for this role — significant gaps identified");
  }

  // Problem solving
  if (stats.problemSolving.count > 0) {
    if      (solveScore >= 8.5) strengths.push("Exceptional problem-solving — systematic, creative, and explicitly considers tradeoffs");
    else if (solveScore >= 7)   strengths.push("Approaches problems logically with clear reasoning");
    else if (solveScore >= 5.5) weaknesses.push("Problem-solving is functional but lacks depth — tradeoffs and alternatives were rarely explored");
    else if (solveScore >= 4)   weaknesses.push("Struggled to structure their thinking — analytical approach needs strengthening");
    else                        weaknesses.push("Problem-solving approach was unclear or ineffective in the context of this role");
  }

  // Practical experience
  if (stats.practicalExperience.count > 0) {
    if      (expScore >= 8.5) strengths.push("Highly relevant hands-on experience — specific outcomes, scale, and personal ownership were evident");
    else if (expScore >= 7)   strengths.push("Good practical background with concrete examples and real-world context");
    else if (expScore >= 5.5) weaknesses.push("Experience was cited but lacked specifics — impact and personal contribution were hard to assess");
    else if (expScore >= 4)   weaknesses.push("Answers relied heavily on theory or team-level work — limited evidence of direct ownership");
    else                      weaknesses.push("Practical experience for this role and level was not adequately demonstrated");
  }

  const hiringDecision = overall >= 8
    ? "STRONG_YES"
    : overall >= 6.5
      ? "YES"
      : overall >= 5
        ? "MAYBE"
        : "NO";

  const hiringLabel = {
    STRONG_YES: "Strong hire — recommend fast-tracking to next stage",
    YES:        "Hire — meets the bar and worth pursuing",
    MAYBE:      "On the fence — a second opinion or deeper technical screen is advised",
    NO:         "Pass — did not meet the required standard for this role at this time",
  };

  const summary = overall >= 8
    ? `${session.candidateName} had an excellent interview for the ${session.role} role. Answers were specific, well-reasoned, and showed real depth. Strong recommend for the next stage.`
    : overall >= 6.5
      ? `${session.candidateName} performed well across the key areas for the ${session.role} role. There is clear potential and enough evidence to move forward with confidence.`
      : overall >= 5
        ? `${session.candidateName} showed capability in places but the overall picture was mixed. A follow-up technical screen or second interviewer would help clarify fit for the ${session.role} role.`
        : `${session.candidateName} did not demonstrate the level of capability needed for the ${session.role} role at this time. Key areas fell below the expected standard.`;

  return {
    candidate_name:        session.candidateName,
    role:                  session.role,
    difficulty:            session.difficulty,
    interview_type:        session.interviewType,
    overall_score:         overall,
    overall_score_str:     `${overall}/10`,
    technical_score:       stats.technicalKnowledge.count  > 0 ? techScore  : null,
    communication_score:   stats.communication.count       > 0 ? commScore  : null,
    problem_solving_score: stats.problemSolving.count      > 0 ? solveScore : null,
    experience_score:      stats.practicalExperience.count > 0 ? expScore   : null,
    strengths:             strengths.length  ? strengths  : ["Insufficient data to identify clear strengths — consider a follow-up screen"],
    weaknesses:            weaknesses.length ? weaknesses : ["No significant weaknesses identified in the areas assessed"],
    recommended_hire:      overall >= 6.5,
    hiring_decision:       hiringDecision,
    hiring_recommendation: hiringLabel[hiringDecision],
    questions_asked:       session.questionsAsked.length,
    summary,
    transcript:       session.history,
    timestamp:        new Date().toISOString(),
    duration_minutes: Math.round((Date.now() - session.startTime) / 60000),
  };
}
