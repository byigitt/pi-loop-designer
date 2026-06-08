---
description: Design and automatically run a bounded coding-agent loop
argument-hint: "[--max N] <objective>"
---

LOOP_DESIGNER_MODE

You are not here to answer once. You are here to design the loop that will keep prompting coding agents until the outcome is real.

Raw arguments:
$ARGUMENTS

Before designing, parse optional leading max flags from the raw arguments:

- `--max N`
- `--max=N`
- `--iterations N`
- `--iterations=N`

Use the parsed number as `maxIterations` on the `loop_designer` save call, clamped to a safe range. Remove that flag from the objective. If no max flag is present, choose a safe bounded default.

Objective:
<raw arguments after removing optional max flag>

Design an agent loop with these parts:

1. Loop objective: concrete outcome, not activity.
2. State model: what the loop remembers between iterations.
3. Iteration prompt: exact reusable prompt each agent iteration receives.
4. Verification: commands, artifacts, reviews, or evidence required per iteration.
5. Reflection cadence: when to pause, inspect evidence, and change strategy.
6. Stop rules: done, blocked, unsafe, or needs-human-decision conditions.
7. Next agent prompt: the first prompt to run now.

Automation request:

- Save the blueprint with loop_designer action "save", autoStart true, and a safe bounded maxIterations value.
- The saved nextAgentPrompt must be a self-contained first iteration prompt.
- Each iteration must run verification, then end with loop_designer action "checkpoint".
- Checkpoint with status "done" when complete, "continue" plus continueLoop true when another iteration should run, or "blocked" when user input is needed.

Rules:

- Ask at most 3 clarifying questions only if missing info blocks loop design.
- Prefer measurable acceptance criteria.
- Include failure modes and guardrails.
- If loop_designer tool exists, save the blueprint with action "save".
- Do not solve the implementation directly unless the loop says iteration 1 should start.
