# pi-loop-designer

Prompt less. Loop more.

Pi extension for turning raw coding goal into repeatable agent loop. It can either save a loop blueprint, or auto-run bounded iterations like a tiny Ralph-style loop: prompt agent, run verification, checkpoint, continue only if needed.

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

Design only:

```text
/loop build auth audit flow
```

Auto-run bounded loop:

```text
/loop-run --max 5 make this package feel more like Clanker without adding cloud complexity
```

Fast prefixes:

```text
loop: make dashboard feel premium without breaking data loading
loop!: fix flaky checkout tests and keep iterating until verified
#loop! ship safe npm publish flow --max 3
```

What happens in auto-run:

1. Agent designs loop.
2. Agent saves blueprint with `loop_designer` and `autoStart: true`.
3. Extension queues iteration 1.
4. Agent does one bounded iteration and runs verification.
5. Agent checkpoints with `status: done | continue | blocked`.
6. If `continue`, extension queues next iteration until max reached.

Manual controls:

```text
/loop-draft ship dark mode safely
/loop-list
/loop-next
/loop-next 2
/loop-start
/loop-start 2 --max 4
/loop-stop
```

## What extension adds

- `/loop <objective>` — submit loop-design prompt now.
- `/loop-run [--max N] <objective>` — design and auto-run bounded loop iterations.
- `/loop-draft <objective>` — put loop-design prompt in editor.
- `/loop-list` — copy saved loop blueprints into editor.
- `/loop-next [id]` — copy next agent prompt from active loop.
- `/loop-start [id] [--max N]` — auto-run a saved loop.
- `/loop-stop` — pause active auto-run loop.
- `loop:` and `#loop` input prefixes — transform plain text into loop prompt.
- `loop!:` and `#loop!` input prefixes — transform plain text into auto-run loop prompt.
- `loop_designer` tool — save, list, checkpoint, pause loop blueprints.
- `/design-loop` prompt template — design-only loop mode from prompt autocomplete.
- `/run-loop` prompt template — auto-run loop mode from prompt autocomplete.
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

## Safety

Auto-run is bounded. Default max is 5 iterations, hard cap is 25. Each iteration must checkpoint. The loop pauses when done, blocked, missing next prompt, or max iterations reached.

## Local dev

```bash
pnpm install
pnpm exec tsgo --noEmit
pnpm exec oxlint
pnpm pack --dry-run
```

## Why

Monthly reminder: stop prompting coding agents one task at a time. Design loop. Loop prompts agents. Agents make progress. Evidence decides done.
