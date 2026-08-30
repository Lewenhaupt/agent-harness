# belayd-agent-harness

Multi-agent harness for [Belayd](https://github.com/belayd/package-proxy-v2) — agent registry, process spawner, phase gates, quality gates, worktree utilities, and pi extensions.

## What it does

Provides the machinery for Belayd's multi-agent workflow system:

- **Agent registry** — 8 specialized agents (scout, planner, implementer, reviewer, tester, proof generator, documenter, committer), each with model config, tool allowlists, and system prompts.
- **Process spawner** — Spawns isolated `pi --mode json` processes for each agent, streams results back, and tracks usage.
- **Process gate** — Enforces phase order (scout → plan → implement → review → test → proof → plannotator → commit), blocks out-of-sequence tool calls.
- **Workflow registry** — 7 workflow sub-types (feature, bugfix, research, chore, documentation, refactor, hotfix) with configurable phase sequences.
- **Quality gates** — Deterministic post-agent checks: typecheck, lint, tests, proof content validation.
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
`.pi/settings.json` ones and fail with `Tool "belayd_*" conflicts with
.../extensions/index.ts`. `bin/pi` (wired into PATH via `.envrc` / direnv)
runs pi with `-ne` and re-adds the repo-local extensions explicitly, so edits
to `extensions/` take effect on the next launch without pushing + rebuilding
the OS. Manual use: `./bin/pi` (or `nix develop -c ./bin/pi`).

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

Custom providers without an extension — for example LLM Gateway, see the
official [pi integration guide](https://docs.llmgateway.io/guides/pi) — are
configured in `~/.pi/agent/models.json` (a `providers` map). These load
regardless of `-ne`, so they also work in this repo's wrapper and spawned
agents with zero repo changes. For DevPass plans, use canonical model ids
without a provider prefix (`claude-sonnet-4-5`, not
`anthropic/claude-sonnet-4-5`): provider-pinned ids are rejected (403).

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
