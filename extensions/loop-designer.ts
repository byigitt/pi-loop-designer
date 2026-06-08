import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const baseDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(baseDir);
const DEFAULT_MAX_ITERATIONS = 5;
const MAX_AUTOMATED_ITERATIONS = 25;

const LoopDesignerParamsSchema = Type.Object({
  action: StringEnum(["save", "checkpoint", "list", "pause"] as const),
  id: Type.Optional(Type.Number({ description: "Existing loop id. Omit to use the active loop." })),
  title: Type.Optional(Type.String({ description: "Short name for the loop blueprint." })),
  objective: Type.Optional(Type.String({ description: "Outcome this agent loop should achieve." })),
  loopPrompt: Type.Optional(
    Type.String({ description: "Top-level prompt that defines the whole loop." }),
  ),
  iterationPrompt: Type.Optional(
    Type.String({ description: "Reusable prompt for each loop iteration." }),
  ),
  stateModel: Type.Optional(
    Type.String({ description: "What state the loop tracks between iterations." }),
  ),
  acceptanceCriteria: Type.Optional(
    Type.Array(Type.String(), { description: "Definition of done bullets." }),
  ),
  verificationSteps: Type.Optional(
    Type.Array(Type.String(), { description: "Commands or checks each iteration should run." }),
  ),
  stopRules: Type.Optional(
    Type.Array(Type.String(), { description: "Conditions that stop the loop." }),
  ),
  reflectionCadence: Type.Optional(
    Type.String({ description: "When the loop reflects, reviews, or changes strategy." }),
  ),
  nextAgentPrompt: Type.Optional(
    Type.String({ description: "Concrete next prompt to send to an agent." }),
  ),
  progress: Type.Optional(Type.String({ description: "Checkpoint note for action=checkpoint." })),
  status: Type.Optional(
    StringEnum(["continue", "done", "blocked", "paused"] as const, {
      description:
        "Checkpoint outcome. Use continue only when another automated iteration should run.",
    }),
  ),
  autoStart: Type.Optional(
    Type.Boolean({ description: "After saving, immediately queue the first loop iteration." }),
  ),
  continueLoop: Type.Optional(
    Type.Boolean({
      description: "After checkpointing, queue the next iteration if safe and under maxIterations.",
    }),
  ),
  maxIterations: Type.Optional(
    Type.Number({
      description: `Maximum automated iterations before pausing. Default ${DEFAULT_MAX_ITERATIONS}. Hard cap ${MAX_AUTOMATED_ITERATIONS}.`,
    }),
  ),
  risks: Type.Optional(
    Type.Array(Type.String(), { description: "Known failure modes or guardrails." }),
  ),
});

type LoopDesignerParams = Static<typeof LoopDesignerParamsSchema>;
type LoopAction = LoopDesignerParams["action"];
type CheckpointStatus = NonNullable<LoopDesignerParams["status"]>;
type LoopStatus = "draft" | "running" | "paused" | "done" | "blocked";

interface LoopCheckpoint {
  text: string;
  createdAt: string;
  status?: CheckpointStatus;
}

interface LoopRecord {
  id: number;
  title: string;
  objective: string;
  loopPrompt: string;
  iterationPrompt: string;
  stateModel: string;
  acceptanceCriteria: string[];
  verificationSteps: string[];
  stopRules: string[];
  reflectionCadence: string;
  nextAgentPrompt: string;
  risks: string[];
  checkpoints: LoopCheckpoint[];
  updatedAt: string;
  autoRun: boolean;
  maxIterations: number;
  runCount: number;
  status: LoopStatus;
}

interface LoopDesignerDetails {
  action: LoopAction;
  loops: LoopRecord[];
  nextId: number;
  activeId?: number;
  error?: string;
  queuedNext?: boolean;
}

interface LoopPromptOptions {
  autoRun?: boolean;
  maxIterations?: number;
}

interface ParsedRunArgs {
  objective: string;
  maxIterations: number;
  maxSpecified: boolean;
}

const LOOP_MODE_MARKER = "LOOP_DESIGNER_MODE";
const LOOP_RUNNER_MARKER = "LOOP_RUNNER_MODE";
const LOOP_STATE_ENTRY = "loop-designer-state";

const LOOP_SYSTEM_APPEND = `

## Loop Designer Mode

The user is asking for an agent loop, not a one-shot answer. Design a repeatable loop that prompts agents.
- Convert the objective into loop state, iteration prompt, verification, reflection cadence, and stop rules.
- Prefer explicit acceptance criteria over vague success language.
- If a coding task is already clear, include commands/checks the loop should run each iteration.
- Use loop_designer with action "save" when you have a concrete loop blueprint.
- When the prompt asks for automation, save with autoStart true and a bounded maxIterations value.
- Do not hide uncertainty. Add risks and human decision points when the loop needs them.
`;

const LOOP_RUNNER_APPEND = `

## Loop Runner Mode

You are inside an automated loop iteration. Do one bounded iteration, verify it, then checkpoint.
- Make real progress when the task is clear. Do not only restate the plan.
- Run the verification commands or explain why a command is not applicable.
- End the iteration by calling loop_designer with action "checkpoint".
- Use status "done" when acceptance criteria are met.
- Use status "continue" and continueLoop true only when another low-risk iteration is clearly needed.
- Use status "blocked" when user input, credentials, production approval, or a risky decision is required.
- Never continue past maxIterations. Prefer a blocked/paused checkpoint over runaway looping.
`;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fallbackTitle(objective: string | undefined): string {
  const cleaned = compactWhitespace(objective ?? "Agent loop");
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}...` : cleaned || "Agent loop";
}

function asList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function clampMaxIterations(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ITERATIONS;
  return Math.max(1, Math.min(MAX_AUTOMATED_ITERATIONS, Math.floor(value)));
}

function resolveLoopId(
  params: LoopDesignerParams,
  activeLoopId: number | undefined,
): number | undefined {
  return params.id ?? activeLoopId;
}

function parseRunArgs(args: string): ParsedRunArgs {
  let objective = args.trim();
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let maxSpecified = false;

  objective = objective.replace(/(?:^|\s)--max(?:=|\s+)(\d+)/i, (_match, value: string) => {
    maxIterations = clampMaxIterations(Number(value));
    maxSpecified = true;
    return " ";
  });

  objective = objective.replace(/(?:^|\s)--iterations(?:=|\s+)(\d+)/i, (_match, value: string) => {
    maxIterations = clampMaxIterations(Number(value));
    maxSpecified = true;
    return " ";
  });

  return { objective: compactWhitespace(objective), maxIterations, maxSpecified };
}

function buildLoopPrompt(objective: string, options: LoopPromptOptions = {}): string {
  const cleanObjective = objective.trim() || "<describe objective here>";
  const maxIterations = clampMaxIterations(options.maxIterations);
  const automation = options.autoRun
    ? `

Automation request:
- Save the blueprint with loop_designer action "save", autoStart true, and maxIterations ${maxIterations}.
- The saved nextAgentPrompt must be a self-contained first iteration prompt.
- Each iteration must run verification, then end with loop_designer action "checkpoint".
- Checkpoint with status "done" when complete, "continue" plus continueLoop true when another iteration should run, or "blocked" when user input is needed.`
    : "";

  return `${LOOP_MODE_MARKER}

You are not here to answer once. You are here to design the loop that will keep prompting coding agents until the outcome is real.

Objective:
${cleanObjective}

Design an agent loop with these parts:
1. Loop objective: concrete outcome, not activity.
2. State model: what the loop remembers between iterations.
3. Iteration prompt: exact reusable prompt each agent iteration receives.
4. Verification: commands, artifacts, reviews, or evidence required per iteration.
5. Reflection cadence: when to pause, inspect evidence, and change strategy.
6. Stop rules: done, blocked, unsafe, or needs-human-decision conditions.
7. Next agent prompt: the first prompt to run now.${automation}

Rules:
- Ask at most 3 clarifying questions only if missing info blocks loop design.
- Prefer measurable acceptance criteria.
- Include failure modes and guardrails.
- If loop_designer tool exists, save the blueprint with action "save".
- Do not solve the implementation directly unless the loop says iteration 1 should start.`;
}

function buildRunnerPrompt(loop: LoopRecord, iterationNumber: number): string {
  const acceptance = loop.acceptanceCriteria.length
    ? loop.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
    : "- Acceptance criteria were not explicit. Derive concrete evidence from the objective and stop rules.";
  const verification = loop.verificationSteps.length
    ? loop.verificationSteps.map((item) => `- ${item}`).join("\n")
    : "- Run the smallest relevant verification for the files/artifacts changed. If none apply, explain why.";
  const stopRules = loop.stopRules.length
    ? loop.stopRules.map((item) => `- ${item}`).join("\n")
    : "- Stop when done, blocked, unsafe, or max iterations is reached.";

  return `${LOOP_RUNNER_MARKER}

You are running iteration ${iterationNumber}/${loop.maxIterations} of loop #${loop.id}: ${loop.title}.

## Objective
${loop.objective}

## State Model
${loop.stateModel}

## Iteration Prompt
${loop.iterationPrompt}

## Planned Next Agent Prompt
${loop.nextAgentPrompt}

## Acceptance Criteria
${acceptance}

## Verification Required
${verification}

## Stop Rules
${stopRules}

## Previous Checkpoints
${
  loop.checkpoints.length
    ? loop.checkpoints
        .map(
          (checkpoint, index) =>
            `- ${index + 1}. [${checkpoint.status ?? "checkpoint"}] ${checkpoint.text}`,
        )
        .join("\n")
    : "- No previous checkpoints."
}

## Required closeout
Do one bounded iteration now. Make real changes if needed. Run verification. Then call loop_designer with action "checkpoint" and:
- progress: concise summary with evidence and commands run.
- status: "done" if acceptance is met, "continue" if more low-risk work remains, or "blocked" if human input/risk/credentials are needed.
- continueLoop: true only when status is "continue" and iteration ${iterationNumber} is below maxIterations ${loop.maxIterations}.
- nextAgentPrompt: exact next iteration prompt when continuing.

Do not skip checkpoint. Do not keep looping manually inside this same response.`;
}

function renderBulletSection(title: string, values: string[]): string[] {
  if (values.length === 0) return [];
  return [`## ${title}`, ...values.map((value) => `- ${value}`), ""];
}

function renderLoopMarkdown(loop: LoopRecord): string {
  const checkpointLines = loop.checkpoints.length
    ? [
        "## Checkpoints",
        ...loop.checkpoints.map((checkpoint, index) => {
          const status = checkpoint.status ? `[${checkpoint.status}] ` : "";
          return `- ${index + 1}. ${status}${checkpoint.text} (${checkpoint.createdAt})`;
        }),
        "",
      ]
    : [];

  return [
    `# ${loop.title}`,
    "",
    `Loop #${loop.id} · ${loop.status} · updated ${loop.updatedAt}`,
    `Auto-run: ${loop.autoRun ? `on (${loop.runCount}/${loop.maxIterations})` : "off"}`,
    "",
    "## Objective",
    loop.objective,
    "",
    "## State Model",
    loop.stateModel ||
      "Track goal, current hypothesis, changed files, commands run, findings, blockers, next prompt.",
    "",
    "## Loop Prompt",
    loop.loopPrompt,
    "",
    "## Iteration Prompt",
    loop.iterationPrompt,
    "",
    ...renderBulletSection("Acceptance Criteria", loop.acceptanceCriteria),
    ...renderBulletSection("Verification", loop.verificationSteps),
    "## Reflection Cadence",
    loop.reflectionCadence || "Reflect after every 2 iterations or after any failed verification.",
    "",
    ...renderBulletSection("Stop Rules", loop.stopRules),
    ...renderBulletSection("Risks / Guardrails", loop.risks),
    "## Next Agent Prompt",
    loop.nextAgentPrompt,
    "",
    ...checkpointLines,
  ].join("\n");
}

function renderLoopListMarkdown(loops: LoopRecord[]): string {
  if (loops.length === 0)
    return "No loops saved yet. Run `/loop <objective>` or `/loop-run <objective>`.";
  return [
    "# Saved Agent Loops",
    "",
    ...loops.flatMap((loop) => [
      `## #${loop.id} ${loop.title}`,
      `- Status: ${loop.status}`,
      `- Auto-run: ${loop.autoRun ? `on (${loop.runCount}/${loop.maxIterations})` : "off"}`,
      `- Objective: ${loop.objective}`,
      `- Updated: ${loop.updatedAt}`,
      `- Checkpoints: ${loop.checkpoints.length}`,
      `- Next: ${loop.nextAgentPrompt || "not set"}`,
      "",
    ]),
  ].join("\n");
}

function normalizeCheckpoint(input: unknown): LoopCheckpoint | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as Partial<LoopCheckpoint>;
  if (typeof candidate.text !== "string" || typeof candidate.createdAt !== "string") {
    return undefined;
  }
  return {
    text: candidate.text,
    createdAt: candidate.createdAt,
    status: candidate.status,
  };
}

function normalizeLoop(input: unknown): LoopRecord | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as Partial<LoopRecord>;
  if (typeof candidate.id !== "number") return undefined;

  return {
    id: candidate.id,
    title:
      typeof candidate.title === "string" ? candidate.title : fallbackTitle(candidate.objective),
    objective: typeof candidate.objective === "string" ? candidate.objective : "",
    loopPrompt: typeof candidate.loopPrompt === "string" ? candidate.loopPrompt : "",
    iterationPrompt: typeof candidate.iterationPrompt === "string" ? candidate.iterationPrompt : "",
    stateModel: typeof candidate.stateModel === "string" ? candidate.stateModel : "",
    acceptanceCriteria: Array.isArray(candidate.acceptanceCriteria)
      ? candidate.acceptanceCriteria
      : [],
    verificationSteps: Array.isArray(candidate.verificationSteps)
      ? candidate.verificationSteps
      : [],
    stopRules: Array.isArray(candidate.stopRules) ? candidate.stopRules : [],
    reflectionCadence:
      typeof candidate.reflectionCadence === "string" ? candidate.reflectionCadence : "",
    nextAgentPrompt: typeof candidate.nextAgentPrompt === "string" ? candidate.nextAgentPrompt : "",
    risks: Array.isArray(candidate.risks) ? candidate.risks : [],
    checkpoints: Array.isArray(candidate.checkpoints)
      ? candidate.checkpoints.map(normalizeCheckpoint).filter((item) => item !== undefined)
      : [],
    updatedAt:
      typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
    autoRun: candidate.autoRun === true,
    maxIterations: clampMaxIterations(candidate.maxIterations),
    runCount:
      typeof candidate.runCount === "number" && Number.isFinite(candidate.runCount)
        ? Math.max(0, Math.floor(candidate.runCount))
        : 0,
    status:
      candidate.status === "running" ||
      candidate.status === "paused" ||
      candidate.status === "done" ||
      candidate.status === "blocked"
        ? candidate.status
        : "draft",
  };
}

function updateStatus(
  ctx: ExtensionContext,
  loops: LoopRecord[],
  activeLoopId: number | undefined,
): void {
  if (!ctx.hasUI) return;
  const active = loops.find((loop) => loop.id === activeLoopId);
  ctx.ui.setStatus(
    "loop-designer",
    active
      ? `loop #${active.id}: ${active.status}${active.autoRun ? ` ${active.runCount}/${active.maxIterations}` : ""}`
      : "loop: /loop",
  );
}

export default function loopDesigner(pi: ExtensionAPI) {
  let loops: LoopRecord[] = [];
  let nextId = 1;
  let activeLoopId: number | undefined;

  function reconstructState(ctx: ExtensionContext): void {
    loops = [];
    nextId = 1;
    activeLoopId = undefined;

    const applyDetails = (details: Partial<LoopDesignerDetails> | undefined): void => {
      if (!details || !Array.isArray(details.loops)) return;

      loops = details.loops.map(normalizeLoop).filter((loop) => loop !== undefined);
      nextId =
        typeof details.nextId === "number"
          ? details.nextId
          : Math.max(1, ...loops.map((loop) => loop.id + 1));
      activeLoopId = typeof details.activeId === "number" ? details.activeId : activeLoopId;
    };

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message") {
        const message = entry.message;
        if (message.role !== "toolResult" || message.toolName !== "loop_designer") continue;
        applyDetails(message.details as Partial<LoopDesignerDetails> | undefined);
        continue;
      }

      if (entry.type === "custom" && entry.customType === LOOP_STATE_ENTRY) {
        applyDetails(entry.data as Partial<LoopDesignerDetails> | undefined);
      }
    }

    updateStatus(ctx, loops, activeLoopId);
  }

  function snapshot(action: LoopAction, error?: string, queuedNext = false): LoopDesignerDetails {
    return {
      action,
      loops: loops.map((loop) => ({ ...loop, checkpoints: [...loop.checkpoints] })),
      nextId,
      activeId: activeLoopId,
      error,
      queuedNext,
    };
  }

  function persistState(action: LoopAction, error?: string, queuedNext = false): void {
    pi.appendEntry(LOOP_STATE_ENTRY, snapshot(action, error, queuedNext));
  }

  function queueNextLoopIteration(loop: LoopRecord, ctx: ExtensionContext): boolean {
    if (!loop.nextAgentPrompt.trim()) return false;
    if (loop.runCount >= loop.maxIterations) {
      loop.autoRun = false;
      loop.status = "paused";
      loop.updatedAt = new Date().toISOString();
      activeLoopId = loop.id;
      updateStatus(ctx, loops, activeLoopId);
      return false;
    }

    const iterationNumber = loop.runCount + 1;
    const prompt = buildRunnerPrompt(loop, iterationNumber);
    loop.runCount = iterationNumber;
    loop.autoRun = true;
    loop.status = "running";
    loop.updatedAt = new Date().toISOString();
    activeLoopId = loop.id;
    updateStatus(ctx, loops, activeLoopId);

    if (ctx.isIdle()) {
      pi.sendUserMessage(prompt);
    } else {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    }
    return true;
  }

  pi.on("resources_discover", () => ({
    skillPaths: [join(packageDir, "skills", "loop-designer", "SKILL.md")],
    promptPaths: [
      join(packageDir, "prompts", "design-loop.md"),
      join(packageDir, "prompts", "run-loop.md"),
    ],
  }));

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      if (event.text.includes(LOOP_RUNNER_MARKER)) {
        const loopId = Number(event.text.match(/loop #(\d+)/i)?.[1]);
        const iterationNumber = Number(event.text.match(/iteration (\d+)\//i)?.[1]);
        const loop = loops.find((candidate) => candidate.id === loopId);
        if (
          !loop ||
          !loop.autoRun ||
          loop.status !== "running" ||
          !Number.isFinite(iterationNumber) ||
          iterationNumber !== loop.runCount
        ) {
          if (
            loop?.status === "paused" &&
            Number.isFinite(iterationNumber) &&
            loop.runCount === iterationNumber
          ) {
            loop.runCount = Math.max(0, loop.runCount - 1);
            loop.updatedAt = new Date().toISOString();
            updateStatus(ctx, loops, activeLoopId);
            persistState("pause");
          }
          ctx.ui.notify(
            `Dropped queued loop iteration${loopId ? ` for #${loopId}` : ""}; loop is not running.`,
            "info",
          );
          return { action: "handled" };
        }
      }
      return { action: "continue" };
    }

    const trimmed = event.text.trim();
    const autoPrefix = trimmed.match(/^(?:loop!:|#loop!(?=\s|$))\s*(.*)$/is);
    if (autoPrefix) {
      const { objective, maxIterations } = parseRunArgs(autoPrefix[1] ?? "");
      if (!objective) {
        ctx.ui.notify("Usage: loop!: <objective>", "warning");
        return { action: "handled" };
      }
      return {
        action: "transform",
        text: buildLoopPrompt(objective, { autoRun: true, maxIterations }),
      };
    }

    const loopPrefix = trimmed.match(/^(?:loop:|#loop\b)\s*(.*)$/is);
    if (!loopPrefix) return { action: "continue" };

    const objective = loopPrefix[1]?.trim();
    if (!objective) {
      ctx.ui.notify("Usage: loop: <objective>", "warning");
      return { action: "handled" };
    }

    return { action: "transform", text: buildLoopPrompt(objective) };
  });

  pi.on("before_agent_start", async (event) => {
    let systemPrompt = event.systemPrompt;
    if (event.prompt.includes(LOOP_MODE_MARKER)) systemPrompt += LOOP_SYSTEM_APPEND;
    if (event.prompt.includes(LOOP_RUNNER_MARKER)) systemPrompt += LOOP_RUNNER_APPEND;
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  pi.registerCommand("loop", {
    description: "Design an agent loop for an objective",
    handler: async (args, ctx) => {
      const objective = args.trim();
      const prompt = buildLoopPrompt(objective);

      if (!objective) {
        ctx.ui.setEditorText(prompt);
        ctx.ui.notify("Loop prompt loaded. Replace placeholder, then submit.", "info");
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
        return;
      }

      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify("Loop design queued as follow-up.", "info");
    },
  });

  pi.registerCommand("loop-run", {
    description: "Design an agent loop and automatically run bounded iterations",
    handler: async (args, ctx) => {
      const { objective, maxIterations } = parseRunArgs(args);
      const prompt = buildLoopPrompt(objective, { autoRun: true, maxIterations });

      if (!objective) {
        ctx.ui.setEditorText(prompt);
        ctx.ui.notify("Auto-loop prompt loaded. Replace placeholder, then submit.", "info");
        return;
      }

      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
        return;
      }

      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify("Auto-loop design queued as follow-up.", "info");
    },
  });

  pi.registerCommand("loop-draft", {
    description: "Put a loop-design prompt in the editor",
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(buildLoopPrompt(args.trim()));
      ctx.ui.notify("Loop prompt loaded. Edit, then submit.", "info");
    },
  });

  pi.registerCommand("loop-list", {
    description: "Show saved loop blueprints",
    handler: async (_args, ctx) => {
      const markdown = renderLoopListMarkdown(loops);
      ctx.ui.setEditorText(markdown);
      ctx.ui.notify("Saved loops copied into editor.", "info");
    },
  });

  pi.registerCommand("loop-next", {
    description: "Copy the active loop's next agent prompt into the editor",
    handler: async (args, ctx) => {
      const requestedId = args.trim() ? Number(args.trim()) : activeLoopId;
      const loop = loops.find((candidate) => candidate.id === requestedId);
      if (!loop) {
        ctx.ui.notify("No matching loop. Use /loop-list.", "warning");
        return;
      }
      ctx.ui.setEditorText(loop.nextAgentPrompt || renderLoopMarkdown(loop));
      activeLoopId = loop.id;
      updateStatus(ctx, loops, activeLoopId);
      ctx.ui.notify(`Loop #${loop.id} next prompt loaded.`, "info");
    },
  });

  pi.registerCommand("loop-start", {
    description: "Start auto-running the active saved loop",
    handler: async (args, ctx) => {
      const { objective, maxIterations, maxSpecified } = parseRunArgs(args);
      const requestedId = objective ? Number(objective) : activeLoopId;
      const loop = loops.find((candidate) => candidate.id === requestedId);
      if (!loop) {
        ctx.ui.notify("No matching loop. Use /loop-list or /loop-run <objective>.", "warning");
        return;
      }
      if (loop.autoRun && loop.status === "running") {
        ctx.ui.notify(`Loop #${loop.id} is already running. Use /loop-stop first.`, "warning");
        return;
      }
      if (maxSpecified) loop.maxIterations = maxIterations;
      const queued = queueNextLoopIteration(loop, ctx);
      persistState("checkpoint", undefined, queued);
      ctx.ui.notify(
        queued
          ? `Loop #${loop.id} auto-started (${loop.runCount}/${loop.maxIterations}).`
          : `Loop #${loop.id} could not start; nextAgentPrompt missing or max reached.`,
        queued ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("loop-stop", {
    description: "Pause the active auto-running loop",
    handler: async (_args, ctx) => {
      const loop = loops.find((candidate) => candidate.id === activeLoopId);
      if (!loop) {
        ctx.ui.notify("No active loop to pause.", "warning");
        return;
      }
      loop.autoRun = false;
      loop.status = "paused";
      loop.updatedAt = new Date().toISOString();
      updateStatus(ctx, loops, activeLoopId);
      persistState("pause");
      ctx.ui.notify(`Loop #${loop.id} paused.`, "info");
    },
  });

  pi.registerTool({
    name: "loop_designer",
    label: "Loop Designer",
    description:
      "Save, list, checkpoint, or pause agent-loop blueprints that repeatedly prompt coding agents.",
    promptSnippet:
      "Save/list/checkpoint/pause agent-loop blueprints with prompts, verification, reflection cadence, stop rules, and bounded auto-run",
    promptGuidelines: [
      "Use loop_designer when the user asks to design an agent loop, uses /loop, /loop-run, or wants repeatable prompts instead of a one-shot coding-agent prompt.",
      "Use loop_designer action save as the final step after drafting a concrete loop blueprint with objective, iterationPrompt, verificationSteps, stopRules, and nextAgentPrompt.",
      "When the user asked for automatic execution, call loop_designer action save with autoStart true and maxIterations set to a safe bounded number.",
      "Use loop_designer action checkpoint at the end of every automated loop iteration with status done, continue, or blocked plus verification evidence.",
      "Use continueLoop true only when status is continue and another low-risk iteration is needed.",
    ],
    parameters: LoopDesignerParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const now = new Date().toISOString();

      if (params.action === "list") {
        return {
          content: [{ type: "text", text: renderLoopListMarkdown(loops) }],
          details: snapshot("list"),
        };
      }

      if (params.action === "pause") {
        const loopId = resolveLoopId(params, activeLoopId);
        const loop = loops.find((candidate) => candidate.id === loopId);
        if (!loop) {
          return {
            content: [{ type: "text", text: "No active loop to pause." }],
            details: snapshot("pause", "No active loop to pause"),
          };
        }
        loop.autoRun = false;
        loop.status = "paused";
        loop.updatedAt = now;
        activeLoopId = loop.id;
        updateStatus(ctx, loops, activeLoopId);
        return {
          content: [{ type: "text", text: `Paused loop #${loop.id}.` }],
          details: snapshot("pause"),
          terminate: true,
        };
      }

      if (params.action === "checkpoint") {
        const loopId = resolveLoopId(params, activeLoopId);
        const loop = loops.find((candidate) => candidate.id === loopId);
        if (!loop) {
          return {
            content: [{ type: "text", text: "No active loop to checkpoint. Save a loop first." }],
            details: snapshot("checkpoint", "No active loop to checkpoint"),
          };
        }

        const progress = params.progress?.trim();
        if (!progress) {
          return {
            content: [{ type: "text", text: "Checkpoint needs progress text." }],
            details: snapshot("checkpoint", "progress required"),
          };
        }

        const status = params.status ?? "paused";
        loop.checkpoints.push({ text: progress, createdAt: now, status });
        loop.updatedAt = now;
        if (params.nextAgentPrompt?.trim()) loop.nextAgentPrompt = params.nextAgentPrompt.trim();
        if (params.maxIterations !== undefined)
          loop.maxIterations = clampMaxIterations(params.maxIterations);

        const wantsContinue =
          status === "continue" &&
          loop.autoRun &&
          loop.status === "running" &&
          params.continueLoop !== false;
        let queuedNext = false;
        let suffix = "";

        if (status === "done") {
          loop.status = "done";
          loop.autoRun = false;
        } else if (status === "blocked") {
          loop.status = "blocked";
          loop.autoRun = false;
        } else if (status === "paused" || !wantsContinue) {
          loop.status = "paused";
          loop.autoRun = false;
          if (status === "continue") suffix = "\n\nAuto-run paused by checkpoint.";
        }

        activeLoopId = loop.id;

        if (wantsContinue) {
          queuedNext = queueNextLoopIteration(loop, ctx);
          suffix = queuedNext
            ? `\n\nQueued next iteration (${loop.runCount}/${loop.maxIterations}).`
            : `\n\nAuto-run paused: maxIterations reached or nextAgentPrompt missing.`;
          if (!queuedNext) {
            loop.autoRun = false;
            loop.status = "paused";
          }
        }

        updateStatus(ctx, loops, activeLoopId);

        return {
          content: [
            {
              type: "text",
              text: `Checkpoint saved for loop #${loop.id}: ${progress}${suffix}`,
            },
          ],
          details: snapshot("checkpoint", undefined, queuedNext),
          terminate: queuedNext,
        };
      }

      const objective = params.objective?.trim();
      const iterationPrompt = params.iterationPrompt?.trim();
      const nextAgentPrompt = params.nextAgentPrompt?.trim();
      if (!objective || !iterationPrompt || !nextAgentPrompt) {
        return {
          content: [
            {
              type: "text",
              text: "Loop save needs objective, iterationPrompt, and nextAgentPrompt.",
            },
          ],
          details: snapshot("save", "objective, iterationPrompt, and nextAgentPrompt required"),
        };
      }

      const existingId = params.id;
      const existing =
        typeof existingId === "number" ? loops.find((loop) => loop.id === existingId) : undefined;
      const loop: LoopRecord = existing ?? {
        id: nextId++,
        title: "",
        objective: "",
        loopPrompt: "",
        iterationPrompt: "",
        stateModel: "",
        acceptanceCriteria: [],
        verificationSteps: [],
        stopRules: [],
        reflectionCadence: "",
        nextAgentPrompt: "",
        risks: [],
        checkpoints: [],
        updatedAt: now,
        autoRun: false,
        maxIterations: DEFAULT_MAX_ITERATIONS,
        runCount: 0,
        status: "draft",
      };

      loop.title = params.title?.trim() || fallbackTitle(objective);
      loop.objective = objective;
      loop.loopPrompt = params.loopPrompt?.trim() || buildLoopPrompt(objective);
      loop.iterationPrompt = iterationPrompt;
      loop.stateModel =
        params.stateModel?.trim() ||
        "Goal, current hypothesis, changed files, commands run, evidence, blockers, next prompt.";
      loop.acceptanceCriteria = asList(params.acceptanceCriteria);
      loop.verificationSteps = asList(params.verificationSteps);
      loop.stopRules = asList(params.stopRules);
      loop.reflectionCadence =
        params.reflectionCadence?.trim() ||
        "Reflect after every 2 iterations or any failed verification.";
      loop.nextAgentPrompt = nextAgentPrompt;
      loop.risks = asList(params.risks);
      loop.updatedAt = now;
      loop.maxIterations = clampMaxIterations(params.maxIterations ?? loop.maxIterations);

      if (params.autoStart === true) {
        loop.autoRun = true;
        loop.status = "running";
      } else if (!existing) {
        loop.status = "draft";
      }

      if (!existing) loops.push(loop);
      activeLoopId = loop.id;
      updateStatus(ctx, loops, activeLoopId);

      const queuedNext = params.autoStart === true ? queueNextLoopIteration(loop, ctx) : false;
      const suffix = queuedNext
        ? `\n\nAuto-start queued iteration ${loop.runCount}/${loop.maxIterations}. Use /loop-stop to pause.`
        : "\n\nSaved. Use /loop-next to inspect next prompt or /loop-start to run automatically.";

      return {
        content: [{ type: "text", text: `${renderLoopMarkdown(loop)}${suffix}` }],
        details: snapshot("save", undefined, queuedNext),
        terminate: true,
      };
    },

    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "save";
      const id = typeof args.id === "number" ? ` #${args.id}` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("loop_designer"))} ${theme.fg("muted", action)}${theme.fg("accent", id)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const text = result.content[0];
      const rawText = text?.type === "text" ? text.text : "";
      if (expanded) return new Text(rawText, 0, 0);

      const details = result.details as LoopDesignerDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", details.error), 0, 0);

      if (details?.action === "list") {
        return new Text(theme.fg("accent", `${details.loops.length} saved loop(s)`), 0, 0);
      }

      const active = details?.loops.find((loop) => loop.id === details.activeId);
      if (!active) {
        return new Text(rawText, 0, 0);
      }

      const lines = [
        theme.fg("toolTitle", theme.bold(`#${active.id} ${active.title}`)),
        `${theme.fg("muted", active.status)}${active.autoRun ? theme.fg("accent", ` auto ${active.runCount}/${active.maxIterations}`) : ""}`,
        theme.fg("muted", active.objective),
        `Next: ${theme.fg("accent", active.nextAgentPrompt || "not set")}`,
      ];
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
