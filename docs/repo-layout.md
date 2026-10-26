# Repository layout

Where things live in this repo, and which doc owns each subsystem. `AGENTS.md`
carries only the rules an agent must know before touching anything; this file is
the map for finding the rest on demand.

## Top level

```
belayd-agent-harness/
├── src/                     # Library source (published as npm package)
├── extensions/              # pi extensions (loaded from source, not dist/)
├── test/                    # Integration tests
├── docs/                    # Per-subsystem runbooks (see the index below)
├── nix/pi-extensions/       # Third-party pi extension manifest + lockfile
├── pi-web-plugins/          # pi-web browser plugin (proof-of-work panel)
├── scripts/                 # belayd-shell / direnv helpers, shipped via the flake
├── bin/pi                   # Repo dev wrapper (derives its -e list from manifests)
├── flake.nix                # Packages: pi, pi-bare, belayd-harness, pi-web, archify…
├── package.json             # pi manifest (extensions/skills) + library entry
└── templates/, models.json  # Bootstrap template, LLM Gateway model catalog
```

## Module map

The table is generated from each file's leading docblock, so it describes what the
code says rather than what it once said. `src/index.ts` is the public re-export
barrel — a module whose symbols are not re-exported there is internal.

### core

| File | Purpose |
|---|---|
| `src/index.ts` | @belayd/agent-harness — Multi-agent harness for Belayd |
| `src/agent-registry.ts` | Agent definitions for the Belayd multi-agent harness |
| `src/spawn.ts` | Agent process spawner |
| `src/spawn-with-fallback.ts` | Quota-aware spawn loop |
| `src/pi-binary.ts` | pi binary resolution for spawned harness agents |
| `src/role-tools.ts` | Per-role tool surfaces |
| `src/tool-audit.ts` | Tool-surface auditing for the harness |
| `src/process-gate.ts` | Process gate — enforces mandatory phase order for Belayd tasks |
| `src/workflow-registry.ts` | Workflow sub-type registry — defines 7 workflow types with phase sequences, |
| `src/workflow-state.ts` | Belayd workflow state persistence |
| `src/handoff.ts` | Handoff packets carried from a parent session into a spawned orchestrator |
| `src/quality-gates.ts` | Deterministic quality gates for Belayd agents |
| `src/proof-dir.ts` | Proof-of-work relocation helpers |
| `src/proof-verification.ts` | Proof verification support — non-blocking, advisory review of produced |
| `src/review-context.ts` | Review scoping, output bounding, line-numbered diff and reviewer process rules (bd-113, bd-159) |
| `src/run-manifest.ts` | Run manifests for individual phase-agent executions |
| `src/run-detached.ts` | Detached background run orchestration |
| `src/session-naming.ts` | Session naming utilities for subagent session management |
| `src/session-transcript.ts` | Session transcript helpers |
| `src/session-conditions.ts` | Session condition checks for proactive notifications |
| `src/claim-registry.ts` | Cross-extension registration dedup |
| `src/chdir-guard.ts` | Guard for restoring a session's working directory |
| `src/argv.ts` | Minimal POSIX-ish argv tokenizer, shared by the `bd` tool and `/belayd` |
| `src/bd-command.ts` | Validation for `bd` (beads) commands proxied by the `bd` tool |
| `src/beads-actor.ts` | Beads actor identity (bd-150) |
| `src/beads-assignee.ts` | Assignee ownership mirror (bd-150) |
| `src/bead-comments.ts` | Phase-deliverable bead comments: `[belayd:<phase>]` body header and `bd show` comment stripping |
| `src/belayd-command-args.ts` | `/belayd` argument parsing |
| `src/bash-timeout.ts` | Enforce a bounded timeout on every agent bash call |
| `src/instruction-groups.ts` | Managed instruction groups for the pi system prompt |
| `src/cast-utils.ts` | Terminal-output cleaning and asciicast parsing utilities |

### models

| File | Purpose |
|---|---|
| `src/model-classes.ts` | Model classes — named capability tiers for Belayd sub-agents |
| `src/model-cooldown.ts` | Model cooldown store with optional file persistence |
| `src/model-session-state.ts` | Session-scoped mutable model-routing state (bd-116) |
| `src/model-telemetry.ts` | Per-(phase, model) execution telemetry |
| `src/capacity-cache.ts` | Pre-dispatch provider capacity cache |
| `src/quota-failure.ts` | Failure classification (quota, transient, model-unavailable, auth) and `isFallbackWorthy` |
| `src/llmgateway-models.ts` | LLM Gateway models.json mapping — pure functions |

### worktree

| File | Purpose |
|---|---|
| `src/worktree.ts` | Injectable seams for {@link setupWorktree}. Production uses the real git |
| `src/owned-worktree.ts` | Bead ↔ branch ↔ worktree identity preflight |
| `src/stack-rebase.ts` | Stacked-branch domain logic: recording which branch a follow-up worktree was |
| `src/stale-file-guard.ts` | Stale-file detection pi extension |

### outline

| File | Purpose |
|---|---|
| `src/outline.ts` | Multi-language symbol outline for large source files |
| `src/outline-ctags.ts` | universal-ctags extractor for `belayd_outline` |
| `src/outline-ast-grep.ts` | ast-grep extractor for `belayd_outline` |
| `src/outline-extract.ts` | Outline extraction orchestration: run the two external extractors, merge |
| `src/outline-binary.ts` | Binary resolution and spawn-failure formatting shared by the outline |

### archify

| File | Purpose |
|---|---|
| `src/archify.ts` | Archify diagram-generation wrapper |

### fleet

| File | Purpose |
|---|---|
| `src/fleet-accept.ts` | Accepting a landed member: close the bead, remove the worktree (bd-126 P5) |
| `src/fleet-beads.ts` | Batched, read-only bead lookup for the fleet observer (bd-126 P0) |
| `src/fleet-heartbeat.ts` | Supervisor heartbeat for a run-mode fleet (bd-126 P5) |
| `src/fleet-launch.ts` | Fleet launch: the decision half of `belayd_fleet_launch` / `/fleet` (bd-126 P1) |
| `src/fleet-mailbox.ts` | Fleet mailbox rendering (bd-126 P1) |
| `src/fleet-merge.ts` | Fleet merge queue — P2 of the fleet supervisor (bd-126) |
| `src/fleet-mode.ts` | Fleet supervisor mode (bd-126 P1) |
| `src/fleet-pause.ts` | Cooperative fleet pause and resume (bd-126 P4) |
| `src/fleet-reconcile.ts` | Fleet-level crash reconcile and pause repair (bd-126 P4) |
| `src/fleet-run.ts` | The run-to-completion loop's decision layer: one tick, one action (bd-126 P5) |
| `src/fleet-schedule.ts` | Fleet scheduling — P3 of the fleet supervisor (bd-126) |
| `src/fleet-sessions.ts` | Member-session liveness for the fleet supervisor (bd-126 P4) |
| `src/fleet-state.ts` | Shared fleet state — the cross-tree substrate of the fleet supervisor |
| `src/fleet-status.ts` | Fleet status — read-only aggregation for the multi-bead supervisor (bd-126) |
| `src/orchestrator-claim.ts` | One-orchestrator-per-worktree lease (bd-126 P5) |

### AWS broker (`src/aws-broker/`)

| `src/aws-broker/audit.ts` | Append-only broker audit log (bd-125) |
| `src/aws-broker/aws-cli.ts` | Credential resolution for the broker, delegated to the AWS CLI (bd-125) |
| `src/aws-broker/cache.ts` | Per-scope credential cache (bd-125) |
| `src/aws-broker/client.ts` | `credential_process` client (bd-125) |
| `src/aws-broker/config.ts` | Operator allowlist + per-repo AWS profile config (bd-125) |
| `src/aws-broker/daemon.ts` | Broker daemon (bd-125) |
| `src/aws-broker/ensure.ts` | On-demand scope creation (bd-125) |
| `src/aws-broker/entrypoint.ts` | Entry-point detection for the broker CLI files (bd-125) |
| `src/aws-broker/main.ts` | `belayd-aws` CLI entry point (bd-125) |
| `src/aws-broker/plan.ts` | Sandbox plan resolution (bd-125): everything a caller needs to run a command |
| `src/aws-broker/scope.ts` | Sandbox and socket paths for the per-repo AWS credential broker (bd-125) |
| `src/aws-broker/server.ts` | Unix-socket protocol and plumbing for the broker (bd-125) |

### Extensions (`extensions/`)

| File | Purpose |
|---|---|
| `extensions/bootstrap.ts` | `/bootstrap` pi extension — scaffold a new pnpm + turbo repo in place |
| `extensions/honcho-memory.ts` | Honcho memory pi extension — standalone entry point for bundling |
| `extensions/index.ts` | Belayd agent harness — pi project-level extension |
| `extensions/llmgateway-refresh.ts` | LLM Gateway models refresh — pi project-level extension |
| `extensions/stale-file-guard.ts` | Stale-file guard pi extension — standalone entry point for bundling |
| `extensions/worktree-guard.ts` | Worktree file guard — pi project-level extension |

### Tests

| Path | Scope |
|---|---|
| `src/__tests__/*.test.ts` | unit tests, co-located with the module they cover |
| `test/*.integration.test.ts` | integration tests (git fixtures, flake wiring, worktrees) |
| `pi-web-plugins/**/*.test.js` | browser plugin tests |
## Docs index

| Doc | Owns |
|---|---|
| `docs/packaging.md` | which extensions load, binary resolution, `belayd_doctor`, per-role tool surfaces |
| `docs/subagent-sessions.md` | session naming, retry/resume epochs, `pi --resume` |
| `docs/planning-implement-workflows.md` | `/plan` vs `/belayd`, gate behaviour, tool sets per mode |
| `docs/owned-worktree.md` | bead ↔ branch ↔ worktree ownership preflight |
| `docs/bash-timeout.md` | per-call bash timeout clamp |
| `docs/beads-actor.md` | beads actor identity (`--actor` / `BEADS_ACTOR`) and assignee ownership mirror |
| `docs/instruction-groups.md` | managed prompt sections (browser instructions) |
| `docs/model-capacity-and-telemetry.md` | capacity probing, cooldowns, per-phase telemetry |
| `docs/artifacts.md` | per-phase worktree artifacts and how a phase prompt references them |
| `docs/metrics.md` | append-only metrics event log (gate first-pass, phase economics) and its DuckDB queries |
| `docs/diff-scoped-review.md` | review scoping and output bounding |
| `docs/proof-verifier.md`, `docs/userguide-phase.md` | advisory verifier, userguide deliverable |
| `docs/playwright-proof-env.md`, `docs/agent-browser-tool.md` | proof + browser tooling |
| `docs/archify-diagrams.md` | committed diagram workflow |
| `docs/fleet.md` (+ `fleet-run/status/launch/merge/reconcile.md`) | fleet supervisor |
| `docs/aws-credential-isolation.md` | sandbox + credential broker |
| `docs/pi-web-service.md`, `docs/pi-web-agent-browser.md` | pi-web units and wiring |
| `docs/arion.md` | scotty/portainer containers |
| `docs/bootstrap.md` | `/bootstrap` scaffolding |
| `docs/llmgateway.md` | LLM Gateway models |
