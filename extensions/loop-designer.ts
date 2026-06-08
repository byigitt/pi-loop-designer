import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const baseDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(baseDir);

const LoopDesignerParamsSchema = Type.Object({
  action: StringEnum(["save", "checkpoint", "list"] as const),
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
  risks: Type.Optional(
    Type.Array(Type.String(), { description: "Known failure modes or guardrails." }),
  ),
});

type LoopDesignerParams = Static<typeof LoopDesignerParamsSchema>;
type LoopAction = LoopDesignerParams["action"];

interface LoopCheckpoint {
  text: string;
  createdAt: string;
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
}

interface LoopDesignerDetails {
  action: LoopAction;
  loops: LoopRecord[];
  nextId: number;
  activeId?: number;
  error?: string;
}

const LOOP_MODE_MARKER = "LOOP_DESIGNER_MODE";

const LOOP_SYSTEM_APPEND = `

## Loop Designer Mode

The user is asking for an agent loop, not a one-shot answer. Design a repeatable loop that prompts agents.
- Convert the objective into loop state, iteration prompt, verification, reflection cadence, and stop rules.
- Prefer explicit acceptance criteria over vague success language.
- If a coding task is already clear, include commands/checks the loop should run each iteration.
- Use loop_designer with action "save" when you have a concrete loop blueprint.
- Do not hide uncertainty. Add risks and human decision points when the loop needs them.
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

function resolveLoopId(
  params: LoopDesignerParams,
  activeLoopId: number | undefined,
): number | undefined {
  return params.id ?? activeLoopId;
}

function buildLoopPrompt(objective: string): string {
  const cleanObjective = objective.trim() || "<describe objective here>";
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
7. Next agent prompt: the first prompt to run now.

Rules:
- Ask at most 3 clarifying questions only if missing info blocks loop design.
- Prefer measurable acceptance criteria.
- Include failure modes and guardrails.
- If loop_designer tool exists, save the blueprint with action "save".
- Do not solve the implementation directly unless the loop says iteration 1 should start.`;
}

function renderBulletSection(title: string, values: string[]): string[] {
  if (values.length === 0) return [];
  return [`## ${title}`, ...values.map((value) => `- ${value}`), ""];
}

function renderLoopMarkdown(loop: LoopRecord): string {
  const checkpointLines = loop.checkpoints.length
    ? [
        "## Checkpoints",
        ...loop.checkpoints.map(
          (checkpoint, index) => `- ${index + 1}. ${checkpoint.text} (${checkpoint.createdAt})`,
        ),
        "",
      ]
    : [];

  return [
    `# ${loop.title}`,
    "",
    `Loop #${loop.id} · updated ${loop.updatedAt}`,
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
  if (loops.length === 0) return "No loops saved yet. Run `/loop <objective>`.";
  return [
    "# Saved Agent Loops",
    "",
    ...loops.flatMap((loop) => [
      `## #${loop.id} ${loop.title}`,
      `- Objective: ${loop.objective}`,
      `- Updated: ${loop.updatedAt}`,
      `- Checkpoints: ${loop.checkpoints.length}`,
      `- Next: ${loop.nextAgentPrompt || "not set"}`,
      "",
    ]),
  ].join("\n");
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
    checkpoints: Array.isArray(candidate.checkpoints) ? candidate.checkpoints : [],
    updatedAt:
      typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
  };
}

function updateStatus(
  ctx: ExtensionContext,
  loops: LoopRecord[],
  activeLoopId: number | undefined,
): void {
  if (!ctx.hasUI) return;
  const active = loops.find((loop) => loop.id === activeLoopId);
  ctx.ui.setStatus("loop-designer", active ? `loop #${active.id}: ${active.title}` : "loop: /loop");
}

export default function loopDesigner(pi: ExtensionAPI) {
  let loops: LoopRecord[] = [];
  let nextId = 1;
  let activeLoopId: number | undefined;

  function reconstructState(ctx: ExtensionContext): void {
    loops = [];
    nextId = 1;
    activeLoopId = undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult" || message.toolName !== "loop_designer") continue;

      const details = message.details as Partial<LoopDesignerDetails> | undefined;
      if (!details || !Array.isArray(details.loops)) continue;

      loops = details.loops.map(normalizeLoop).filter((loop) => loop !== undefined);
      nextId =
        typeof details.nextId === "number"
          ? details.nextId
          : Math.max(1, ...loops.map((loop) => loop.id + 1));
      activeLoopId = typeof details.activeId === "number" ? details.activeId : activeLoopId;
    }

    updateStatus(ctx, loops, activeLoopId);
  }

  function snapshot(action: LoopAction, error?: string): LoopDesignerDetails {
    return {
      action,
      loops: loops.map((loop) => ({ ...loop, checkpoints: [...loop.checkpoints] })),
      nextId,
      activeId: activeLoopId,
      error,
    };
  }

  pi.on("resources_discover", () => ({
    skillPaths: [join(packageDir, "skills", "loop-designer", "SKILL.md")],
    promptPaths: [join(packageDir, "prompts", "design-loop.md")],
  }));

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const trimmed = event.text.trim();
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
    if (!event.prompt.includes(LOOP_MODE_MARKER)) return undefined;
    return { systemPrompt: `${event.systemPrompt}${LOOP_SYSTEM_APPEND}` };
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

  pi.registerTool({
    name: "loop_designer",
    label: "Loop Designer",
    description:
      "Save, list, or checkpoint agent-loop blueprints that repeatedly prompt coding agents.",
    promptSnippet:
      "Save/list/checkpoint agent-loop blueprints with prompts, verification, reflection cadence, and stop rules",
    promptGuidelines: [
      "Use loop_designer when the user asks to design an agent loop, uses /loop, or wants repeatable prompts instead of a one-shot coding-agent prompt.",
      "Use loop_designer action save as the final step after drafting a concrete loop blueprint with objective, iterationPrompt, verificationSteps, stopRules, and nextAgentPrompt.",
      "Use loop_designer action checkpoint after loop iterations to record progress, blockers, or the next prompt.",
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

        loop.checkpoints.push({ text: progress, createdAt: now });
        loop.updatedAt = now;
        if (params.nextAgentPrompt?.trim()) loop.nextAgentPrompt = params.nextAgentPrompt.trim();
        activeLoopId = loop.id;
        updateStatus(ctx, loops, activeLoopId);

        return {
          content: [{ type: "text", text: `Checkpoint saved for loop #${loop.id}: ${progress}` }],
          details: snapshot("checkpoint"),
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

      if (!existing) loops.push(loop);
      activeLoopId = loop.id;
      updateStatus(ctx, loops, activeLoopId);

      return {
        content: [{ type: "text", text: renderLoopMarkdown(loop) }],
        details: snapshot("save"),
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
        theme.fg("muted", active.objective),
        `Next: ${theme.fg("accent", active.nextAgentPrompt || "not set")}`,
      ];
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
