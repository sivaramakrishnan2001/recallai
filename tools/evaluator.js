// Answer Evaluator — Parse LLM responses, extract scores, generate reports

// Improved regex that handles special characters in question field
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
 * Parse LLM Response — Uses pre-compiled regex for performance
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
 * Record scores — Optimized to only add non-zero values
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
 * Calculate average — Uses pre-optimized stats calculation
 */
export function avg(arr) {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10;
}

/**
 * Generate Report — Optimized to calculate all averages in one pass
 * Applies proper weighting: Technical(40%) + Communication(20%) + Experience(20%) + ProblemSolving(20%)
 */
export function generateReport(session) {
  // Calculate all score averages efficiently
  const stats = calculateAllScoreAverages(session.scores);
  
  const commScore = stats.communication.avg;
  const techScore = stats.technicalKnowledge.avg;
  const solveScore = stats.problemSolving.avg;
  const expScore = stats.practicalExperience.avg;

  // Calculate weighted overall score
  // Only include dimensions that were actually tested (have scores)
  let overall = 0;
  if (stats.communication.count > 0 || stats.technicalKnowledge.count > 0 || 
      stats.problemSolving.count > 0 || stats.practicalExperience.count > 0) {
    
    // Apply weighted calculation
    let weightedSum = 0;
    let totalWeight = 0;
    
    if (stats.communication.count > 0) {
      weightedSum += commScore * 0.20;
      totalWeight += 0.20;
    }
    if (stats.technicalKnowledge.count > 0) {
      weightedSum += techScore * 0.40;
      totalWeight += 0.40;
    }
    if (stats.problemSolving.count > 0) {
      weightedSum += solveScore * 0.20;
      totalWeight += 0.20;
    }
    if (stats.practicalExperience.count > 0) {
      weightedSum += expScore * 0.20;
      totalWeight += 0.20;
    }
    
    // Normalize to 0-100 scale
    overall = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
  }

  const strengths  = [];
  const weaknesses = [];

  // Only report strengths/weaknesses for dimensions that were actually tested
  if (stats.communication.count > 0) {
    if (commScore >= 7) strengths.push("Strong communication skills");
    if (commScore < 5)  weaknesses.push("Communication needs improvement");
  }
  if (stats.technicalKnowledge.count > 0) {
    if (techScore >= 7) strengths.push("Solid technical knowledge");
    if (techScore < 5)  weaknesses.push("Technical knowledge gaps");
  }
  if (stats.problemSolving.count > 0) {
    if (solveScore >= 7) strengths.push("Good problem-solving approach");
    if (solveScore < 5)  weaknesses.push("Problem-solving could be stronger");
  }
  if (stats.practicalExperience.count > 0) {
    if (expScore >= 7) strengths.push("Relevant practical experience");
    if (expScore < 5)  weaknesses.push("Limited practical experience demonstrated");
  }

  return {
    candidate_name:     session.candidateName,
    role:               session.role,
    difficulty:         session.difficulty,
    interview_type:     session.interviewType,
    overall_score:      overall,  // Numeric 0–10 (weighted avg of dimension scores)
    overall_score_str:  `${overall}/10`,
    technical_score:    stats.technicalKnowledge.count  > 0 ? techScore : null,
    communication_score: stats.communication.count     > 0 ? commScore : null,
    problem_solving_score: stats.problemSolving.count  > 0 ? solveScore : null,
    experience_score:   stats.practicalExperience.count > 0 ? expScore : null,
    strengths:          strengths.length ? strengths : ["No clear strengths identified"],
    weaknesses:         weaknesses.length ? weaknesses : ["No clear weaknesses identified"],
    recommended_hire:   overall >= 6,
    hiring_decision: overall >= 7.5 ? "STRONG_YES" : overall >= 6 ? "YES" : overall >= 4.5 ? "MAYBE" : "NO",
    questions_asked:    session.questionsAsked.length,
    summary: overall >= 7.5
      ? `${session.candidateName} demonstrated strong skills across the board for the ${session.role} role. Recommend proceeding to next round.`
      : overall >= 6
        ? `${session.candidateName} showed solid potential. Consider moving forward for further evaluation.`
        : overall >= 4.5
          ? `${session.candidateName} showed some potential but has areas for improvement. Consider a follow-up interview.`
          : `${session.candidateName} did not meet the threshold for the ${session.role} role at this time.`,
    transcript: session.history,
    timestamp: new Date().toISOString(),
    duration_minutes: Math.round((Date.now() - session.startTime) / 60000),
  };
}
