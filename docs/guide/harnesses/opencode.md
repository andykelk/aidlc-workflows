# AI-DLC on opencode

The opencode runtime is one of the framework's harness distributions, for the
open-source **opencode** harness (opencode.ai). One deterministic core, many
harnesses: the engine, state machine, audit log, graph, swarm referee, and
learnings gate are byte-identical across every distribution — only the shell
differs. The source/development tree is **generated** into ignored local
`dist/opencode/` from `core/` + `harness/opencode/` by
`bun scripts/package.ts opencode`; never hand-edit it.

Harness-specific onboarding lives in `.aidlc/onboarding.md`, loaded by the
`instructions` list in `opencode.json`. The root `AGENTS.md` block is
harness-neutral and shared with other installed harnesses whose engine
directories differ; opencode and Copilot cannot share one `.aidlc/` install.

## Layout: two dot-dirs, on purpose

opencode auto-imports every `*.ts` under `.opencode/tools/` and
`.opencode/tool/` as custom tool definitions, and importing a CLI-style engine
script (top-level dispatch, `process.exit`) crashes the session
(live-reproduced on opencode 1.17.18). So this distribution splits:

- **`.aidlc/`** — the AIDLC engine tree (tools, hooks, skills, agents,
  knowledge, scopes, sensors, aidlc-common). opencode never scans it; the
  shipped `opencode.json` registers `skills.paths: [".aidlc/skills"]` so the
  orchestrator skill and every generated runner are discovered there.
- **`.opencode/`** — only natively-consumed surfaces: the 14 persona
  subagents (`agents/*.md`, `mode: subagent`), the `/aidlc` command
  (`command/aidlc.md`), and the hook-adapter plugins
  (`plugin/aidlc-opencode-adapter.ts` for opencode v1 and
  `plugins/aidlc-opencode-adapter.ts` for opencode v2, each auto-discovered in
  its version's plugin dir).

## Prerequisites

- **opencode v2 (verified 2.0.20)** — the recommended target. The default
  install (`curl -fsSL https://opencode.ai/v2/install | bash`) is v2, where V1
  plugin implementations do not run, so the human-presence gate would fail
  closed without the v2 adapter along for the ride. Check with
  `opencode --version`.
- **or pin opencode v1 (verified 1.17.18)** if you need the V1 plugin surface
  (the `chat.message`, `tool.execute.before/after`, `session.idle` event, and
  `experimental.session.compacting` hooks the v1 adapter maps). Note that plain
  V1 object entrypoints are only recognized from opencode **1.18.29+**, so the
  safest documented v1 target is the verified **1.17.18** build.
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes dispatch through
  the installed `aidlc` executable.
- **A model provider** — the shipped project `opencode.json` and agent
  definitions pin no model. Your global opencode config supplies the provider
  and session model; balanced reviewers retain only their medium reasoning
  variant.

## Install

### Native channel (recommended)

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config
aidlc doctor
opencode
```

The installer verifies the release metadata, executable, and all-harness runtime archive against the published SHA-256 checksums. The installed runtime does not require Bun, Node.js, or Git. Harness selection happens in `aidlc config`.

On Windows, download `install.ps1` and run
`& $installer`. See [Windows installation](../18-install-and-lifecycle.md#windows-powershell)
for account scope, automatic User PATH registration, and `-NoModifyPath`.
For an air-gapped package, use
`install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config` projects `.aidlc/`, `.opencode/`, the workspace shell,
`AGENTS.md`, the managed `.gitignore` block, and `opencode.json`. The generated
config discovers the skill and method files and allows direct `aidlc engine *`
commands; other shell commands still prompt. Start opencode in the project and
run `/aidlc --doctor`, then `/aidlc` followed by what you want to build.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

1. Copy the distribution into your project:

   ```bash
   cp -r "$RUNTIME_ROOT/opencode/.aidlc/"    your-project/.aidlc/
   cp -r "$RUNTIME_ROOT/opencode/.opencode/" your-project/.opencode/
   cp -r "$RUNTIME_ROOT/opencode/aidlc/"     your-project/aidlc/      # the workspace shell — a sibling of .aidlc/, not inside it
   cp "$RUNTIME_ROOT/opencode/opencode.json" your-project/opencode.json  # or merge into yours
   cp "$RUNTIME_ROOT/opencode/AGENTS.md"     your-project/AGENTS.md      # or merge into yours
   ```

   `opencode.json` carries three load-bearing blocks: `skills.paths` (skill
   discovery from `.aidlc/skills`), `instructions` (both native onboarding at
   `.aidlc/onboarding.md` and the method-tree glob — `/aidlc space <name>`
   re-points only the glob), and permission rules for AIDLC bash entrypoints
   plus edits under `.aidlc/tools/` and `.aidlc/hooks/`. If you merge into an
   existing `opencode.json` or `opencode.jsonc`, preserve all three blocks,
   including both `instructions` entries.
   The adapter enforces the permission boundary: the target must be an entrypoint
   embedded from the packaged tree, invoked as one direct command with no
   chaining, redirection, expansion, or command substitution. Engine-code edits
   prompt for approval.

2. Apply the `.gitignore` entries from the shipped `AGENTS.md` § "Git
   Integration" before starting a workflow (per-clone audit shards are
   committed deliberately; cursors and machine-local runtime stay ignored).

3. Start opencode in the project and run `/aidlc --doctor`, then `/aidlc`
   followed by what you want to build.

Because opencode has no channel for the session-start hook's injected context,
the `/aidlc` skill performs one read-only status probe on a bare invocation. An
existing workflow gets the standard Resume / Redo / Jump / Start Fresh menu;
`/aidlc --resume` skips both the probe and menu and continues directly.

The versioned runtime uses the native `aidlc` command. Framework developers who
need the Bun-shaped projection can clone the repository, run
`bun install --frozen-lockfile` and `bun scripts/package.ts`, then use the
ignored local `dist/opencode/` output.

## Refresh and version skew

`aidlc update` updates the machine runtime without rewriting projects.
`aidlc doctor` reports a project stamp that differs from the selected engine.
Between workflows, preview and apply a refresh:

```bash
aidlc config --dry-run
aidlc config
```

Config preserves managed root blocks and user-owned files, and reports local
framework edits as conflicts. Because `opencode.json` is a whole-file
integration, a local edit is preserved as a conflict rather than overwritten.
Config refuses refresh while any workflow is active; complete the workflow first.
Upgrade and rollback remain safe during a workflow because they do not touch
the project.

## What's different on this harness

- **Questions render as numbered prose options** (no structured-question
  widget); the questions FILE with `[Answer]:` tags remains the source of
  truth.
- **Hooks ride the adapter plugin.** opencode has no hooks.json/settings hook
  registry; `.opencode/plugin/aidlc-opencode-adapter.ts` (opencode v1) or
  `.opencode/plugins/aidlc-opencode-adapter.ts` (opencode v2) maps opencode's
  plugin hook moments onto the core hook bodies in `.aidlc/hooks/` (run as bun
  subprocesses): reviewer read-scope and the AIDLC bash boundary before tool
  execution; audit + sensors on write/edit/apply_patch; rebuild-stage-graph on
  bash; statusline sync on todowrite; subagent logging on task; presence
  minting on each human turn; state validation before compaction. The v2
  adapter is a structurally-defined plugin (`{ id, setup }`, no
  `@opencode/plugin` import) registered against the v2 prompt/tool/compaction
  hooks and event subscription; it stamps the real `ses_...` session as
  workflow owner on the first turn, so `active-directive.json` never degrades
  to a `sessionless:` owner on v2.
- **Forwarding-loop enforcement is advisory.** The Stop seam is the
  `session.idle` event — reactive, not blocking. When the core stop hook
  answers `block`, the plugin re-engages the loop by injecting a nudge prompt
  (marked with a sentinel so it never mints human presence). A chatting or
  pausing human is released by the hook's interactive cap.
- **Personas are native subagents** (`mode: subagent`); the conductor adopts
  them inline for most stages and delegates via the `task` tool for the two
  subagent stages (2.1 reverse-engineering, 3.5 code-generation). Their native
  permission map denies `task`, so delegated agents cannot delegate again.
  Plugin composition emits the same `.opencode/agents/` twin for plugin personas.
- **Space switches preserve JSONC.** `/aidlc space <name>` updates the method
  glob in either `opencode.json` or `opencode.jsonc` without stripping comments
  or trailing commas, and keeps explicit persona memory paths aligned.
- **Construction swarm runs as task-tool fan-out only** (`AIDLC_USE_SWARM=1`
  is a loud no-op — no Workflow tool exists).
- **No session-end moment** — `SESSION_ENDED` audit events are not emitted.
  Pre-compaction validation DOES fire (`experimental.session.compacting`).
- **No statusline / welcome message** — use `/aidlc --status` and the progress
  lines at gates.
- **MCP servers**: none ship; configure your own under `mcp:` in
  `opencode.json` if needed.

## Verifying an install

```bash
aidlc doctor                               # native install
bun .aidlc/tools/aidlc-utility.ts doctor   # source/development copy
opencode run --command aidlc -- "--status"  # /aidlc --status through the harness
```

The doctor's opencode-specific checks: an adapter plugin present (v1 at
`.opencode/plugin/` or v2 at `.opencode/plugins/`), a project-root
`opencode.json`/`opencode.jsonc`
present, and `.opencode/command/aidlc.md` present.
