---
id: TASK-4
title: Add proof-of-work viewer plugin for pi-web
status: Done
assignee: []
created_date: '2026-08-01 10:06'
updated_date: '2026-08-13 20:10'
labels:
  - feature
  - implementation
dependencies: []
references:
  - plans/verifiable-proof.md
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create a pi-web plugin that shows proof-of-work artifacts (browser videos, screenshots, asciinema recordings) in a workspace panel.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Add asciinema-player npm package to pi-web's plugin dependencies
- [ ] #2 Create a pi-web plugin with a workspace panel that lists proof-of-work/<task-id>/ contents
- [ ] #3 Render .webm videos with native HTML video element
- [ ] #4 Render .cast files with asciinema-player
- [ ] #5 Render .png/.jpeg images inline
- [ ] #6 Group artifacts by task ID and show descriptive filenames
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Now I have a clear picture of the changes. Let me write the proper user-facing documentation.

---

## How to Verify

### Verify the scoped typecheck hook is installed and functional

1. **Check that lefthook is installed** (it runs automatically via `pnpm devPreinstall`, but confirm):
   ```bash
   cd /home/user/git/package-proxy-v2
   npx lefthook check
   ```
   Expected: exits 0 with no errors, showing lefthook config is valid.

2. **Verify the hook runs when staged files exist in a single package:**
   ```bash
   # Create a trivial change in only the shared package and stage it
   echo "" >> packages/shared/src/index.ts
   git add packages/shared/src/index.ts
   npx lefthook run pre-commit 2>&1 | head -40
   git restore packages/shared/src/index.ts
   ```
   Expected in the output:
   - `biome format + lint (staged)` runs on the changed file
   - `typecheck` runs `CI=1 pnpm turbo run typecheck --filter=@belayd/shared...` (only the shared package + its dependents)
   - `lint (full)` runs
   - `tests` runs (skip this with `LEFTHOOK_SKIP=test` if you want to verify quickly)

3. **Verify typecheck is skipped when no staged package changes exist:**
   ```bash
   # Stage a root-only change (e.g., this markdown file)
   git add README.md  # if it exists, or any file outside packages/
   npx lefthook run pre-commit 2>&1 | grep -i "skip\|No staged"
   git restore --staged README.md
   ```
   Expected: `No staged package changes — skipping typecheck`

4. **Verify typecheck scopes correctly across multiple packages:**
   ```bash
   # Stage changes in two different packages
   echo "" >> packages/shared/src/index.ts
   echo "" >> packages/proxy/src/index.ts
   git add packages/shared/src/index.ts packages/proxy/src/index.ts
   npx lefthook run pre-commit 2>&1 | grep "turbo run typecheck"
   ```
   Expected: the turbo command includes `--filter=@belayd/proxy... --filter=@belayd/shared...` (or similar package names with dependents). Both changed packages' chains are typechecked.

5. **Verify `CI=1` prevents PTY hang** (this is an environment safeguard):
   ```bash
   # Confirm CI=1 is exported before the turbo command
   npx lefthook run pre-commit 2>&1 | grep "CI=1"
   ```
   Expected: `CI=1 pnpm turbo run typecheck ...` is visible in the output.

6. **Undo test changes:**
   ```bash
   git restore packages/shared/src/index.ts packages/proxy/src/index.ts
   ```

---

## How to Use

### New behavior: scoped typecheck in pre-commit

The `typecheck` job in `lefthook.yml` now only typechecks the packages that have staged changes (plus their dependents via turbo's `--filter=<pkg>...`), instead of running a full project-wide typecheck. This makes the pre-commit hook significantly faster for small, focused commits.

**Package-to-turbo-filter mapping:**

| Staged file path | Turbo filter |
|---|---|
| `packages/shared/*` | `--filter=@belayd/shared...` |
| `packages/proxy/*` | `--filter=@belayd/proxy...` |
| `packages/audit/*` | `--filter=@belayd/audit...` |
| `packages/auth/*` | `--filter=@belayd/auth...` |
| `packages/cli/*` | `--filter=@belayd/cli...` |
| `packages/dashboard/spa/*` | `--filter=@belayd/dashboard-spa...` |
| `packages/dashboard/*` | `--filter=@belayd/dashboard...` |
| `packages/event-delivery/*` | `--filter=@belayd/event-delivery...` |
| `packages/rules-engine/*` | `--filter=@belayd/rules-engine...` |
| Any other path | no filter — typecheck is skipped |

The `...` suffix on turbo filters ensures that **dependents** of the changed package are also typechecked (e.g., changing `@belayd/shared` triggers typecheck of every package that depends on it).

**Skipping typecheck entirely:**

If staged files only touch root-level files (`package.json`, `lefthook.yml`, `docs/`, etc.) or unknown paths, the hook prints:
```
No staged package changes — skipping typecheck
```
and exits 0.

**Skipping tests temporarily during dev:**

```bash
LEFTHOOK_SKIP=test git commit -m "wip: quick check"
```

**CI=1 environment variable:**

The `CI=1` prefix prevents a known PTY hang that occurs when `turbo` runs inside the lefthook hook environment. It disables interactive terminal features in turbo. Do not remove it.

**Running the full typecheck explicitly (when needed):**

If you want to typecheck everything regardless of staged files (e.g., before pushing):

```bash
pnpm turbo run typecheck
# or, equivalently
pnpm typecheck
```

Now I have a clear picture of the changes. Let me write the proper user-facing documentation.

---

## How to Verify

### Verify the scoped typecheck hook is installed and functional

1. **Check that lefthook is installed** (it runs automatically via `pnpm devPreinstall`, but confirm):
   ```bash
   cd /home/user/git/package-proxy-v2
   npx lefthook check
   ```
   Expected: exits 0 with no errors, showing lefthook config is valid.

2. **Verify the hook runs when staged files exist in a single package:**
   ```bash
   # Create a trivial change in only the shared package and stage it
   echo "" >> packages/shared/src/index.ts
   git add packages/shared/src/index.ts
   npx lefthook run pre-commit 2>&1 | head -40
   git restore packages/shared/src/index.ts
   ```
   Expected in the output:
   - `biome format + lint (staged)` runs on the changed file
   - `typecheck` runs `CI=1 pnpm turbo run typecheck --filter=@belayd/shared...` (only the shared package + its dependents)
   - `lint (full)` runs
   - `tests` runs (skip this with `LEFTHOOK_SKIP=test` if you want to verify quickly)

3. **Verify typecheck is skipped when no staged package changes exist:**
   ```bash
   # Stage a root-only change (e.g., this markdown file)
   git add README.md  # if it exists, or any file outside packages/
   npx lefthook run pre-commit 2>&1 | grep -i "skip\|No staged"
   git restore --staged README.md
   ```
   Expected: `No staged package changes — skipping typecheck`

4. **Verify typecheck scopes correctly across multiple packages:**
   ```bash
   # Stage changes in two different packages
   echo "" >> packages/shared/src/index.ts
   echo "" >> packages/proxy/src/index.ts
   git add packages/shared/src/index.ts packages/proxy/src/index.ts
   npx lefthook run pre-commit 2>&1 | grep "turbo run typecheck"
   ```
   Expected: the turbo command includes `--filter=@belayd/proxy... --filter=@belayd/shared...` (or similar package names with dependents). Both changed packages' chains are typechecked.

5. **Verify `CI=1` prevents PTY hang** (this is an environment safeguard):
   ```bash
   # Confirm CI=1 is exported before the turbo command
   npx lefthook run pre-commit 2>&1 | grep "CI=1"
   ```
   Expected: `CI=1 pnpm turbo run typecheck ...` is visible in the output.

6. **Undo test changes:**
   ```bash
   git restore packages/shared/src/index.ts packages/proxy/src/index.ts
   ```

---

## How to Use

### New behavior: scoped typecheck in pre-commit

The `typecheck` job in `lefthook.yml` now only typechecks the packages that have staged changes (plus their dependents via turbo's `--filter=<pkg>...`), instead of running a full project-wide typecheck. This makes the pre-commit hook significantly faster for small, focused commits.

**Package-to-turbo-filter mapping:**

| Staged file path | Turbo filter |
|---|---|
| `packages/shared/*` | `--filter=@belayd/shared...` |
| `packages/proxy/*` | `--filter=@belayd/proxy...` |
| `packages/audit/*` | `--filter=@belayd/audit...` |
| `packages/auth/*` | `--filter=@belayd/auth...` |
| `packages/cli/*` | `--filter=@belayd/cli...` |
| `packages/dashboard/spa/*` | `--filter=@belayd/dashboard-spa...` |
| `packages/dashboard/*` | `--filter=@belayd/dashboard...` |
| `packages/event-delivery/*` | `--filter=@belayd/event-delivery...` |
| `packages/rules-engine/*` | `--filter=@belayd/rules-engine...` |
| Any other path | no filter — typecheck is skipped |

The `...` suffix on turbo filters ensures that **dependents** of the changed package are also typechecked (e.g., changing `@belayd/shared` triggers typecheck of every package that depends on it).

**Skipping typecheck entirely:**

If staged files only touch root-level files (`package.json`, `lefthook.yml`, `docs/`, etc.) or unknown paths, the hook prints:
```
No staged package changes — skipping typecheck
```
and exits 0.

**Skipping tests temporarily during dev:**

```bash
LEFTHOOK_SKIP=test git commit -m "wip: quick check"
```

**CI=1 environment variable:**

The `CI=1` prefix prevents a known PTY hang that occurs when `turbo` runs inside the lefthook hook environment. It disables interactive terminal features in turbo. Do not remove it.

**Running the full typecheck explicitly (when needed):**

If you want to typecheck everything regardless of staged files (e.g., before pushing):

```bash
pnpm turbo run typecheck
# or, equivalently
pnpm typecheck
```
<!-- SECTION:NOTES:END -->
