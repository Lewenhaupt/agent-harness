# Instructions for AI Agents

Rules that apply before you touch anything, plus a pointer to the doc that owns
each subsystem. The module map, the full build/release notes and the service
runbooks live in `docs/repo-layout.md` — read the section you need when you need
it instead of carrying all of it in every session.

## Technology stack

| Tool | Purpose |
|------|---------|
| TypeScript | Language (strict mode) |
| tsc | TypeScript compilation (`dist/` output) |
| Vitest | Test framework (unit, integration) |
| Biome | Formatting and linting |
| pnpm | Package manager |

## Where to look

| Question | Read |
|---|---|
| Which extension/tool loads here, and which pi binary runs an agent? | `docs/packaging.md` (start with `belayd_doctor`) |
| Where does module X live? | `docs/repo-layout.md` |
| How does a phase agent, retry or resume work? | `docs/subagent-sessions.md`, `docs/planning-implement-workflows.md` |
| Which agent wrote a bead, and who is it assigned to? | `docs/beads-actor.md` |
| How do I operate pi-web / AWS sandbox / containers? | `docs/pi-web-service.md`, `docs/aws-credential-isolation.md`, `docs/arion.md` |
| Fleet (`/fleet`), proof, review scoping, models | `docs/fleet.md`, `docs/proof-verifier.md`, `docs/diff-scoped-review.md`, `docs/model-capacity-and-telemetry.md` |

## Build and acceptance

- `pnpm build` runs `tsc` — `src/` → `dist/` (library). Extensions in `extensions/` are loaded from TypeScript source by pi; they import `../src/*.js`, not `dist/`.
- `@earendil-works/pi-coding-agent` and `typebox` are `peerDependencies` (pi provides them). The pi range must stay compatible with the flake's `pi-bare`.
- Nix bundles `dependencies` into `belayd-harness`. A lockfile change moves `fetchPnpmDeps`'s hash: `pnpm install`, then `nix build .#belayd-harness` (copy the reported `got:` hash into `flake.nix`), and the pre-push hook re-runs it. Full detail: `docs/packaging.md`.

A change is not done until:

- [ ] All tests pass: `pnpm test && pnpm test:integration`
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] Build succeeds: `pnpm build`
- [ ] No `!` non-null assertions, `any` types, or commented-out code
- [ ] Comments explain why, not what
- [ ] `import type` used for type-only imports
- [ ] If the signal protocol changed, the SYNC WARNING is updated

## Task tracking

Tasks live in **Beads** (`bd`); the managed blocks at the end of this file carry
the full protocol. **Never close tasks** — move finished work to `in_progress`
with the `human` label (`bd update <ID> --status in_progress --add-label human`);
the human closes via `wt merge`. Workflow type is resolved only from an explicit
type argument or a namespaced `wf:<type>` label (e.g. `wf:chore`); title keywords
and plain labels are ignored and default to `feature`.

## Code exploration

- **Prefer `ast_grep` over `grep`/`find`** for syntax-aware searches where the tool is available (spawned sub-agents always have it; a pi-web orchestrator may not — `belayd_doctor` says which). It is read-only.
- Use `grep`/`find` for plain text and filenames; `belayd_outline` for a symbol map with line ranges. Prefer them over hard-coded line numbers in docs and tests.
- Your working directory is already the worktree root — run commands directly, never prefix `cd <absolute worktree path> &&`.
- After an edit, do not re-read the file to find the next anchor: use `belayd_outline` or `grep -n`.

## Code style

### Functional programming

- **Pure functions preferred.** Side effects (git, spawning, filesystem I/O) are confined to documented functions.
- **No global mutable state.** The only module-level state is in `stale-file-guard.ts`, `spawn.ts` (cached pi binary) and `model-session-state.ts`.
- **Immutable data.** `const`, spread, `structuredClone`. No class mutation patterns.
- **Discriminated unions for multi-outcome functions**, `{ allowed: boolean; reason?: string }` rather than a boolean with an optional string.
- **Errors as values.** Return `{ ok: true; value } | { ok: false; error }`. Reserve `throw` for non-recoverable conditions.
- **Explicit missing data.** Narrow or return `null`; never rely on `?` without guarding (that is why `!` is banned).

### Signatures and control flow

- Positional arguments for 3 or fewer; beyond 3, one object parameter with a defined type, unpacked by name.
- Guard clauses first; `switch` for multi-branch on one variable.

### Type safety

- Never use `!`. No `any` — use `unknown` and narrow. Always `import type` for type-only imports.

### Naming

- kebab-case files/directories, PascalCase exported types, camelCase functions, units in time variables (`timeoutInMs`).

### Comments

- Explain why, not what. No commented-out code.

### Plannotator signal protocol

`src/plannotator/signal-protocol.ts` carries a **SYNC WARNING**: its types and functions are duplicated in pi-web-plugins. Changes must be mirrored, or the contract must record the divergence.

## Testing

| Type | Directory | Command |
|---|---|---|
| Unit | `src/__tests__/` | `pnpm test` |
| Integration | `test/` | `pnpm test:integration` |

- Pure functions: no mocks, pass data in and assert the return value.
- Side-effect functions: mock `node:child_process` with `vi.fn()`, not whole modules.
- Prefer `expect(...).toHaveProperty()` over direct property access; mock timers with `vi.mock("timers/promises")` for retry/polling logic.

## Communication

- **Be extremely concise.** When reporting information, sacrifice grammar for the sake of concision. Keep responses short but never drop the actual facts — include all relevant facts, omit filler words, pleasantries, and narrative padding.
- **Match the language of the user's most recent message** — headings and summaries included. Keep code, identifiers, file paths, commands, commit messages and quoted file content exactly as written; never translate them. DeepSeek primaries drift to Chinese output non-deterministically; the static block in `SHARED_AGENT_GUIDANCE` (`src/agent-registry.ts`) is the mitigation — keep it early and never vary it, and never force a reasoning language.

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

**Stale worktree branches:** A worktree branch may be behind the base branch
(`main`). A bead marked finished/closed elsewhere may simply not be present in
the current branch yet, so check `main` before duplicating work. If the work
already landed there, rebase with `git rebase main` instead of re-implementing
apparently-missing work. Mid-rebase conflicts are expected: when the branch is
re-implementing merged work, prefer the already-landed `main` implementation
over the duplicate. This permission covers rebasing the *local* worktree branch
onto the base branch only; force-pushing and rewriting shared history are NOT
implied and still require explicit approval under the active profile.

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION --><!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
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