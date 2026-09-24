# belayd-agent-harness

Multi-agent harness for [Belayd](https://github.com/belayd/package-proxy-v2) — agent registry, process spawner, phase gates, quality gates, worktree utilities, and pi extensions.

## What it does

Provides the machinery for Belayd's multi-agent workflow system:

- **Agent registry** — 9 specialized agents (scout, planner, implementer, reviewer, tester, userguide, proof generator, documenter, committer), each with model config, tool allowlists, and system prompts. Also exports `PLANNING_MODE_SYSTEM_PROMPT` and `PLANNING_MODE_TOOLS` for planning-mode orchestrators.
- **Process spawner** — Spawns isolated `pi --mode json` processes for each agent, streams results back, and tracks usage.
- **Process gate** — Enforces an implement-first phase order for each workflow (e.g. feature: implement → review → test → userguide → proof → commit), blocks out-of-sequence tool calls, and keeps `belayd_scout`/`belayd_plan` callable as non-gating consultation phases when a workflow declares them.
- **Workflow registry** — 7 workflow sub-types (feature, bugfix, research, chore, documentation, refactor, hotfix) with configurable phase sequences; feature/bugfix/refactor/documentation declare `consultPhases: ["scout", "plan"]` so planning runs as a separate, optional consultation step rather than a required phase.
- **Quality gates** — Deterministic post-agent checks: typecheck, lint, tests, proof content validation.
- **Proof verifier** — Optional, advisory, non-blocking `belayd_proof_verifier` tool that LLM-judges proof relevance/plausibility after the proof phase. See [docs/proof-verifier.md](docs/proof-verifier.md).
- **Playwright proof tooling** — `playwright` (test runner + trace viewer) and `playwright-cli` (interactive screenshots) are provided by the Nix runtime env for both the devShell and pi-web sessions, sharing one `PLAYWRIGHT_BROWSERS_PATH`. See [docs/playwright-proof-env.md](docs/playwright-proof-env.md).
- **Worktree utilities** — Git worktree setup/resolution for agent process isolation.
- **Stale-file guard** — Tracks file content hashes and blocks edits when files change between read and write.
- **Plannotator protocol** — Signal file contract for human-in-the-loop code review.

## Installation

### As a pi extension package (recommended)

```bash
# Clone and build
git clone https://github.com/belayd/belayd-agent-harness.git
cd belayd-agent-harness
pnpm install
pnpm build

# Install into your project (writes to .pi/settings.json)
cd /path/to/your/project
pi install -l /absolute/path/to/belayd-agent-harness
```

The `-l` flag writes to project settings (`.pi/settings.json`) so the whole team gets it. pi loads the extensions from the package directory automatically on startup.

### As an npm library

```bash
pnpm add belayd-agent-harness
```

```typescript
import { DEFAULT_AGENTS, spawnAgentProcess, setupWorktree } from "belayd-agent-harness";
```

## Planning mode (`/plan`)

Split from the implementation workflows: `/plan` enters a planning-only mode
that investigates and writes implementation-ready beads, without touching files
or creating a worktree.

Full verification steps and end-user usage:
[docs/planning-implement-workflows.md](docs/planning-implement-workflows.md).

```
/plan "description of the work"   # mode A: investigate then bd create
/plan bd-x [focus]                # mode B: bd show, then bd update
```

- No worktree, no edit/write/bash — the planning orchestrator uses
  `belayd_plan_scout` (codebase recon) and `belayd_plan_research` (deeper
  questions), then records the plan into beads.
- Ambiguity is resolved first: the orchestrator asks focused clarifying
  questions (one structured `ask_user` form, or a single message) and waits
  before writing. Planning is complete only once the target bead exists
  (mode A) or has been updated (mode B) — it never ends by offering to write a
  plan file or start implementation.
- Beads are created open/backlog (never `--status`/`--claim`), using
  `bd create "title" --description="..." --design="..." --notes="..." --type=<type> --priority=2`.
  Large work is decomposed into top-level step beads linked with `bd dep` /
  `bd dep add` / `bd dep relate` — never `--parent` or parent-child links.
- Exit planning with `belayd_stop_planning`, or start implementation with
  `/belayd` (or `belayd_start_task`), which resets planning state.

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript (dist/)
pnpm test             # Run unit tests
pnpm test:integration # Run integration tests
pnpm typecheck        # TypeScript type checking
pnpm lint             # Biome format + lint
```

### Running pi in this repo

The NixOS config installs these extensions globally (built from the pushed
flake), so a plain `pi` here would load both the global copies and the local
`.pi/settings.json` ones. The extension factories self-dedupe per load batch
(via the batch's shared `pi.events` bus — see
[docs/pi-web-service.md](docs/pi-web-service.md)), so the double load no longer
fails with `Tool "belayd_*" conflicts with ...` — but global extensions load
before project-local ones, so the Nix-built copy would win and edits to
`extensions/` would be ignored. `bin/pi`
(wired into PATH via `.envrc` / direnv) runs pi with `-ne` and re-adds the
repo-local extensions explicitly, so the local copy always wins and edits take
effect on the next launch without pushing + rebuilding the OS. Manual use:
`./bin/pi` (or `nix develop -c ./bin/pi`).

Spawned belayd agents get the same isolation: `.envrc` and the devShell
shellHook export `PI_BINARY_PATH` pointing at `bin/pi`, and `src/spawn.ts`
resolves the agent's pi binary from that var first (`resolvePiBinary`).

### Third-party npm extensions & custom providers

pi auto-installs packages listed in settings at startup, so for the NixOS
global install just run `pi install npm:<pkg>` (writes to
`~/.pi/agent/settings.json`; installed to `~/.pi/agent/npm/`). No flake
change — the global pi reads the same `~/.pi/agent`. `bin/pi` passes pi's
CLI subcommands (`install`, `remove`, `uninstall`, `update`, `list`,
`config`, `auth`) straight through to the real pi, so those also operate on
the global settings. Only *running* pi in this repo is isolated, and only
there do you need to add an explicit `-e npm:<pkg>` line to `bin/pi` for a
third-party extension.

Custom providers without an extension — for example LLM Gateway — are
configured in `~/.pi/agent/models.json`. These load regardless of `-ne`, so
they also work in this repo's wrapper and spawned agents with zero repo
changes. For DevPass plans, use canonical model ids without a provider prefix
(`claude-sonnet-4-5`, not `anthropic/claude-sonnet-4-5`): provider-pinned ids
are rejected (403). LLM Gateway's model list is refreshed from the live API
with `scripts/refresh-llmgateway-models.sh` — see `docs/llmgateway.md`.

## Local services

The harness relies on a few long-running local services, split across two
runtimes:

**pi-web — systemd system services (NixOS module).** The browser UI + session
daemon for pi agent sessions runs natively, declared by the flake's
`nixosModules.pi-web` module (two `systemd.services`). It used to run as an
arion container, but pi processes spawned inside that container had no Nix, so
`nix develop`/direnv could not work in sessions. The native service runs on the
host with Nix and the devShell tools on PATH. Enable it in the NixOS config:

```nix
services.belayd-pi-web = { enable = true; user = "alice"; };
```

It starts at boot (`WantedBy=multi-user.target`), survives SSH logout, and needs
no login, linger, or SSH agent. See
[docs/pi-web-service.md](docs/pi-web-service.md).

**scotty (+ portainer, + shared beads dolt server) — arion containers.** The
[scotty](https://github.com/brendan-appstart/bead-me-up-scotty) web UI and
portainer still run as containers autostarted by arion (Nix + Docker/Podman):

```bash
nix develop -c arion up -d
```

See [docs/arion.md](docs/arion.md).

For how to check status and logs of both runtimes, see
[AGENTS.md](AGENTS.md#checking-local-services).

## Structure

```
src/                  # Library source (published to npm)
  agent-registry.ts   # Agent definitions and types
  spawn.ts            # Agent process spawner
  process-gate.ts     # Phase order enforcement
  workflow-registry.ts # Workflow sub-types
  quality-gates.ts    # Deterministic quality checks
  worktree.ts         # Git worktree utilities
  stale-file-guard.ts # Stale file detection
  plannotator/        # Human-in-the-loop review protocol
extensions/           # pi extensions (loaded by pi)
  index.ts            # Main belayd-harness extension
  stale-file-guard.ts # Stale-file guard extension
test/                 # Integration tests
```

## License

MIT
