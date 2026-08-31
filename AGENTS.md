# Instructions for AI Agents

## Technology Stack

| Tool | Purpose |
|------|---------|
| TypeScript | Language (strict mode) |
| tsc | TypeScript compilation (`dist/` output) |
| Vitest | Test framework (unit, integration) |
| Biome | Formatting and linting |
| pnpm | Package manager |

## Project Structure

```
belayd-agent-harness/
├── src/                    # Library source (published as npm package)
│   ├── index.ts            # Public API re-exports
│   ├── agent-registry.ts   # Agent definitions, types, DEFAULT_AGENTS
│   ├── spawn.ts            # Agent process spawner (pi --mode json)
│   ├── process-gate.ts     # Phase order enforcement
│   ├── workflow-registry.ts # Workflow sub-types (feature, bugfix, etc.)
│   ├── quality-gates.ts    # Deterministic quality checks (typecheck, lint, tests, proof)
│   ├── worktree.ts         # Git worktree utilities (setup, resolve, isInside)
│   ├── stale-file-guard.ts # Stale file detection (hash tracking)
│   ├── plannotator/
│   │   ├── signal-protocol.ts  # Signal file contract (SYNC WARNING: duplicated in pi-web-plugins)
│   │   └── signal-writer.ts    # Signal file read/write/poll/cleanup
│   └── __tests__/          # Unit tests (co-located)
├── extensions/             # pi extensions (loaded by pi via pi install)
│   ├── index.ts            # Main belayd-harness extension
│   └── stale-file-guard.ts # Stale-file guard extension
├── test/                   # Integration tests
├── dist/                   # Build output (tsc)
│   └── *.js, *.d.ts        # Compiled library
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── vitest.integration.config.ts
├── biome.json
└── .gitignore
```

## Build System

- **`pnpm build`** runs `tsc` — compiles `src/` → `dist/` (library).
- Extensions in `extensions/` are loaded directly by pi via `pi install -l`. They import from `dist/` at runtime.
- `@earendil-works/pi-coding-agent` and `typebox` are listed as `peerDependencies` (pi provides them at runtime).

### Nix dependency bundling (`belayd-harness`)

The flake's `belayd-harness` derivation bundles every `dependencies` entry from
`package.json` into the extension's `node_modules/` (via `fetchPnpmDeps` plus an
install of the lockfile stripped of `peerDependencies`/`devDependencies`).
`peerDependencies` and `devDependencies` are **not** bundled.

When adding, removing, or changing a `dependencies` entry:

1. `pnpm install` — regenerate `pnpm-lock.yaml`.
2. `nix build .#belayd-harness` — fails with `hash mismatch … got: sha256-…`.
3. Copy the `got:` hash into `belayd-harness.pnpmDeps.hash` in `flake.nix`.
4. Re-run `nix build .#belayd-harness`.

## Checking local services

Two runtimes back the harness. Inspect them when diagnosing session,
task-tracking, or container problems.

### pi-web (systemd system service)

Declared via the flake's `nixosModules.pi-web` and enabled in the NixOS config
(`services.belayd-pi-web.enable`); installed by `nixos-rebuild`, not an
imperative installer (this host's `/etc` is read-only).

```bash
systemctl status pi-web pi-web-sessiond              # health of both units
journalctl -u pi-web -f                              # web/API logs
journalctl -u pi-web-sessiond -f                     # session daemon logs
journalctl -u pi-web -u pi-web-sessiond --since -1h  # recent, both units
```

Restart (sudo):

```bash
sudo systemctl restart pi-web pi-web-sessiond
```

### scotty / portainer / beads-shared-server (arion containers)

```bash
nix develop -c arion ps              # container list + state
nix develop -c arion logs -f         # follow all container logs
nix develop -c arion logs -f scotty  # one service only
```

Raw container engine (this host runs Podman behind a Docker socket):

```bash
podman ps -a
podman logs --tail 200 scotty
```

Portainer UI: `https://localhost:9443`.

## Task tracking

Tasks live in **Beads** (`bd`). Load the **beads** skill for the CLI reference.
**Never close tasks** — move finished work to `in_review` (`bd update <ID> --status in_review`);
the human closes via `wt merge`. Workflow type is resolved from task labels.

## Code exploration

- **Prefer `ast_grep` over `grep`/`find` for syntax-aware code searches** — use it when you need to find structural patterns (function definitions, call expressions, imports) or when text grep would produce false positives.
- `ast_grep` is read-only. Inspect matches with `read`/`edit`/`write` only after deciding on concrete changes.
- Use `grep`/`find` for plain-text and filename searches.

## Code Style

### Functional programming

- **Pure functions preferred.** Business logic should be pure functions. Side effects (shelling out to git, spawning processes, filesystem I/O) are confined to well-documented functions.
- **No global mutable state.** Pass state through function arguments. The only module-level state is in `stale-file-guard.ts` (file hash map) and `spawn.ts` (cached pi binary path), both reset on extension lifecycle.
- **No class mutation patterns.** Prefer standalone functions and plain objects.
- **Immutable data.** Use `const`, spread operators, `structuredClone`.
- **Discriminated unions for multi-outcome functions.** Use `{ allowed: boolean; reason?: string }` rather than boolean returns with optional error strings.
- **Errors as values, not exceptions.** Return expected failure results via discriminated unions (e.g. `{ ok: true; value: T } | { ok: false; error: string }`). Reserve `throw` for truly unexpected, non-recoverable conditions.
- **Explicit missing data.** Use discriminated unions or explicit `null` checks to represent optional/missing data. Never rely on `?` optional chaining without guarding first — this is why `!` is banned.

### Function signatures

- **Positional arguments for 3 or fewer.** Beyond 3, use a single object parameter with a defined type.
- **Object parameters must be unpacked with a defined type**, not inline.

### Control flow

- **Guard clauses first.** Check error conditions early and return/throw. Avoid deep nesting.
- **Switch statements for multi-branch conditions.** Do not chain `if/else if` for the same variable.

### Type safety

- **Never use `!` non-null assertion.** Use proper checks instead.
- **Always use `import type` for type-only imports.**
- **No `any` types.** Use `unknown` and narrow, or define a proper type.

### Naming

- **kebab-case for files and directories.** `agent-registry.ts`, `stale-file-guard.ts`.
- **PascalCase for exported types and interfaces.** `AgentDefinition`, `SpawnOptions`.
- **camelCase for exported functions.** `spawnAgentProcess`, `checkToolAllowed`.
- **Time variables include units.** `timeoutInMs`, `maxAgeInDays`.

### Comments

- **Explain why, not what.** Provide context and rationale.
- **No commented-out code.** Git history preserves it.

### Plannotator signal protocol

The `src/plannotator/signal-protocol.ts` file contains a **SYNC WARNING** block — its types and functions are duplicated in the pi-web-plugins repository. Any changes to the signal protocol must be mirrored in both places, or the contract must be updated to note the divergence.

## Testing

### Test locations

| Test type | Directory | Vitest pattern | Run command |
|-----------|-----------|----------------|-------------|
| Unit | `src/__tests__/` | `src/**/*.test.ts` | `pnpm test` |
| Integration | `test/` | `test/**/*.integration.test.ts` | `pnpm test:integration` |

### Testing conventions

- **Tests for pure functions use no mocks** — pass all data as arguments, assert on return values.
- **Tests for side-effect functions mock** `node:child_process` with `vi.fn()`, not entire modules.
- **Assertions use `expect(...).toHaveProperty()`** instead of direct property access for better failure messages.
- **Mock timers** with `vi.mock("timers/promises")` when testing retry/polling logic.

## Communication

- **Be extremely concise.** When reporting information to me, sacrifice grammar for the sake of concision. Keep responses short but never drop the actual facts — include all relevant facts, omit filler words, pleasantries, and narrative padding.

## Acceptance Criteria

A change is not done until:

- [ ] All tests pass: `pnpm test && pnpm test:integration`
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] Build succeeds: `pnpm build`
- [ ] No `!` non-null assertions, `any` types, or commented-out code
- [ ] Comments explain why, not what
- [ ] `import type` used for type-only imports
- [ ] If the signal protocol changed, the SYNC WARNING is updated

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a shared Dolt server (`dolt.shared-server: true`, `dolt_mode: server`), not in local files. Read/write only via `bd` (tool or CLI) — never read `.beads/issues.jsonl` or `.beads/dolt/` directly; the JSONL export is not generated here.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a shared Dolt server (`dolt.shared-server: true`, `dolt_mode: server`), not in local files. Read/write only via `bd` (tool or CLI) — never read `.beads/issues.jsonl` or `.beads/dolt/` directly; the JSONL export is not generated here.
<!-- END BEADS CODEX SETUP -->
