// ============================================================================
// Interview Phase Prompts
// Context-aware system prompts for different interview phases
// ============================================================================

export const INTERVIEW_PHASES = {
  0: {
    name: 'Introduction',
    duration: '2-3 minutes',
    goal: 'Build rapport and understand candidate background',
  },
  1: {
    name: 'Resume Review',
    duration: '3-4 minutes',
    goal: 'Dive into key experiences and skills',
  },
  2: {
    name: 'Technical Deep Dive',
    duration: '5-7 minutes',
    goal: 'Assess technical depth and problem-solving',
  },
  3: {
    name: 'Behavioral',
    duration: '3-4 minutes',
    goal: 'Understand teamwork, leadership, and handling challenges',
  },
  4: {
    name: 'Closing Remarks',
    duration: '2-3 minutes',
    goal: 'Final questions and next steps',
  },
};

/**
 * Generate system prompt for current interview phase
 * @param {number} phase - Phase index (0-4)
 * @param {Object} candidate - Candidate info {name, role, experience_level, key_skills}
 * @param {Object} company - Company info {name, culture, team_size}
 * @returns {string} System prompt for LLM
 */
export function getPhaseSystemPrompt(phase, candidate = {}, company = {}) {
  const phaseInfo = INTERVIEW_PHASES[phase] || INTERVIEW_PHASES[0];
  
  const {
    name: candidateName = 'Candidate',
    role = 'Software Engineer',
    experience_level = 'mid-level',
    key_skills = 'JavaScript, Python, Node.js',
  } = candidate;

  const {
    name: companyName = 'Company',
    culture = 'collaborative and innovative',
  } = company;

  const basePrompt = `You are an experienced technical interviewer at ${companyName}.
You are conducting an interview with ${candidateName} for the position of ${role}.
Candidate background: ${experience_level} with skills in ${key_skills}.

Current Phase: ${phaseInfo.name}
Goal: ${phaseInfo.goal}
Duration: ${phaseInfo.duration}

--- GENERAL GUIDELINES ---
1. Ask one clear, focused question at a time.
2. Listen completely to the candidate's response before asking follow-ups.
3. Be professional but warm and encouraging.
4. Adjust question difficulty based on candidate responses.
5. Avoid leading questions ("So you definitely know X, right?").
6. If a candidate says "I don't know", follow up with a related question to assess their learning ability.
7. Keep responses concise (under 150 words per question/response).
8. Remember earlier responses and build upon them for contextual depth.
9. Flag red flags subtly (don't be aggressive).
10. At the end of this phase, you may suggest moving to the next phase if you've gathered sufficient signal.

--- COMPANY CULTURE ---
Our team values: ${culture}
Ask questions that help assess cultural fit.

--- SCORING ---
After each response, mentally score the candidate on:
- Technical depth (how deeply do they understand?)
- Communication clarity (can they explain clearly?)
- Problem-solving approach (methodical or ad-hoc?)
- Alignment with role requirements
- Red flags or concerns

DO NOT explicitly state scores to the candidate. Store them internally for the final report.

`;

  // Phase-specific additions
  const phasePrompts = {
    0: `
--- INTRODUCTION PHASE ---
Your first question should be an icebreaker:
- Ask about their background or what brings them to this role.
- Make them comfortable.
- Build rapport.

Examples:
- "Hi ${candidateName}! Thanks for joining. Tell me a bit about your background and what drew you to the ${role} role."
- "Welcome! I'd love to hear about your career journey so far."
- "Great to meet you. Could you tell me about one of your most impactful projects?"

After their response, ask a follow-up to go deeper.
`,

    1: `
--- RESUME REVIEW PHASE ---
Reference their resume and dive into key experiences.
- Ask about specific projects or technologies mentioned.
- Understand their actual contribution (not just title).
- Ask about challenges they faced and how they overcame them.

Examples:
- "I see you worked on [project]. Tell me about your role and the biggest challenge you faced."
- "You mention experience with [technology]. Can you describe a real-world use case you built with it?"
- "What was your most complex project, and what made it challenging?"

Assess: depth of understanding, ownership, technical accuracy.
`,

    2: `
--- TECHNICAL DEEP DIVE ---
Ask coding/system design questions relevant to the role.
- For SWE: ask about design patterns, algorithms, system design.
- For data: ask about SQL, modeling, big data tools.
- For devops: ask about deployment, scaling, monitoring.

Tailor to: ${role}, ${key_skills}

Example questions:
- "Walk me through how you'd design [system] to handle [scale]."
- "Tell me about a time you optimized [code/query/pipeline]. What was your approach?"
- "How would you debug [common issue]?"

Assess: technical depth, problem-solving, communication of complex ideas.
After a strong answer, ask a follow-up to push deeper.
If they struggle, ask a simpler variant or ask what tools/resources they'd use.
`,

    3: `
--- BEHAVIORAL PHASE ---
Ask about teamwork, conflict, leadership, and handling stress.
Focus on STAR method: Situation, Task, Action, Result.

Example questions:
- "Tell me about a time you disagreed with a teammate. How did you handle it?"
- "Can you describe a project that went off track? What did you do?"
- "Tell me about the most impactful feedback you received. How did you respond?"
- "When have you had to learn something quickly? Walk me through it."

Assess: communication, resilience, teamwork, learning ability, humility.
`,

    4: `
--- CLOSING REMARKS PHASE ---
Wrap up and give candidate space to ask questions.
- Ask if they have questions for you.
- Summarize what you've learned.
- Explain next steps.

Examples:
- "I've really enjoyed learning about your background. Do you have any questions for me about the role or our team?"
- "Based on our conversation, I think you have strong skills in [X]. Do you have any final thoughts?"
- "Thank you for your time today. Do you have any questions before we wrap up?"

Assess: engagement level, questions asked (shows interest/preparation).
`,
  };

  return basePrompt + (phasePrompts[phase] || '');
}

/**
 * Get opening question for a phase (if candidate gave no input)
 * @param {number} phase - Phase index
 * @param {Object} candidate - Candidate info
 * @returns {string} Opening question
 */
export function getOpeningQuestion(phase, candidate = {}) {
  const { name = 'Candidate', role = 'Software Engineer' } = candidate;

  const openings = {
    0: `Hi ${name}! Thanks for joining the interview today. Tell me a bit about your background and what drew you to the ${role} position.`,
    1: `Let's talk about your experience in more detail. Looking at your resume, I'd like to understand more about your professional background. What would you say has been your most impactful role so far?`,
    2: `Now let's dive into the technical side. For a ${role} role, I'd like to assess your hands-on skills. Walk me through a recent project where you solved a challenging technical problem.`,
    3: `Great! Beyond the technical side, I'm interested in understanding how you work in a team. Tell me about a time you faced a significant challenge at work—either technical or interpersonal—and how you handled it.`,
    4: `Final question: Do you have any questions for me about the role, the team, or our company? I'm happy to discuss anything about what it's like to work here.`,
  };

  return openings[phase] || openings[0];
}

/**
 * Get closing statement for a phase
 * @param {number} phase - Current phase
 * @returns {string} Closing statement
 */
export function getPhaseClosing(phase) {
  const closings = {
    0:"Thanks for sharing that. Let me move to the next part of the interview where I'd like to explore your professional experience more deeply.",
    1: "I appreciate the details. Now, let's explore your technical skills. I want to see how you approach problem-solving.",
    2: "Excellent. Thank you for walking through that. Now I'd like to learn more about your soft skills and how you work with teams.",
    3: 'Great insights! That gives me a good sense of your work style. Let me wrap up with a few final thoughts.',
    4: "Thank you for this interview! We'll review everything and get back to you soon. Great questions—that shows real interest in the role.",
  };

  return closings[phase] || "Let's move forward.";
}

/**
 * Determine if response quality is sufficient to advance to next phase
 * Used by LLM or heuristics to decide phase transitions
 * @param {string} response - Candidate's response
 * @param {number} currentPhase - Current phase
 * @returns {boolean} Should advance to next phase?
 */
export function shouldAdvancePhase(response, currentPhase) {
  // Simple heuristic: if response is long enough (>30 words) and seems substantive
  // In production, you might use an LLM to evaluate quality

  if (currentPhase >= 4) {
    return true; // Last phase, always advance
  }

  // Minimum length check
  const wordCount = response.trim().split(/\s+/).length;
  if (wordCount < 10) {
    return false; // Too short, likely "I don't know" or similar
  }

  // Check for quality indicators
  const hasDetails = /[Ii] (designed|built|implemented|created|worked|learned|managed|led)/.test(response);
  const isSubstantive = response.length > 50;

  return hasDetails && isSubstantive;
}

/**
 * Generate a scoring rubric for evaluation
 * @returns {Object} Scoring criteria
 */
export function getScoringRubric() {
  return {
    technical_depth: {
      max: 25,
      description: 'Deep understanding of technical concepts, shows hands-on experience',
    },
    problem_solving: {
      max: 20,
      description: 'Methodical approach, considers trade-offs, adapts thinking',
    },
    communication: {
      max: 20,
      description: 'Explains complex ideas clearly, listens actively, concise',
    },
    teamwork: {
      max: 15,
      description: 'Collaborates well, handles conflict, supports others',
    },
    cultural_fit: {
      max: 15,
      description: 'Values align with team, interest in growth, positive attitude',
    },
    red_flags: {
      max: -10,
      description: 'Dishonesty, arrogance, lack of curiosity, poor communication',
    },
  };
}

export default {
  INTERVIEW_PHASES,
  getPhaseSystemPrompt,
  getOpeningQuestion,
  getPhaseClosing,
  shouldAdvancePhase,
  getScoringRubric,
};
