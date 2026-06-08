# pi-loop-designer

Prompt less. Loop more.

Pi extension for turning raw coding goal into repeatable agent loop. One command makes prompt system with objective, state, iteration prompt, verification, reflection, stop rules, next prompt.

## Install

```bash
pi install npm:pi-loop-designer
```

Git fallback:

```bash
pi install git:github.com/byigitt/pi-loop-designer
```

Then restart pi or run `/reload`.

## Use

```text
/loop build auth audit flow
```

Agent designs loop, then saves blueprint with `loop_designer` tool.

Fast prefix also works:

```text
loop: make dashboard feel premium without breaking data loading
#loop fix flaky checkout tests
```

Draft only:

```text
/loop-draft ship dark mode safely
```

Saved loops:

```text
/loop-list
/loop-next
/loop-next 2
```

## What extension adds

- `/loop <objective>` — submit loop-design prompt now.
- `/loop-draft <objective>` — put loop-design prompt in editor.
- `/loop-list` — copy saved loop blueprints into editor.
- `/loop-next [id]` — copy next agent prompt from active loop.
- `loop:` and `#loop` input prefixes — transform plain text into loop prompt.
- `loop_designer` tool — save, list, checkpoint loop blueprints.
- `/design-loop` prompt template — same loop mode from prompt autocomplete.
- `loop-designer` skill — agent behavior guide for loop-first work.

## Loop shape

Good loop has:

1. Objective — done state, not activity.
2. State model — memory between iterations.
3. Iteration prompt — reusable prompt for next agent pass.
4. Verification — commands, checks, evidence.
5. Reflection cadence — when loop inspects results and adapts.
6. Stop rules — done, blocked, unsafe, human-needed.
7. Next prompt — exact prompt to send now.

## Local dev

```bash
pnpm install
pnpm exec tsgo --noEmit
pnpm exec oxlint
```

## Why

Monthly reminder: stop prompting coding agents one task at a time. Design loop. Loop prompts agents. Agents make progress. Evidence decides done.
