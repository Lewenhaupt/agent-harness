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
├── pi-web-plugins/          # pi-web plugins (proof-of-work panel, durable-member panel+server)
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
| `src/pi-web-navigation.ts` | pi-web session pins over the web server's navigation-preferences API |
| `src/role-tools.ts` | Per-role tool surfaces |
| `src/tool-audit.ts` | Tool-surface auditing for the harness |
| `src/process-gate.ts` | Process gate — enforces mandatory phase order for Belayd tasks |
| `src/workflow-phases.ts` | Workflow phases — canonical order, phase tool names, and the pure phase-list helpers; `AwaitingHuman` and its `reviewFindings` round marker (bd-183) |
| `src/workflow-registry.ts` | Workflow sub-type registry — defines 7 workflow types with phase sequences, |
| `src/workflow-state.ts` | Belayd workflow state persistence |
| `src/handoff.ts` | Handoff packets carried from a parent session into a spawned orchestrator |
| `src/quality-gates.ts` | Deterministic quality gates for Belayd agents |
| `src/quality-gate-run.ts` | Quality-gate runner — the retry loop around a phase's deterministic gates |
| `src/proof-dir.ts` | Proof-of-work relocation helpers |
| `src/proof-receipt.ts` | Proof receipt contract (bd-181) — proof uploads leave the repository and the workflow keeps an id/URL receipt at `.belayd/proof-receipt.json` |
| `src/proof-verification.ts` | Proof verification support — non-blocking, advisory review of produced |
| `src/publish-gate.ts` | Publish gate (bd-181) — deterministic refusal of proof artifacts and out-of-scope paths in a publish payload |
| `src/review-context.ts` | Review scoping, output bounding, line-numbered diff and reviewer process rules (bd-113, bd-159) |
| `src/review-findings.ts` | Durable review findings: severity/disposition record, gate reason, and the human-gate comment body (bd-175); per-finding sensitivity and the human publication decision (bd-183) |
| `src/finding-sensitivity.ts` | Deterministic finding-sensitivity classifier (bd-183) — security topics, credential shapes, deny paths; answer parsing and the redacted one-liner |
| `src/finding-publication.ts` | Publication safety surface (bd-183) — the only supported source of deferred-finding text for a PR body (bd-184) |
| `src/run-manifest.ts` | Run manifests for individual phase-agent executions |
| `src/workflow-digest.ts` | Deterministic workflow digest for one fleet member (bd-189, tier 2) — sections, the ranked stuck verdict, and no model or transcript seam |
| `src/run-detached.ts` | Detached background run orchestration |
| `src/session-naming.ts` | Session naming utilities for subagent session management |
| `src/session-transcript.ts` | Session transcript helpers |
| `src/session-transcript-file.ts` | On-disk pi session transcripts (bd-189) — pick the file, parse the JSONL, paginate newest-first, with every read bounded |
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
| `src/capability-import-boundary.ts` | Capability import boundary (bd-179) |
| `src/instruction-groups.ts` | Managed instruction groups for the pi system prompt |
| `src/cast-utils.ts` | Terminal-output cleaning and asciicast parsing utilities |

### github

| File | Purpose |
|---|---|
| `src/github-authority.ts` | GitHub authority per repo (extending the publish config reader) and deterministic drift classification (bd-180) |
| `src/github-issue-map.ts` | Bead ↔ GitHub issue identity map with never-throw read/write seams (bd-180) |
| `src/github-ready.ts` | GitHub-primary readiness and stale-gate expiry (bd-180) |
| `src/github-append-policy.ts` | Append-only bd policy for phase agents in a GitHub-primary repo (bd-180) |
| `src/github-answer-target.ts` | Answer channel per bead: local bd thread vs mapped GitHub issue (bd-182) |
| `src/github-comments.ts` | GitHub issue-comment read/post with bot identity filter, the answer channel for GitHub-primary repos (bd-182) |

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
| `src/worktree-list.ts` | Read-only `git worktree list` probe and its porcelain parsers (a leaf module so the AWS broker can share them) |
| `src/owned-worktree.ts` | Bead ↔ branch ↔ worktree identity preflight |
| `src/stack-rebase.ts` | Stacked-branch domain logic: recording which branch a follow-up worktree was |
| `src/stale-file-guard.ts` | Stale-file detection pi extension |

Worktree layout is pinned, not inherited: every harness `wt switch` passes
`--config-set` for `worktree-path` (`src/worktree.ts` `WORKTREE_PATH_TEMPLATE`),
both as the global key and — when `wt config show --format json` reports one — on
the project-scoped `[projects."<id>"]` key, which worktrunk merges last. A
worktree is therefore always the sibling `<repo>.<branch>`. An ambient override
in `~/.config/worktrunk/config.toml` (typically the bare-repo template
`{{ repo_path }}/../{{ branch | sanitize }}`, which drops the repo prefix) would
otherwise put two repositories' same-named branches in one shared directory.

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
| `src/fleet-merge.ts` | Fleet merge queue — P2 of the fleet supervisor (bd-126); refuses a payload that carries proof (bd-181) |
| `src/fleet-mode.ts` | Fleet supervisor mode (bd-126 P1) |
| `src/fleet-ordering-gates.ts` | Fleet wave ordering as bd gates, resolved on landing not closing (bd-158) |
| `src/fleet-pause.ts` | Cooperative fleet pause and resume (bd-126 P4) |
| `src/fleet-publish.ts` | Fleet publish contract (`local`/`pr`/`push`) and its flag → repo config → git config → local resolution (bd-174.1) |
| `src/fleet-reconcile.ts` | Fleet-level crash reconcile and pause repair (bd-126 P4) |
| `src/fleet-run.ts` | The run-to-completion loop's decision layer: one tick, one action (bd-126 P5) |
| `src/fleet-schedule.ts` | Fleet scheduling — P3 of the fleet supervisor (bd-126) |
| `src/fleet-sessions.ts` | Member-session liveness for the fleet supervisor (bd-126 P4) |
| `src/fleet-state.ts` | Shared fleet state — the cross-tree substrate of the fleet supervisor |
| `src/fleet-status.ts` | Fleet status — read-only aggregation for the multi-bead supervisor (bd-126) |
| `src/fleet-supervisor-name.ts` | The supervisor session's display name: `Fleet supervisor: <beads> (<status>)` |
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

### Durable members (`src/durable-member/`)

Read-only viewer contract plus the member-owned control plane for durable
members (bd-186); design, authority matrix and the WAL probe:
`docs/durable-member-panel.md`.

**`node:sqlite` import boundary.** Production `src/` code imports it only in
`standalone-store.ts`; the plugin's mirrored `store-reader.js` does too. The
plain-JS probe fixtures `test/fixtures/durable-readonly-{writer,viewer}.mjs` and
`pi-web-plugins/durable-member/fixtures/seed-member.mjs` import it directly as a
sanctioned test-fixture exception: the two-process probe and the screenshot
seeder must run without a TypeScript build step, so routing them through the
store seam would make the probe depend on `dist/` output.

**Boundary validation.** `commands.ts` (commands) and `standalone-store.ts`
(entry/live-generation/task payloads) validate untrusted data with **zod**; the
plain-JS contract mirror stays hand-rolled because the plugin is served from
source with no build step (recorded in the SYNC WARNING on both sides and driven
by the contract parity test).

| `src/durable-member/contract.ts` | Read surface: entries, live generation, task graph, transcript, `DurableReader`, `ReadOnlySessionError`, frame reduction |
| `src/durable-member/commands.ts` | `DurableCommand` union + zod boundary schema and refusal-code mapping (requestId is the dedupe key) |
| `src/durable-member/authority.ts` | `VerifiedAuthority` tier binding (owner-set, opaque), role × kind matrix, configure/reset confirmation gate |
| `src/durable-member/dedupe.ts` | requestId ledger: in-memory map + JSONL replay, deterministic prune, bounded tombstones |
| `src/durable-member/dispatch.ts` | The one command → owner writer translation; ledger records only after a successful apply |
| `src/durable-member/socket.ts` | Member-owned control socket (one unix listener, per-tier credentials, credential→tier derivation, optional loopback TCP with published `control.port`, NDJSON auth framing) |
| `src/durable-member/mailbox.ts` | File transport: queue-origin tier, drain, receipts, retry-on-writer-failure and `rejected/` quarantine |
| `src/durable-member/viewer.ts` | Assembles a `DurableReader` over the store opened `readOnly: true`, probes the invariant on a scratch database, and reduces live-generation liveness (staleness by heartbeat bound or owner-gone seam) |
| `src/durable-member/standalone-store.ts` | Reference durable store over `node:sqlite` (stand-in, not pi-durable) and zod payload schemas |

### Extensions (`extensions/`)

| File | Purpose |
|---|---|
| `extensions/bootstrap.ts` | `/bootstrap` pi extension — scaffold a new pnpm + turbo repo in place |
| `extensions/honcho-memory.ts` | Honcho memory pi extension — standalone entry point for bundling |
| `extensions/index.ts` | Belayd agent harness — pi project-level extension **composer** (see below) |
| `extensions/llmgateway-refresh.ts` | LLM Gateway models refresh — pi project-level extension |
| `extensions/stale-file-guard.ts` | Stale-file guard pi extension — standalone entry point for bundling |
| `extensions/worktree-guard.ts` | Worktree file guard — pi project-level extension |
| `extensions/capabilities/*.ts` | One module per harness capability; not pi entry points (see below) |

#### Capability modules (bd-179)

`extensions/index.ts` used to carry every capability, so every change landed in
one 13k-line file. It is now the **composer**: it owns the entry point (the
`harnessAlreadyLoaded` claim, `FleetForceStopSeams` normalization, the
`registered from <module>` log line, and the `default export
belaydAgentHarness(pi, seamOverrides)` signature), and it calls one
`register<Capability>(pi, deps)` per capability in the original registration
order so pi hook/tool order is unchanged.

| Module | Capability |
|---|---|
| `context.ts` | Shared plumbing: exec helpers, tool-result shaping, metrics recording, phase-name constants, `CoreSessionState` |
| `fleet.ts` | The allowlisted fleet slice of the session state (`FleetSessionState`) |
| `archify.ts` | `belayd_archify` diagram tool |
| `bd.ts` | `bd` CLI proxy tool |
| `commit.ts` | `belayd_commit` + `belayd_stack_rebase`, commit preflight/runners, commit-body helpers |
| `doctor.ts` | `belayd_doctor` packaging/tool-surface report |
| `human-gate.ts` | `belayd_ask_human`, human-answer poll/detection/settlement, gate reaping; the review gate and the single choke point that records a publication choice (bd-183) |
| `metrics.ts` | `belayd_metrics` DuckDB queries over the metrics log |
| `outline.ts` | `belayd_outline` symbol map |
| `proof.ts` | Proof dirs and `belayd_proof_verifier` (the receipt contract lives in `src/proof-receipt.ts`) |
| `review.ts` | Review scoping/build (`buildReviewTask`), bounded review delivery, review↔fix guidance |
| `session-state.ts` | Per-session state store (generic over the composed type), ask-hold, beads-actor attribution, run tracking, status formatting |
| `model.ts` | Model-routing state (bd-116): capacity cache, per-workflow telemetry store, cooldown store, flush/reset rules |
| `daemon.ts` | pi-web session-daemon socket API and web-server HTTP helpers |
| `hooks.ts` | Bash timeout, process-gate `tool_call` refusal, uncommitted-files notice, workflow-completion teardown |
| `workflow-core.ts` | Gate lifecycle (`activateGate`, `applyToolGate`, `evaluateToolCallGate`), workflow messaging, phase ledger, handoff disarm, resume-from-disk, user-completion reconcile, worktree ownership |
| `phase-run.ts` | `startPhaseRun`/`startPlanningRun` background launcher, run manifest + telemetry persistence, completion delivery |
| `launch.ts` | Worktree/task helpers, handoff packet, child orchestrator session, marker persistence, lease transfer |
| `workflow-commands.ts` | `/belayd`, `/belayd-complete`, daemon wake sentinel, `input`/`session_start`/`session_shutdown` hooks |
| `workflow-context.ts` | Per-turn gate/planning context injection and the three `before_agent_start` hooks |
| `planning.ts` | `/plan` command, `belayd_plan_scout`, `belayd_plan_research` |
| `phase-tools.ts` | Per-agent phase tools and `belayd_status` |
| `supervision.ts` | Tiered supervision reads (bd-189): `belayd_workflow_digest`, `belayd_transcript_digest` (bounded child summary), `belayd_transcript` (explicit, paged raw pages) |
| `task-control.ts` | `belayd_start_task`, `belayd_start_followup`, `belayd_stop_task`, `belayd_stop_planning` |

The session state is split in two halves but stays **one runtime object**:
`CoreSessionState` (fleet-free, in `context.ts`) and `FleetSessionState`
(fleet fields, in the allowlisted `fleet.ts`) are composed by the composer into
one `SessionState` intersection. `getSessionState` is unchanged in shape, so
there is no second store and no drift-prone view; a non-fleet capability takes
`CoreSessionState` and the composer passes the full object.

The fleet supervisor block (4,615 composer lines) moved out first, then the
workflow capabilities followed through the `workflow-core` / `phase-run` /
`launch` factories, so nothing in the staged split is left in the composer.

The process core is callable without the extension too: `src/quality-gate-run.ts`
(`createQualityGateRunner`), `src/review-context.ts` (via `capabilities/review.ts`)
and `src/workflow-phases.ts` take their spawn/model/metric/phase seams as
parameters instead of closing over harness globals. The same holds for
`capabilities/workflow-core.ts` (state store + gate primitives injected) and
`capabilities/phase-run.ts` (spawn, gate runner and task reader injected).

Capability modules are **not** pi entry points: `package.json`'s
`pi.extensions` must keep listing exactly the top-level `extensions/*.ts` files
(`src/__tests__/pi-manifest.test.ts`).

**Import rules.** Two independent rules, enforced by
`src/__tests__/capability-import-boundary.test.ts` through
`src/capability-import-boundary.ts`:

1. `src/process-gate.ts` is forbidden for **every** capability module, with no
   exemption list. Gate primitives (`checkToolAllowed`, `ALL_PHASE_NAMES`,
   `markPhaseCompleted`, …) arrive as explicitly typed dependency objects
   supplied by the composer.
2. `src/fleet-*.ts` / `src/fleet-state.ts` are forbidden except for the files
   named in the test's explicit `FLEET_IMPORT_ALLOWLIST` (today only
   `capabilities/fleet.ts`). Allowlisting never permits the process gate.

The checker resolves relative specifiers to files and walks the **whole
transitive module graph** — plain imports, re-exports and literal
`await import("…")` — so a capability cannot reach a forbidden module through an
intermediate (`doctor.ts → tool-audit.ts → process-gate.ts` was the real bug it
caught). Type-only imports of intermediates are erased at runtime and are not
edges. It **fails closed**: an unreadable module, an unresolvable relative
specifier or a non-literal dynamic import fails with the file, specifier and
import chain. This is why `src/tool-audit.ts`, `src/workflow-state.ts`,
`src/fleet-mode.ts` and `src/fleet-run.ts` take phase names and
`isWorkflowComplete` from the dependency-free `src/workflow-phases.ts` instead
of `src/process-gate.ts`.

The same test carries a **size ratchet** for `extensions/index.ts`: the composer
must stay at or below the test's `INDEX_MAX_LINES` ceiling, and it is wiring only
— entry point, the exported session store, seam normalisation, the ordered
`register<Capability>` calls and the default export. Do not restate the current
line count here; `INDEX_MAX_LINES` is the single figure to compare against. New
capability code belongs in a module; if the composer must grow, raise the ceiling
deliberately and say why.

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
| `docs/durable-member-panel.md`, `docs/durable-member-userguide.md` | durable-member viewer panel and member-owned control plane (bd-186); the second is a pointer to the operator guide |
| `docs/bd-186-userguide.md` | operator walkthrough for the durable-member panel (bd-186): enable, seed, verify read/write halves, failure modes |
| `docs/bd-189-userguide.md` | operator walkthrough for the tiered supervision reads (bd-189): the four tiers, the digest verdict families, transcript digest/paging, the diagnosis playbook, failure modes |
| `docs/proof-verifier.md`, `docs/userguide-phase.md` | advisory verifier, userguide deliverable |
| `docs/playwright-proof-env.md`, `docs/agent-browser-tool.md` | proof + browser tooling |
| `docs/archify-diagrams.md` | committed diagram workflow |
| `docs/fleet.md` (+ `fleet-run/status/launch/merge/reconcile.md`) | fleet supervisor |
| `docs/github-primary.md`, `docs/bd-180-userguide.md` | GitHub-primary authority, bead ↔ issue map, drift, readiness, append-only policy |
| `docs/aws-credential-isolation.md` | sandbox + credential broker |
| `docs/pi-web-service.md`, `docs/pi-web-agent-browser.md` | pi-web units and wiring |
| `docs/arion.md` | scotty/portainer containers |
| `docs/bootstrap.md` | `/bootstrap` scaffolding |
| `docs/llmgateway.md` | LLM Gateway models |
| `docs/commandcode-provider.md` | Command Code (Goat) provider: key precedence, wire ids, plan gating |
| `docs/agent-model-class.md` | model classes, provider preference, failover contract |
