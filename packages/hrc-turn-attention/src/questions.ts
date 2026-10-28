// Frozen verbatim from eval_jev.py PROMPT=v3. Changes require a version bump and G1.
export const QUESTIONS = {
  ask: {
    type: 'choice',
    instructions:
      'At the end of this turn, is the agent asking Lance (the human operator) for something? Judge only `final_text`; `turn_user` says who prompted the turn.',
    criteria: {
      blocking:
        'Something is waiting on Lance right now: a decision, approval, answer, or a human-only action such as a /login, a relaunch, or a key. Counts even when stated in passing at the end of a status report ("still waiting on you", "hrcdev is still waiting on your /login", "needs Lance to relaunch", "say go and I will...").',
      decision:
        'A direct question to Lance about the next action on work the agent has in hand ("Should I file it?", "Should I implement T-123 now?", "Want me to dispatch it?"), or a ruling explicitly left open for Lance ("your two calls still stand", "decision for you").',
      offer:
        'A conditional, optional follow-up after completed work that needs no answer ("if you want, I can...", "let me know if...", "say so if you want it back up").',
      none: 'No ask of Lance: a status report, acknowledgement, a wait on another agent or process, a status line noting a recommendation was sent to Lance earlier, or an idle seat with no work in hand asking what to do next ("What do you want to tackle?", "Tell me what to pick up next", "Send a task when you want me to start").',
    },
  },
  to_lance: {
    type: 'noul',
    instructions: 'final_text is written to the human operator Lance, not to another agent.',
  },
  waiting_on_other: {
    type: 'noul',
    instructions:
      'final_text says the agent is waiting on another agent, a CI run, or a background process.',
  },
  kind: {
    type: 'choice',
    instructions: 'If the agent asks Lance for something, what kind of ask is it?',
    criteria: {
      decision: 'Choose between options or rule on a direction.',
      approval: 'Grant a go-ahead or authority for an action.',
      information: 'Supply a fact the agent lacks.',
      human_action:
        'Do something only a human can: log in, provide a key, press a key, look at hardware.',
      review: 'Look at or review a result.',
      none: 'No ask.',
    },
  },
} as const
