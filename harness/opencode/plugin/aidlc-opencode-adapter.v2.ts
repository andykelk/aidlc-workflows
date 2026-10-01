// aidlc-opencode-adapter.v2.ts — the opencode V2 hook shim (AUTHORED shell
// file; the aidlc-*.ts hook bodies in <project>/.aidlc/hooks/ are PACKAGED
// core, byte-shared with every harness).
//
// opencode has no settings.json/hooks.json hook registry; its extension seam
// is the PLUGIN API. OpenCode v2 broken the plugin API relative to v1: a V1
// plugin object (returned from `server()`) is silently ignored by the v2
// runtime, so the V1 adapter (.opencode/plugin/aidlc-opencode-adapter.ts) does
// not run under the default `curl -fsSL https://opencode.ai/v2/install | bash`
// install, and every human-presence gate fails closed. This file is the v2
// twin: a STRUCTURALLY-defined V2 plugin (default-export `{ id, setup }`, no
// `@opencode/plugin` import/`Plugin.define` so the emitted file stays a
// self-contained Bun TS module with no node_modules dependency — opencode v2
// reads the default export's `id` and `setup` directly).
//
// It is auto-discovered from `.opencode/plugins/` and maps opencode v2's hook
// surface onto the SAME core hook bodies, each run as a bun subprocess fed the
// ClaudeCodeHookInput JSON shape the core hooks parse. V1→V2 mapping (per the
// official migration guide https://opencode.ai/v2/docs/build/plugins/migrate-v1):
//
//   opencode v1 moment                 → opencode v2 API (this file)
//   ------------------------------------------------------------------------
//   chat.message (first per session)   → ctx.session.hook("prompt", …) → aidlc-session-start.ts  (SessionStart)
//   chat.message (every human turn)    → ctx.session.hook("prompt", …) → aidlc-record-human-turn.ts (UserPromptSubmit)
//   tool.execute.before task           → ctx.tool.hook("execute.before", …) → aidlc-deliver-stage-rules.ts rewrite + plan-approval guard (PreToolUse)
//   tool.execute.before other tools    → ctx.tool.hook("execute.before", …) → entrypoint boundary + aidlc-reviewer-scope.ts (PreToolUse)
//   tool.execute.after write|edit|patch→ ctx.tool.hook("execute.after", …) → aidlc-write-audit-log.ts + aidlc-run-sensors.ts (PostToolUse)
//   tool.execute.after bash            → ctx.tool.hook("execute.after", …) → aidlc-rebuild-stage-graph.ts (PostToolUse)
//   tool.execute.after todowrite       → ctx.tool.hook("execute.after", …) → aidlc-sync-workflow-state.ts (PostToolUse TaskUpdate)
//   tool.execute.after task            → ctx.tool.hook("execute.after", …) → aidlc-log-subagent.ts (SubagentStop)
//   event session.idle                 → ctx.event.subscribe() → aidlc-continue-workflow.ts (Stop)
//   experimental.session.compacting    → ctx.session.hook("compaction", …) → aidlc-validate-state.ts (PreCompact)
//
// Stop enforcement: session.idle is a REACTIVE event (opencode has no blocking
// continue-workflow channel), so when the core continue-workflow hook answers
// {"decision":"block","reason":…} this plugin re-engages the loop by injecting
// the reason as a new session prompt via ctx.session.prompt. The injected
// prompt carries the NUDGE sentinel so the prompt hook never mints HUMAN
// presence for it (a synthetic nudge is not a human turn), and loop-guarding
// stays with the core hook's run-mode-aware no-progress ceiling — this shim
// never counts.
//
// Same degradation profile as the V1 twin (documented in AGENTS.md):
//   - session-start's additionalContext has no injection channel; the hook
//     still runs for its side effects (session→intent stamp, state checks).
//   - There is no session-end moment; SESSION_ENDED is not emitted.
//   - Presence minting is skipped for subagent (child) sessions; the prompt
//     hook carries only a sessionID, so main-vs-child is resolved via
//     ctx.session.get(parentID) — an uncertain child never mints HUMAN_TURN.
//   - v2 has no TUI-toast channel in the plugin context; the engine-error
//     relay from aidlc-rebuild-stage-graph is advisory (the conductor skill
//     still prints the message verbatim).
//
// Differences from the V1 twin that are IMPROVEMENTS, not degradations:
//   - tool hooks carry `agent` directly, so reviewer identity no longer
//     depends on a chat.message→session agent correlation.
//   - The prompt hook receives a real `ses_...` sessionID, so session-start
//     stamps a real session as owner (no more `sessionless:` directives).
//
// Live verification target: opencode v2.0.20 (`@opencode/plugin` 2.0.20).

import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

const NUDGE_SENTINEL = "[aidlc-forwarding-nudge]";
const PROJECTED_INVOKE = "{{INVOKE}}";
const TRUSTED_NAMESPACE = "{{TRUSTED_NAMESPACE}}";
const PROJECTED_TRUSTED_NAMESPACE = TRUSTED_NAMESPACE.startsWith("{{")
  ? "engine"
  : TRUSTED_NAMESPACE;
const DEFAULT_AIDLC_COMMAND = PROJECTED_INVOKE.startsWith("{{")
  ? ["bun", ".aidlc/tools/aidlc.ts", PROJECTED_TRUSTED_NAMESPACE]
  : [...PROJECTED_INVOKE.trim().split(/\s+/), PROJECTED_TRUSTED_NAMESPACE];

function runCoreHook(
  hookFile: string,
  input: Record<string, unknown>,
  cwd: string,
  aidlcCommand: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const [bin, ...prefix] = aidlcCommand;
    const hook = hookFile.replace(/^aidlc-/, "").replace(/\.ts$/, "");
    if (!bin) return resolve({ stdout: "", stderr: "", code: 0 });
    try {
      const child = spawn(bin, [...prefix, "hook", hook, "--project-dir", cwd], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          AIDLC_PROJECT_DIR: cwd,
          CLAUDE_PROJECT_DIR: cwd,
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.on("error", () => resolve({ stdout: "", stderr: "", code: 0 })); // fail open
      child.on("close", (code: number | null) =>
        resolve({ stdout: out, stderr: err, code: code ?? 0 })
      );
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch {
      resolve({ stdout: "", stderr: "", code: 0 }); // fail open
    }
  });
}

/**
 * The subset of the opencode v2 plugin context this adapter uses, plus the
 * unit-test seams. Structured so the same logic drives both the real
 * `setup(ctx)` and the synthetic test harness.
 */
export type AdapterContext = {
  location: { directory: string };
  session: {
    get: (input: { sessionID: string }) => Promise<{ parentID?: string }>;
    prompt: (input: { sessionID: string; text: string }) => Promise<unknown>;
    hook: (
      name: "prompt" | "compaction",
      callback: (event: unknown) => Promise<void> | void,
    ) => Promise<{ dispose(): Promise<void> }>;
  };
  tool: {
    hook: (
      name: "execute.before" | "execute.after",
      callback: (event: unknown) => Promise<void> | void,
    ) => Promise<{ dispose(): Promise<void> }>;
  };
  event: {
    subscribe(options: {
      signal?: AbortSignal;
    }): AsyncIterable<Record<string, unknown>>;
  };
  /** Unit-test seam. Production uses the build-time list embedded by emit.ts. */
  aidlcEntrypoints?: ReadonlySet<string>;
  /** Unit-test seam. Production uses the projected framework dispatcher. */
  aidlcCommand?: readonly string[];
};

const AIDLC_BUN_PREFIX = /^bun[ \t]+\.aidlc\/(?:tools|hooks)\//;
const AIDLC_ENTRYPOINT = /^\.aidlc\/(tools|hooks)\/([A-Za-z0-9][A-Za-z0-9._-]*\.ts)$/;

// emit.ts replaces the empty array with every packaged .aidlc/{tools,hooks}/*.ts
// path. The adapter can then reject a newly-authored payload.ts even though the
// host's coarse bash permission glob matches it.
const shippedAidlcEntrypoints: ReadonlySet<string> = new Set<string>(
  /* @aidlc-shipped-entrypoints@ */ [],
);

const PROJECTED_BUN_TOOLS = DEFAULT_AIDLC_COMMAND[0] === "bun"
  ? (DEFAULT_AIDLC_COMMAND[1] ?? "").replace(/aidlc\.ts$/, "")
  : null;

/** Parse one expansion-free shell command into argv, or reject shell syntax. */
function directShellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < command.length) {
        const next = command[++i];
        if (next === "\n" || next === "\r") return null;
        word += next;
        continue;
      }
      if (ch === "`" || ch === "$" || ch === "\n" || ch === "\r") return null;
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStarted = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (wordStarted) {
        words.push(word);
        word = "";
        wordStarted = false;
      }
      continue;
    }
    if (
      ch === "\n" ||
      ch === "\r" ||
      ch === "\\" ||
      ch === "`" ||
      ch === "$" ||
      ch === "#" ||
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === "(" ||
      ch === ")" ||
      ch === "<" ||
      ch === ">"
    ) {
      return null;
    }
    word += ch;
    wordStarted = true;
  }
  if (quote !== null) return null;
  if (wordStarted) words.push(word);
  return words;
}

/** Return a denial reason only when the static AIDLC allow-prefix would match. */
function aidlcBashBoundaryViolation(
  command: string,
  allowedEntrypoints: ReadonlySet<string> = shippedAidlcEntrypoints,
): string | null {
  if (/^aidlc(?:[ \t]|$)/.test(command)) {
    const words = directShellWords(command);
    if (words?.[0] === "aidlc") return null;
    return (
      "AIDLC bash permission allows one direct invocation of a framework tool only. " +
      "Do not use chaining, redirection, expansion, or command substitution."
    );
  }
  if (PROJECTED_BUN_TOOLS === null) {
    return null;
  }
  if (!AIDLC_BUN_PREFIX.test(command)) return null;
  const words = directShellWords(command);
  const target = words?.[1]?.match(AIDLC_ENTRYPOINT);
  if (
    words?.[0] === "bun" &&
    target &&
    allowedEntrypoints.has(`${target[1]}/${target[2]}`)
  ) {
    return null;
  }
  return (
    "AIDLC bash permission allows one direct invocation of a shipped tool or hook only. " +
    "Use an unchanged .aidlc entrypoint without chaining, redirection, expansion, or command substitution."
  );
}

/** Extract every source and destination path touched by an apply_patch call. */
function applyPatchPaths(args: Record<string, unknown>): string[] {
  const patch =
    (args.patchText as string) ??
    (args.patch as string) ??
    (args.command as string) ??
    "";
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    paths.push(match[1].trim());
  }
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
    paths.push(match[1].trim());
  }
  return Array.from(new Set(paths.filter((p) => p.length > 0)));
}

type ReviewerCall = {
  toolName: "Read" | "Edit" | "Write" | "LS" | "Glob" | "Grep" | "Bash";
  toolInput: Record<string, unknown>;
};

function reviewerCalls(tool: string, args: Record<string, unknown>): ReviewerCall[] {
  if (tool === "bash") {
    return [{ toolName: "Bash", toolInput: { command: (args.command as string) ?? "" } }];
  }
  if (tool === "read") {
    return [{
      toolName: "Read",
      toolInput: { file_path: (args.filePath as string) ?? (args.path as string) ?? "" },
    }];
  }
  if (tool === "write") {
    return [{
      toolName: "Write",
      toolInput: { file_path: (args.filePath as string) ?? (args.path as string) ?? "" },
    }];
  }
  if (tool === "edit") {
    return [{
      toolName: "Edit",
      toolInput: { file_path: (args.filePath as string) ?? (args.path as string) ?? "" },
    }];
  }
  if (tool === "glob") {
    return [{
      toolName: "Glob",
      toolInput: {
        pattern: (args.pattern as string) ?? "",
        path: (args.path as string) ?? "",
      },
    }];
  }
  if (tool === "grep") {
    return [{
      toolName: "Grep",
      toolInput: {
        pattern: (args.pattern as string) ?? "",
        path: (args.path as string) ?? "",
        glob: (args.include as string) ?? "",
      },
    }];
  }
  if (tool === "list") {
    return [{
      toolName: "LS",
      toolInput: { path: (args.path as string) ?? "" },
    }];
  }
  if (tool === "apply_patch") {
    return applyPatchPaths(args).map((filePath) => ({
      toolName: "Write",
      toolInput: { file_path: filePath },
    }));
  }
  return [];
}

function sessionStartHandled(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { additionalContext?: unknown };
    return typeof parsed.additionalContext === "string";
  } catch {
    return false;
  }
}

/**
 * Map opencode v2's renamed built-in tools onto the V1-equivalent names the
 * core hooks and the reviewer-scope vocabulary understand. v2 renamed bash→
 * shell, apply_patch→patch, and task→subagent; the V1 names are also accepted
 * defensively so one mapping table serves both surfaces.
 */
function canonicalTool(tool: string): string {
  if (tool === "shell") return "bash";
  if (tool === "patch") return "apply_patch";
  if (tool === "subagent") return "task";
  return tool;
}

/**
 * Build the adapter's hook handlers against a context (the production ctx from
 * `setup`, or a synthetic test shim). Returns the per-hook handlers so unit
 * tests can drive them directly, plus the shared session/agent registers.
 */
export function createV2Adapter(ctx: AdapterContext) {
  const directory = ctx.location.directory;
  const aidlcCommand = ctx.aidlcCommand ?? DEFAULT_AIDLC_COMMAND;
  const aidlcEntrypoints = ctx.aidlcEntrypoints ?? shippedAidlcEntrypoints;

  const runCore = (
    hookFile: string,
    input: Record<string, unknown>,
    _cwd = directory,
  ) => runCoreHook(hookFile, input, directory, aidlcCommand);

  // Sessions whose session-start hook reached an active workflow.
  const started = new Set<string>();
  // Main sessions that delivered a real human turn. Stop enforcement keys on
  // this lighter latch because workflow state can be created during turn one.
  const sawHumanTurn = new Set<string>();
  // Sessions confirmed as main (no parentID) — presence + continue-workflow
  // enforcement apply only to these; child (task-tool) sessions are workers.
  const mainSession = new Map<string, boolean>();
  // Session → agent identity, fed from tool/compaction event.agent where the
  // v2 hook carries it (reviewer correlation no longer needs chat.message).
  const sessionAgent = new Map<string, string>();
  const idleInFlight = new Set<string>();

  async function isMainSession(sessionID: string): Promise<boolean> {
    const cached = mainSession.get(sessionID);
    if (cached !== undefined) return cached;
    try {
      const s = await ctx.session.get({ sessionID });
      const main = !s.parentID;
      mainSession.set(sessionID, main);
      return main;
    } catch {
      // An uncertain child must never record-human-turn human presence. Do not
      // cache the transient failure; a later event gets a fresh lookup.
      return false;
    }
  }

  // The Plan Approval guard judges the workflow of a bound session. A child
  // (task-tool) session skips SessionStart and has no binding, so send the
  // main session that owns it. A failed lookup keeps the child id, which the
  // guard then resolves as it would without one.
  const ownerSession = new Map<string, string>();
  async function owningSession(sessionID: string): Promise<string> {
    const cached = ownerSession.get(sessionID);
    if (cached !== undefined) return cached;
    let current = sessionID;
    try {
      for (let depth = 0; depth < 8; depth++) {
        const s = await ctx.session.get({ sessionID: current });
        const parent = s.parentID;
        if (!parent) break;
        current = parent;
      }
    } catch {
      return sessionID;
    }
    ownerSession.set(sessionID, current);
    return current;
  }

  /** Map the emit-side idle event to its session id across v2 payload shapes. */
  function idleSessionID(event: Record<string, unknown>): string {
    const data = (event.data ?? {}) as Record<string, unknown>;
    return (data.sessionID as string) ??
      (event.sessionID as string) ??
      (data.id as string) ??
      "";
  }

  /** Prompt hook ← V1 chat.message. Mints HUMAN_TURN + drives session-start. */
  async function onPrompt(event: unknown): Promise<void> {
    const e = event as {
      readonly sessionID?: string;
      prompt?: { text?: string; [k: string]: unknown };
      [k: string]: unknown;
    };
    // v2 exposes the agent at prompt-admission only behind event.metadata or
    // the later request hooks; reviewer scope reads event.agent on tools.
    const sessionID = e.sessionID ?? "";
    const text = typeof e.prompt?.text === "string" ? e.prompt.text : "";
    const first = text;
    // Never treat this plugin's own continue-workflow-nudge injection as a turn.
    if (first?.startsWith(NUDGE_SENTINEL)) return;
    if (!sessionID || !(await isMainSession(sessionID))) return;
    sawHumanTurn.add(sessionID);
    if (!started.has(sessionID)) {
      const result = await runCore(
        "aidlc-session-start.ts",
        {
          hook_event_name: "SessionStart",
          source: "startup",
          session_id: sessionID,
        },
        directory,
      );
      // A fresh project has no state yet, so the core hook emits no context.
      // Retry on later human turns until an active workflow is available.
      if (sessionStartHandled(result.stdout)) started.add(sessionID);
    }
    await runCore(
      "aidlc-record-human-turn.ts",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: sessionID,
        prompt: first ?? "",
      },
      directory,
    );
  }

  /** Tool execute.before ← V1 tool.execute.before. Rewrite/blocking guards. */
  async function onExecuteBefore(event: unknown): Promise<void> {
    const e = event as {
      tool?: string;
      readonly sessionID?: string;
      readonly agent?: string;
      readonly id?: string;
      input?: unknown;
    };
    // v2 renamed bash→shell, apply_patch→patch, task→subagent. Canonicalize so
    // the core hooks (and reviewer vocabulary) still receive V1 tool names.
    const tool = canonicalTool(e.tool ?? "");
    const sessionID = e.sessionID ?? "";
    const callID = e.id ?? "";
    if (e.agent) sessionAgent.set(sessionID, e.agent);
    // v2 hands a mutable `input`; rewrite it in place (mirrors the V1 output.args).
    const args = (e.input ?? {}) as Record<string, unknown>;
    if (tool === "task") {
      const dispatch = await runCore(
        "aidlc-deliver-stage-rules.ts",
        {
          hook_event_name: "PreToolUse",
          session_id: sessionID,
          tool_name: "task",
          tool_input: args,
          cwd: directory,
        },
        directory,
      );
      if (dispatch.code === 2) {
        throw new Error(
          dispatch.stderr.trim() ||
            "required active-stage rules could not be loaded for subagent dispatch",
        );
      }
      if (dispatch.stdout.trim()) {
        try {
          const parsed = JSON.parse(dispatch.stdout) as {
            hookSpecificOutput?: {
              updatedInput?: Record<string, unknown>;
            };
          };
          if (parsed.hookSpecificOutput?.updatedInput) {
            e.input = parsed.hookSpecificOutput.updatedInput;
          }
        } catch {
          throw new Error(
            "AIDLC deliver-stage-rules hook returned invalid rewrite output",
          );
        }
      }
    }
    const namedAgent = sessionAgent.get(sessionID);
    const delegatedAgent =
      namedAgent?.startsWith("aidlc-") && namedAgent.endsWith("-agent")
        ? namedAgent
        : null;
    if (tool === "bash") {
      const command = (args.command as string) ?? "";
      const violation = aidlcBashBoundaryViolation(command, aidlcEntrypoints);
      if (violation) throw new Error(violation);
      // State-transition guard, parallel to the Claude/Kiro/Codex PreToolUse
      // wiring. The state CLI's ownership check remains the hard floor; this
      // gives the conductor the same immediate redirect the other harnesses
      // get instead of a late CLI error.
      const guard = await runCore(
        "aidlc-state-transition-guard.ts",
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          cwd: directory,
          ...(delegatedAgent ? { agent_type: delegatedAgent } : {}),
        },
        directory,
      );
      if (guard.code === 2) {
        throw new Error(
          guard.stderr.trim() ||
            "stage status is changed by the workflow tools, not by hand: use aidlc-orchestrate.ts report instead of calling aidlc-state.ts directly",
        );
      }
    }

    // Review-freeze (§12a terminal-receipt write-freeze): runs for EVERY
    // agent - unlike reviewer-scope there is no identity gate, because any
    // produces[] write voids a fresh READY receipt regardless of who makes
    // it. The core hook self-filters to write tools and fails open.
    if (tool === "bash" || tool === "write" || tool === "edit" || tool === "apply_patch") {
      const freezeCalls =
        tool === "bash"
          ? [{ toolName: "Bash", toolInput: { command: (args.command as string) ?? "" } }]
          : (tool === "apply_patch" ? applyPatchPaths(args) : [
              (args.filePath as string) ?? (args.path as string) ?? "",
            ])
              .filter((filePath) => filePath.length > 0)
              .map((filePath) => ({
                toolName: tool === "edit" ? "Edit" : "Write",
                toolInput: { file_path: filePath },
              }));
      for (const call of freezeCalls) {
        const freeze = await runCore(
          "aidlc-review-freeze.ts",
          {
            hook_event_name: "PreToolUse",
            tool_name: call.toolName,
            tool_input: call.toolInput,
            cwd: directory,
          },
          directory,
        );
        if (freeze.code === 2) {
          throw new Error(
            freeze.stderr.trim() ||
              "review-freeze: this write would invalidate a fresh READY review receipt",
          );
        }
      }
    }

    // Plan-approval guard: workspace mutations share the same normalized
    // calls as review-freeze, while task dispatches carry the explicit
    // approval target and Testing Contract markers.
    if (tool === "bash" || tool === "write" || tool === "edit" || tool === "apply_patch") {
      const planCalls =
        tool === "bash"
          ? [{ toolName: "Bash", toolInput: { command: (args.command as string) ?? "" } }]
          : (tool === "apply_patch" ? applyPatchPaths(args) : [
              (args.filePath as string) ?? (args.path as string) ?? "",
            ])
              .filter((filePath) => filePath.length > 0)
              .map((filePath) => ({
                toolName: tool === "edit" ? "Edit" : "Write",
                toolInput: { file_path: filePath },
              }));
      for (const call of planCalls) {
        const guard = await runCore(
          "aidlc-plan-approval-guard.ts",
          {
            hook_event_name: "PreToolUse",
            tool_name: call.toolName,
            tool_input: call.toolInput,
            session_id: await owningSession(sessionID),
            cwd: directory,
          },
          directory,
        );
        if (guard.code === 2) {
          throw new Error(
            guard.stderr.trim() ||
              "code-generation requires an approved plan before workspace mutation",
          );
        }
      }
    }

    if (tool === "task") {
      const target = (args.subagent_type as string) ?? (args.agent as string) ?? "";
      if (target === "aidlc-developer-agent") {
        const guard = await runCore(
          "aidlc-plan-approval-guard.ts",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Task",
            tool_input: {
              subagent_type: target,
              prompt: [(args.prompt as string) ?? "", (args.description as string) ?? ""]
                .filter((t) => t.length > 0)
                .join("\n"),
            },
            session_id: await owningSession(sessionID),
            cwd: directory,
          },
          directory,
        );
        if (guard.code === 2) {
          throw new Error(
            guard.stderr.trim() ||
              "code-generation requires an approved plan before dispatching the developer agent",
          );
        }
      }
    }

    const calls = reviewerCalls(tool, args);
    if (calls.length === 0) return;

    const identity =
      namedAgent
        ? { agent_type: namedAgent }
        : (await isMainSession(sessionID))
          ? null
          : { scoped_registration: true };
    if (identity === null) return;

    for (const call of calls) {
      const result = await runCore(
        "aidlc-reviewer-scope.ts",
        {
          hook_event_name: "PreToolUse",
          tool_name: call.toolName,
          tool_input: call.toolInput,
          cwd: directory,
          ...identity,
        },
        directory,
      );
      if (result.code === 2) {
        throw new Error(result.stderr.trim() || "reviewer read-scope refused this tool call");
      }
    }
  }

  /** Tool execute.after ← V1 tool.execute.after. Audit/sensors/routing sync. */
  async function onExecuteAfter(event: unknown): Promise<void> {
    const e = event as {
      readonly tool?: string;
      readonly sessionID?: string;
      readonly id?: string;
      readonly input?: unknown;
      readonly status?: string;
      readonly result?: unknown;
    };
    // v2 renamed bash→shell, apply_patch→patch, task→subagent.
    const tool = canonicalTool(e.tool ?? "");
    const sessionID = e.sessionID ?? "";
    const callID = e.id ?? "";
    const args = (e.input ?? {}) as Record<string, unknown>;
    // Only a completed run is observed (V1's output); failed runs produce no
    // transcript to forward but the routing hooks still run.
    const outputText =
      e.status === "completed" && typeof e.result === "string"
        ? e.result
        : typeof e.result === "object" && e.result !== null
          ? JSON.stringify(e.result)
          : typeof e.result === "string"
            ? e.result
            : "";

    if (tool === "write" || tool === "edit" || tool === "apply_patch") {
      const paths =
        tool === "apply_patch"
          ? applyPatchPaths(args)
          : [((args.filePath as string) ?? (args.path as string) ?? "")];
      for (const filePath of paths) {
        if (!filePath) continue;
        const absolutePath = isAbsolute(filePath) ? filePath : join(directory, filePath);
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: absolutePath },
        };
        // audit THEN sensors, mirroring the Claude settings.json order.
        await runCore("aidlc-write-audit-log.ts", payload, directory);
        await runCore("aidlc-run-sensors.ts", payload, directory);
      }
      return;
    }
    if (tool === "bash") {
      const payload = {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: (args.command as string) ?? "" },
        session_id: sessionID,
        tool_response: outputText,
      };
      // engine-error relay: no TUI-toast channel in the v2 plugin context, so
      // the rebuild hook's directive message is advisory-only (the conductor
      // skill prints it verbatim).
      await runCore("aidlc-rebuild-stage-graph.ts", payload, directory);
      return;
    }
    if (tool === "todowrite") {
      const todos = (args.todos as Array<{ content?: string; status?: string }>) ?? [];
      const active = todos.find((t) => t.status === "in_progress");
      if (!active?.content) return;
      await runCore(
        "aidlc-sync-workflow-state.ts",
        {
          hook_event_name: "PostToolUse",
          tool_name: "TaskUpdate",
          tool_input: { status: "in_progress", activeForm: active.content },
        },
        directory,
      );
      return;
    }
    if (tool === "task") {
      await runCore(
        "aidlc-log-subagent.ts",
        {
          hook_event_name: "SubagentStop",
          session_id: sessionID,
          agent_type: (args.subagent_type as string) ?? (args.agent as string) ?? "unknown",
          agent_id: callID,
        },
        directory,
      );
    }
  }

  /** Compaction hook ← V1 experimental.session.compacting. */
  async function onCompaction(): Promise<void> {
    await runCore("aidlc-validate-state.ts", { hook_event_name: "PreCompact" }, directory);
  }

  /** Idle handler ← V1 event(session.idle). continue-workflow + nudge. */
  async function onIdle(event: Record<string, unknown>): Promise<void> {
    if (event?.type !== "session.idle") return;
    const sessionID = idleSessionID(event);
    // A workflow can be created during the first turn, after session-start saw
    // no state. Let the core Stop hook's own state-file guard decide.
    if (!sessionID || !sawHumanTurn.has(sessionID)) return;
    if (!(await isMainSession(sessionID))) return;
    if (idleInFlight.has(sessionID)) return;
    idleInFlight.add(sessionID);
    // opencode provides no stop_hook_active flag and no transcript, so the
    // core hook's run-mode-aware no-progress ceiling is the loop guard here
    // (same degradation profile as Kiro). The absent transcript no longer makes
    // the conversational carve-out inert: the core hook falls back to the
    // `.aidlc-engine/human-turn` / `.aidlc-engine/engine-touch` mtime comparison, and
    // the prompt arm's aidlc-record-human-turn.ts forward writes the former.
    let nudgeReason: string | null = null;
    try {
      const res = await runCore(
        "aidlc-continue-workflow.ts",
        {
          hook_event_name: "Stop",
          stop_hook_active: false,
          session_id: sessionID,
        },
        directory,
      );
      try {
        const parsed = JSON.parse(res.stdout) as { decision?: string; reason?: string };
        if (parsed.decision === "block" && parsed.reason) {
          nudgeReason = parsed.reason;
        }
      } catch {
        /* no/unparseable output → allow the continue-workflow (advisory) */
      }
    } finally {
      idleInFlight.delete(sessionID);
    }
    // Release serialization before the prompt: OpenCode may synchronously
    // deliver the continuation's next idle while this promise is pending.
    if (nudgeReason) {
      await ctx.session.prompt({
        sessionID,
        text: `${NUDGE_SENTINEL} ${nudgeReason}`,
      });
    }
  }

  return {
    onPrompt,
    onExecuteBefore,
    onExecuteAfter,
    onCompaction,
    onIdle,
    isMainSession,
    owningSession,
    sessionAgent,
    sawHumanTurn,
    started,
  };
}

export type V2Adapter = ReturnType<typeof createV2Adapter>;

/**
 * The V2 plugin entrypoint. Structurally-defined regardless of the
 * `@opencode/plugin` package (no import) so the emitted file stays a
 * dependency-free Bun module. OpenCode v2 reads the default export's `id` and
 * `setup`.
 */
export default {
  id: "aidlc-opencode-adapter",
  async setup(ctx: AdapterContext) {
    const adapter = createV2Adapter(ctx);
    const controller = new AbortController();

    await ctx.session.hook("prompt", (event) => adapter.onPrompt(event));
    await ctx.tool.hook("execute.before", (event) => adapter.onExecuteBefore(event));
    await ctx.tool.hook("execute.after", (event) => adapter.onExecuteAfter(event));
    await ctx.session.hook("compaction", () => adapter.onCompaction());

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (typeof event !== "object" || event === null) continue;
          await adapter.onIdle(event as Record<string, unknown>);
        }
      } catch {
        /* subscription aborted or stream closed on unload */
      }
    })();

    return () => controller.abort();
  },
};
