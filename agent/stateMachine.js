// State Machine — Phase transitions and interview flow

import { PHASE, PHASE_QUESTION_COUNTS } from "../sessions/sessionManager.js";

export function advancePhase(session, action) {
  const phaseOrder = [PHASE.INTRODUCTION, PHASE.RESUME, PHASE.TECHNICAL, PHASE.BEHAVIORAL, PHASE.CLOSING, PHASE.DONE];
  const currentIdx = phaseOrder.indexOf(session.phase);

  // Manual transitions (action is transition or close)
  if (action === "transition" || action === "close") {
    let nextIdx = currentIdx + 1;

    // Skip phases based on interview type
    if (session.interviewType === "technical" && phaseOrder[nextIdx] === PHASE.BEHAVIORAL) {
      nextIdx++; // skip behavioral
    }
    if (session.interviewType === "hr" && phaseOrder[nextIdx] === PHASE.TECHNICAL) {
      nextIdx++; // skip technical
    }

    if (nextIdx < phaseOrder.length) {
      session.phase = phaseOrder[nextIdx];
      session.phaseStep = 0;
      session.followUpCount = 0;
      console.log(`[State] Phase transition -> ${session.phase}`);
    }

    if (action === "close" || session.phase === PHASE.DONE) {
      session.phase = PHASE.DONE;
      session.done = true;
    }
  } else if (action === "ask") {
    // New question in same phase
    session.phaseStep++;
    session.followUpCount = 0;
  } else if (action === "followup") {
    session.followUpCount++;
    // If follow-up limit reached, treat next action as a new question
    if (session.followUpCount >= session.maxFollowUps) {
      session.followUpCount = 0;
      session.phaseStep++;
    }
  }

  // Auto-transition if phase question limit reached
  const phaseLimits = session.phaseCounts;
  const limit = phaseLimits[session.phase];
  if (limit && session.phaseStep >= limit && action === "ask") {
    let nextPhaseIdx = phaseOrder.indexOf(session.phase) + 1;

    // Apply same interviewType skip logic as manual transitions
    if (nextPhaseIdx < phaseOrder.length) {
      if (session.interviewType === "technical" && phaseOrder[nextPhaseIdx] === PHASE.BEHAVIORAL) {
        nextPhaseIdx++;
      }
      if (session.interviewType === "hr" && phaseOrder[nextPhaseIdx] === PHASE.TECHNICAL) {
        nextPhaseIdx++;
      }
    }

    if (nextPhaseIdx < phaseOrder.length) {
      session.phase = phaseOrder[nextPhaseIdx];
      session.phaseStep = 0;
      session.followUpCount = 0;
      console.log(`[State] Auto-transition (limit reached) -> ${session.phase}`);
    }
  }
}
