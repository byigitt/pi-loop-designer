import { spawn } from "node:child_process";
import fs from "node:fs";
import loopDesigner from "../extensions/loop-designer.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function unitSmoke() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const sent = [];
  const customEntries = [];
  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    sendUserMessage(message, options) {
      sent.push({ message, options });
    },
    appendEntry(customType, data) {
      customEntries.push({ type: "custom", customType, data });
    },
  };

  loopDesigner(pi);

  for (const name of [
    "loop",
    "loop-run",
    "loop-draft",
    "loop-list",
    "loop-next",
    "loop-start",
    "loop-stop",
  ]) {
    assert(commands.has(name), `missing /${name} command`);
  }
  assert(tools.has("loop_designer"), "missing loop_designer tool");

  const ctx = {
    hasUI: true,
    isIdle: () => false,
    ui: {
      notify() {},
      setStatus() {},
      setEditorText(text) {
        ctx.editorText = text;
      },
    },
    sessionManager: { getBranch: () => customEntries },
  };

  const resources = await handlers.get("resources_discover")[0](
    { cwd: process.cwd(), reason: "startup" },
    ctx,
  );
  for (const path of [...resources.skillPaths, ...resources.promptPaths]) {
    assert(fs.existsSync(path), `resource path missing: ${path}`);
  }

  const inputResult = await handlers.get("input")[0](
    { source: "interactive", text: "loop!: ship release safely --max 2" },
    ctx,
  );
  assert(inputResult.action === "transform", "loop! prefix did not transform input");
  assert(inputResult.text.includes("LOOP_DESIGNER_MODE"), "transformed prompt missing marker");
  assert(
    inputResult.text.includes("autoStart true"),
    "auto-run prompt missing autoStart instruction",
  );

  const hashInputResult = await handlers.get("input")[0](
    { source: "interactive", text: "#loop! ship release safely --max 2" },
    ctx,
  );
  assert(hashInputResult.action === "transform", "#loop! prefix did not transform input");
  assert(hashInputResult.text.includes("autoStart true"), "#loop! did not enable auto-run");

  const promptResult = await handlers.get("before_agent_start")[0](
    {
      prompt: inputResult.text,
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    },
    ctx,
  );
  assert(promptResult.systemPrompt.includes("Loop Designer Mode"), "system prompt not augmented");

  const tool = tools.get("loop_designer");
  const saveResult = await tool.execute(
    "test",
    {
      action: "save",
      title: "Release loop",
      objective: "Ship release safely",
      iterationPrompt: "Run next release safety pass and verify evidence.",
      nextAgentPrompt: "Start release safety pass now.",
      acceptanceCriteria: ["release checklist complete"],
      verificationSteps: ["pnpm exec tsgo --noEmit"],
      stopRules: ["stop when checklist and typecheck pass"],
      autoStart: true,
      maxIterations: 2,
    },
    undefined,
    undefined,
    ctx,
  );
  assert(saveResult.details.queuedNext === true, "autoStart did not queue first iteration");
  assert(saveResult.details.loops[0].runCount === 1, "runCount did not increment on autoStart");
  assert(sent[0]?.message.includes("LOOP_RUNNER_MODE"), "queued message missing runner mode");
  const sentBeforeDuplicateStart = sent.length;
  await commands.get("loop-start").handler("1", ctx);
  assert(
    sent.length === sentBeforeDuplicateStart,
    "/loop-start should not duplicate running loops",
  );

  const checkpointResult = await tool.execute(
    "test",
    {
      action: "checkpoint",
      progress: "typecheck passed; more polish remains",
      status: "continue",
      continueLoop: true,
      nextAgentPrompt: "Run polish pass.",
    },
    undefined,
    undefined,
    ctx,
  );
  assert(
    checkpointResult.details.queuedNext === true,
    "continue checkpoint did not queue next iteration",
  );
  assert(
    checkpointResult.details.loops[0].runCount === 2,
    "runCount did not increment on continue",
  );

  const finalCheckpoint = await tool.execute(
    "test",
    {
      action: "checkpoint",
      progress: "verification complete",
      status: "done",
    },
    undefined,
    undefined,
    ctx,
  );
  assert(finalCheckpoint.details.loops[0].status === "done", "done checkpoint did not stop loop");

  const sentBeforeLoopStart = sent.length;
  await commands.get("loop-start").handler("1", ctx);
  assert(
    sent.length === sentBeforeLoopStart,
    "/loop-start without --max should preserve exhausted maxIterations",
  );

  await tool.execute(
    "test",
    {
      action: "save",
      title: "Manual continue loop",
      objective: "Verify explicit continue false",
      iterationPrompt: "Run one pass.",
      nextAgentPrompt: "Run one pass now.",
      autoStart: true,
      maxIterations: 3,
    },
    undefined,
    undefined,
    ctx,
  );
  const queuedRunnerPrompt = sent.at(-1)?.message;
  assert(typeof queuedRunnerPrompt === "string", "autoStart did not queue a runner prompt");
  await commands.get("loop-stop").handler("", ctx);
  const droppedRunner = await handlers.get("input")[0](
    { source: "extension", text: queuedRunnerPrompt },
    ctx,
  );
  assert(droppedRunner.action === "handled", "/loop-stop should suppress queued runner prompts");
  const afterDropList = await tool.execute("test", { action: "list" }, undefined, undefined, ctx);
  assert(
    afterDropList.details.loops.at(-1).runCount === 0,
    "dropped queued prompt should roll back runCount",
  );

  await tool.execute(
    "test",
    {
      action: "save",
      title: "Restart stale prompt loop",
      objective: "Drop stale queued prompts after restart",
      iterationPrompt: "Run one restart pass.",
      nextAgentPrompt: "Run restart pass now.",
      autoStart: true,
      maxIterations: 4,
    },
    undefined,
    undefined,
    ctx,
  );
  const stalePrompt = sent.at(-1)?.message;
  assert(typeof stalePrompt === "string", "restart loop did not queue initial prompt");
  await commands.get("loop-stop").handler("", ctx);
  await commands.get("loop-start").handler("", ctx);
  const restartedPrompt = sent.at(-1)?.message;
  assert(
    typeof restartedPrompt === "string" && restartedPrompt.includes("iteration 2/4"),
    "restart should queue the current iteration prompt",
  );
  const staleDropAfterRestart = await handlers.get("input")[0](
    { source: "extension", text: stalePrompt },
    ctx,
  );
  assert(
    staleDropAfterRestart.action === "handled",
    "stale queued runner prompt should be suppressed after restart",
  );
  const restartedAllowed = await handlers.get("input")[0](
    { source: "extension", text: restartedPrompt },
    ctx,
  );
  assert(restartedAllowed.action === "continue", "current restarted runner prompt should pass");
  await tool.execute(
    "test",
    {
      action: "checkpoint",
      progress: "restart stale prompt check complete",
      status: "done",
    },
    undefined,
    undefined,
    ctx,
  );

  const sentBeforeStoppedContinue = sent.length;
  const stoppedContinueResult = await tool.execute(
    "test",
    {
      action: "checkpoint",
      progress: "should stay paused after loop-stop",
      status: "continue",
      continueLoop: true,
    },
    undefined,
    undefined,
    ctx,
  );
  assert(
    sent.length === sentBeforeStoppedContinue,
    "loop-stop should suppress later continue checkpoints",
  );
  assert(
    stoppedContinueResult.details.loops.at(-1).status === "paused",
    "stopped continue should stay paused",
  );

  const sentBeforeContinueFalse = sent.length;
  const continueFalseResult = await tool.execute(
    "test",
    {
      action: "checkpoint",
      progress: "pausing despite continue status",
      status: "continue",
      continueLoop: false,
    },
    undefined,
    undefined,
    ctx,
  );
  assert(sent.length === sentBeforeContinueFalse, "continueLoop false should suppress auto-run");
  assert(
    continueFalseResult.details.loops.at(-1).status === "paused",
    "continueLoop false should mark loop paused",
  );

  await commands.get("loop-run").handler("--max 3 demo objective", ctx);
  assert(
    sent.at(-1)?.message.includes("maxIterations 3"),
    "/loop-run did not encode max iterations",
  );
}

async function rpcSmoke() {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      ["--mode", "rpc", "--no-session", "--no-extensions", "-e", ".", "--offline"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => fail(new Error("timeout waiting for get_commands")), 15_000);

    function cleanup() {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      error.message += `\nstdout: ${stdout}\nstderr: ${stderr}`;
      reject(error);
    }

    function pass() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let index;
      while ((index = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type !== "response" || message.id !== "commands") continue;
        const names = message.data?.commands?.map((command) => command.name) ?? [];
        const required = [
          "loop",
          "loop-run",
          "loop-draft",
          "loop-list",
          "loop-next",
          "loop-start",
          "loop-stop",
          "design-loop",
          "run-loop",
          "skill:loop-designer",
        ];
        const missing = required.filter((name) => !names.includes(name));
        if (missing.length > 0)
          fail(new Error(`missing installed commands: ${missing.join(", ")}`));
        else pass();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      if (!settled) fail(new Error(`pi exited early: ${code}`));
    });
    child.on("error", fail);

    child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
  });
}

await unitSmoke();
await rpcSmoke();
console.log("Smoke tests passed");
