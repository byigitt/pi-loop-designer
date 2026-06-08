---
name: loop-designer
description: Use when the user wants to stop one-shot prompting and design repeatable or automated loops that prompt coding agents through iterations, verification, reflection, checkpointing, and stop conditions.
---

# Loop Designer

Use this skill when the user asks for an agent loop, durable prompt system, iteration plan, autonomous coding workflow, Ralph-like loop, or anything close to: "design loops that prompt agents."

## Core move

Do not jump straight to implementation. First design the loop that will drive implementation.

A strong loop has:

1. **Objective** — concrete end state, not busywork.
2. **State model** — what each iteration remembers: files, evidence, blockers, decisions, next prompt.
3. **Iteration prompt** — reusable prompt sent to the next agent turn or child agent.
4. **Verification** — commands, tests, reviews, UI checks, artifacts, or acceptance evidence.
5. **Reflection cadence** — when to inspect evidence and adjust strategy.
6. **Stop rules** — done, blocked, unsafe, scope drift, or needs-human-decision.
7. **Next prompt** — exact first prompt to send now.

## Behavior

- Ask at most 3 clarifying questions if missing info blocks loop design.
- Prefer measurable acceptance criteria over vague success language.
- Include guardrails for destructive commands, secrets, production access, and runaway loops.
- If `loop_designer` is available, save the blueprint with action `save`.
- If the user asks to start automatically, use `autoStart: true` and a safe `maxIterations` value.
- For automated loops, every iteration must end with `loop_designer` action `checkpoint`.
- Checkpoint statuses:
  - `done`: acceptance criteria met; stop.
  - `continue`: more low-risk work remains; include `continueLoop: true` and a concrete `nextAgentPrompt`.
  - `blocked`: user input, credentials, risky decision, or approval needed; stop.
  - `paused`: stop without marking complete.
- If work is already inside a loop, checkpoint progress instead of starting a new loop.
- For implementation loops, require verification after each iteration.
- For design loops, require critique/refine passes and final artifact review.

## Commands

- `/loop <objective>` designs and saves a loop.
- `/loop-run [--max N] <objective>` designs, saves, and auto-starts bounded iterations.
- `/loop-start [id] [--max N]` starts a saved loop.
- `/loop-stop` pauses a running loop.
- `loop!:` and `#loop!` are fast auto-run prefixes.

## Output shape

When not using the tool, output:

```markdown
# Loop: <title>

## Objective

<done state>

## State Model

<what persists between iterations>

## Iteration Prompt

<copy-paste prompt template>

## Verification

- <check>

## Reflection Cadence

<when to review and adapt>

## Stop Rules

- <condition>

## Risks / Guardrails

- <risk>

## Next Agent Prompt

<first prompt to send>
```
