# Instructions

__PROJECT_ONELINER__

## Technology Stack

<!-- TODO(agent): replace this table with the project's real stack (Tool | Purpose | Package). -->

| Tool | Purpose | Package |
|------|---------|---------|
| TypeScript | Language (strict mode) | all packages |
| tsc | TypeScript compilation (`dist/` output) | all packages |
| Vitest | Test framework (unit, integration) | all packages |
| Biome | Formatting and linting | root |
| Turbo | Monorepo task orchestration | root |
| pnpm | Package manager | root |
| Nix | Reproducible devShell | root |

## Project Structure

<!-- TODO(agent): replace this tree with the real package layout. -->

```
packages/
  core/            # starter package — rename or extend as needed
    src/           # library source (compiled to dist/)
    test/          # integration tests
```

## Documentation Map

<!-- TODO(agent): list the project's docs and what each covers. -->

| Document | What it covers |
|----------|---------------|
| `README.md` | Project overview and quick start |
| `AGENTS.md` | This file — agent instructions |

## Code Style

### Functional programming

- **Pure functions preferred.** Business logic should be pure functions. Side
  effects (I/O, network, process spawning) are confined to well-documented
  functions.
- **No global mutable state.** Pass state through function arguments.
- **No class mutation patterns.** Prefer standalone functions and plain objects.
- **Immutable data.** Use `const`, spread operators, `structuredClone`.
- **Discriminated unions for multi-outcome functions.** Use
  `{ allowed: boolean; reason?: string }` rather than boolean returns with
  optional error strings.
- **Errors as values, not exceptions.** Return expected failure results via
  discriminated unions (e.g. `{ ok: true; value: T } | { ok: false; error: string }`).
  Reserve `throw` for truly unexpected, non-recoverable conditions.
- **Explicit missing data.** Use discriminated unions or explicit `null` checks
  to represent optional/missing data. Never rely on `?` optional chaining
  without guarding first — this is why `!` is banned.

### Function signatures

- **Positional arguments for 3 or fewer.** Beyond 3, use a single object
  parameter with a defined type.
- **Object parameters must be unpacked with a defined type**, not an inline type.
- Use `Pick` when a function only needs a subset of a larger type.

### Control flow

- **Guard clauses first.** Check error conditions early and return/throw. Avoid
  deep nesting.
- **Switch statements for multi-branch conditions.** Do not chain `if/else if`
  for the same variable.

### Type safety

- **Never use `!` non-null assertion.** Use proper checks instead.
- **Always use `import type` for type-only imports.**
- **No `any` types.** Use `unknown` and narrow, or define a proper type.

### Naming

- **kebab-case for files and directories.** `quality-gates.ts`.
- **PascalCase for exported types and interfaces.** `QualityGateResult`.
- **camelCase for exported functions.** `runQualityGate`.
- **Time variables include units.** `timeoutInMs`, `maxAgeInDays`.

### Comments

- **Explain why, not what.** Provide context and rationale.
- **No commented-out code.** Git history preserves it.

## Testing

### Test locations

| Test type | Directory | Vitest pattern | Run command |
|-----------|-----------|----------------|-------------|
| Unit | `packages/*/src/` (co-located) | `*.test.ts` | `pnpm test` |
| Integration | `packages/*/test/` | `*.integration.test.ts` | `pnpm test:integration` |

### Testing conventions

- **Tests for pure functions use no mocks** — pass all data as arguments, assert
  on return values.
- **Tests for side-effect functions mock** `node:child_process` with `vi.fn()`,
  not entire modules.
- **Assertions use `expect(...).toHaveProperty()`** instead of direct property
  access for better failure messages.
- **Mock timers** with `vi.mock("timers/promises")` when testing retry/polling
  logic.

## Beads task tracking

Tasks live in **Beads** (`bd`). Load the **beads** skill for the CLI reference.

- **Never close tasks.** Move finished work to `in_progress` with the `human`
  label (`bd update <ID> --status in_progress --add-label human`); the human
  closes via `wt merge`. Workflow type is resolved from task labels.
- Use `bd` for all task tracking — do not create markdown TODO lists.
- Keep persistent project memory in Beads via `bd remember`.

## Acceptance Criteria

A change is not done until:

- [ ] All tests pass: `pnpm test && pnpm test:integration`
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Lint passes: `pnpm lint`
- [ ] Build succeeds: `pnpm build`
- [ ] No `!` non-null assertions, `any` types, or commented-out code
- [ ] Comments explain why, not what
- [ ] `import type` used for type-only imports
