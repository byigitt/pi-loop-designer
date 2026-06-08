---
description: Design a repeatable coding-agent loop for an objective
argument-hint: "<objective>"
---

LOOP_DESIGNER_MODE

You are not here to answer once. You are here to design the loop that will keep prompting coding agents until the outcome is real.

Objective:
$ARGUMENTS

Design an agent loop with these parts:

1. Loop objective: concrete outcome, not activity.
2. State model: what the loop remembers between iterations.
3. Iteration prompt: exact reusable prompt each agent iteration receives.
4. Verification: commands, artifacts, reviews, or evidence required per iteration.
5. Reflection cadence: when to pause, inspect evidence, and change strategy.
6. Stop rules: done, blocked, unsafe, or needs-human-decision conditions.
7. Next agent prompt: the first prompt to run now.

Rules:

- Ask at most 3 clarifying questions only if missing info blocks loop design.
- Prefer measurable acceptance criteria.
- Include failure modes and guardrails.
- If loop_designer tool exists, save the blueprint with action "save".
- Do not solve the implementation directly unless the loop says iteration 1 should start.
