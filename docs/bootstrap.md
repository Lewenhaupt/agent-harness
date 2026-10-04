# `/bootstrap` — scaffold a new repo

`/bootstrap` writes a fresh pnpm + turbo monorepo into the **current directory**
(which must be empty, hold only `.git`, or be a resumable `/bootstrap`
scaffold), runs the mechanical setup steps, and then hands the prose work off
to the agent.

```
/bootstrap
```

There are no arguments. The project name and npm scope are derived from the
current directory name (lowercased; every run of disallowed characters becomes a
single dash). Run it from an empty directory, e.g.:

```bash
mkdir ~/git/my-new-project && cd ~/git/my-new-project
pi            # from the harness devShell
> /bootstrap
```

## What the command writes

Everything under `templates/bootstrap/` in the harness repo:

| Path | Contents |
|------|----------|
| `flake.nix` | Core-only devShell: nodejs, pnpm, typescript, biome, beads + dolt + procps, worktrunk, the configured `agent-harness.packages.<sys>.pi`, gcc lib |
| `.envrc` | `use flake` |
| `package.json` | Private root, `packageManager: pnpm@10.28.0`, turbo scripts, pinned devDeps, `preinstall: npx only-allow pnpm` |
| `pnpm-workspace.yaml` | `packages/*` |
| `turbo.json` | Task graph for build / dev / typecheck / test / test:integration / lint |
| `biome.json` | Reference lint + format config |
| `tsconfig.base.json` | Strict NodeNext base config |
| `lefthook.yml` | Pre-commit: biome staged-fix, full biome, turbo typecheck + test (changed packages) |
| `.config/wt.toml` | Worktrunk hooks (copy-ignored, direnv + install, bead in-progress, post-merge close) |
| `.gitignore` | node_modules / dist / coverage / .turbo / Nix / beads / pi sections |
| `.pi/settings.json` | `packages: ["../../belayd-agent-harness"]` |
| `AGENTS.md` | Generic Code Style / Testing / Acceptance sections; project sections left as `TODO(agent)` |
| `README.md` | One-paragraph stub with `__PROJECT_DESCRIPTION__` |
| `packages/core/**` | Starter `@<scope>/core` package: `src/index.ts` + passing test, tsconfig, vitest configs |

Placeholders are uppercased and double-underscore delimited:
`__PROJECT_NAME__`, `__PACKAGE_SCOPE__`, `__PROJECT_DESCRIPTION__`,
`__PROJECT_ONELINER__`.

## Scripted vs. agent-owned

**Scripted by the command (mechanical):**

1. Preconditions: target directory is empty (or only `.git`), **or** is a
   resumable scaffold (see below); `nix` / `pnpm` / `git` / `bd` / `direnv` on
   `PATH`; template directory resolvable from the extension module (works both
   from the dev checkout and the Nix store copy).
2. Copy `templates/bootstrap/**` into the target directory (overwriting
   existing template files, so a re-run does not collide).
3. Substitute the **identifier** tokens (`__PROJECT_NAME__`,
   `__PACKAGE_SCOPE__`) from the sanitized directory name, in the copied
   template files only.
4. `git init` (skipped when `.git` already exists).
5. `git add -A` (always runs; idempotent). `nix flake lock` evaluates the
   flake through Git and refuses to read untracked files, so the scaffold must
   be staged before locking. On resume this re-stages whatever the interrupted
   run left behind.
6. `nix flake lock` (skipped when `flake.lock` already exists).
7. `direnv allow`.
8. `pnpm install` (skipped when `node_modules` already exists).
9. `lefthook install` (skipped when `.git/hooks/pre-commit` already exists).
10. `bd init --shared-server --external --non-interactive --init-if-missing`,
    then `bd config set dolt.auto-start false` (verified with
    `bd config get dolt.auto-start`), then `bd prime`. No `sync.remote` is set.
    `--init-if-missing` makes a re-run a no-op.

The template intentionally omits the reference's
`pnpm:devPreinstall: lefthook install` hook: pnpm runs it **before**
`node_modules/.bin/lefthook` exists, so a clean `pnpm install` fails with
`lefthook: command not found`. Step 9 is the supported way to install hooks
(and `pnpm install` / `pnpm exec lefthook` cannot see the bin at that point).

**Agent-owned (delivered as a `belayd-bootstrap` message that triggers a turn):**

1. Replace the prose placeholders (`__PROJECT_DESCRIPTION__`,
   `__PROJECT_ONELINER__`).
2. Fill the AGENTS.md project sections (Technology Stack table, Project
   Structure tree, Documentation Map).
3. Rename/extend `packages/core` (and the workspace globs) if the project needs
   more packages.
4. Confirm `pnpm turbo run build typecheck lint test` is green.
5. Create the initial commit.

Only the identifier tokens are substituted by the script because `pnpm install`
runs in the same pass and npm rejects an uppercase `@__PACKAGE_SCOPE__/core`.
The prose tokens need human judgement and are left for the handoff turn.

On the first failure the command aborts, reports the failing step **and the
exact remaining commands** via `ctx.ui.notify`, and leaves the scaffold in
place.

### Resuming after a failure

A re-run is resumable. The precondition accepts a directory whose entries are
all ours: **at least two** scaffold-signature entries (`.config`, `turbo.json`,
`pnpm-workspace.yaml`, `lefthook.yml`) must be present, and every entry must
come from the template tree or the generated-artifact set (`node_modules`,
`flake.lock`, `.direnv`, `.beads`, `dist`, …). A directory that merely happens
to contain e.g. a `package.json` is rejected, so `/bootstrap` never overwrites
an unrelated repo. `flake.nix` and `.pi` are deliberately **not** signatures:
`nix flake init` creates the former and any pi-aware repo the latter, so either
alone would misclassify a real project; requiring two distinctive markers keeps
a stray `.config/` from qualifying too.

On resume, template files are copied again (overwriting the previous attempt)
and identifier tokens are re-substituted in the template files only — the
substitution never walks `node_modules` or `.beads`. `AGENTS.md` is preserved
once it already carries a `bd`-managed block, because `bd init` injects those
blocks and the skipped `bd init` would not re-inject them; a plain AGENTS.md is
still overwritten so a partial copy is repaired. Steps whose artifacts
already exist are skipped: `.git` → `git init`, `flake.lock` → `nix flake
lock`, `node_modules` → `pnpm install`, `.git/hooks/pre-commit` → `lefthook
install`. `git add -A` is **not** skipped: it is idempotent and must run
whenever the scaffold is retried, because a run that died at `nix flake lock`
left `.git` behind with the scaffold files untracked, and Nix would otherwise
abort again on the same "not tracked by Git" error. `bd init
--init-if-missing` is idempotent, and `bd prime` is safe to re-run.

The failure notification lists the manual commands in order, so a user who
prefers to finish by hand does not have to reconstruct them.

## Beads wiring

`bd init` joins the already-running shared Dolt server. This is why the command
uses `--shared-server --external` rather than a plain `bd init` followed by
`bd config set dolt.shared-server true`:

- A plain `bd init` creates an **embedded** database.
- Setting `dolt.shared-server true` afterwards makes `bd` route to the shared
  server for that run, but `.beads/metadata.json` stays pinned to
  `dolt_mode: "embedded"`, so later commands fail with
  `database "<name>" not found on Dolt server`.
- `bd init --shared-server --external` skips server startup (the shared server
  is externally managed), creates the database on the shared server, and writes
  `dolt_mode: "server"` into `.beads/metadata.json` and
  `dolt.shared-server: true` into `.beads/config.yaml`.
- `bd config set dolt.auto-start false` stores the value as the boolean `false`
  in `.beads/config.yaml`; the command verifies this with
  `bd config get dolt.auto-start` (bd 1.2.2 returns `false`). If a future `bd`
  stops honouring the key, set `dolt.auto-start: false` in `.beads/config.yaml`
  by hand.

If the shared server is not running, the beads step fails and the scaffold is
left in place — start the shared server and re-run `/bootstrap` to resume.

`bd init` also injects its managed AGENTS.md blocks and installs the beads git
hooks. Because `lefthook install` runs **before** `bd init`, `bd` migrates the
existing lefthook hook into `.beads/hooks/` and appends its own section
(lefthook first, then `bd hooks run <hook>`), and points `core.hooksPath` there.

Note: this `bd` version creates a `bd init: initialize beads issue tracking`
commit as part of init. The command itself stops before the project's initial
commit, which the agent creates in the handoff turn.

## `--no-extensions` (`-ne`) caveat

The Nix-built `pi` and this repo's `bin/pi` run with `-ne`, which disables all
extension auto-discovery — global directories, the global settings
`extensions`/`packages` arrays, **and** the project `.pi/settings.json`
`packages` array. `/bootstrap` is baked into the devShell's
`agent-harness.packages.<sys>.pi` and is re-added explicitly by `bin/pi`, so it
is available under `-ne`.

The scaffold's `.pi/settings.json` (`packages: ["../../belayd-agent-harness"]`)
therefore only matters for a **bare** `pi` (no `-ne`) run from the new repo: it
loads the sibling harness checkout so the new repo picks up `/belayd`, `/plan`,
and the harness tools. Under `-ne` it is ignored.

## Templates are a copy of the reference repo

`templates/bootstrap/` is adapted from `/home/hugo/git/package-proxy-v2`
(flake.nix, package.json, biome.json, turbo.json, tsconfig.base.json,
lefthook.yml, .config/wt.toml, .envrc, .gitignore, .pi/settings.json,
AGENTS.md), stripped of everything project-specific (arion, the Docker image,
playwright / pi-web / plannotator / portless, CI, domain packages).

There is no automated test comparing the template to the reference, so **drift
is expected**: when the reference repo's tooling changes, update the template by
hand. The automated coverage is the pure helpers and the copy/substitution path
in `src/__tests__/extension-bootstrap.test.ts`, plus a scan asserting the
template tree contains no `!` non-null assertions or `any` types and uses only
the four defined placeholder tokens. The remaining scripted I/O flow is
verified manually.

### Pre-commit filter and unborn HEAD

`templates/bootstrap/lefthook.yml` guards the `--filter=...[HEAD]` turbo filter
with `git rev-parse --verify --quiet HEAD`: on the very first commit HEAD does
not exist yet (bd init creates the first commit), and turbo 2.5.5 exits 1 when
asked to resolve it. In that window the hook runs all packages instead. This was
verified against turbo 2.5.5 for both the unborn-HEAD and committed cases.

The harness root `biome.json` excludes the template tree (`"!templates"` in
`files.includes`). This is deliberate: `templates/bootstrap/biome.json` is a
second Biome root config, and Biome rejects a nested root config inside the
harness repo. Excluding the whole directory keeps the harness lint green while
leaving the template's own config a proper standalone root (so the generated
repo lints and formats itself). Template files are therefore only validated by
the generated repo's toolchain, not by the harness `pnpm lint`.

## How to Verify

Run these in order. Steps 1–2 are the harness gates; steps 3–12 are the
end-to-end run. The scaffold's own `.beads/` files are never read directly —
every beads assertion goes through `bd`.

### 1. Harness gates

```bash
pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
nix build .#belayd-harness
```

`nix build` must succeed so the devShell's `pi` carries `/bootstrap` (see the
`-ne` caveat). If it fails with `hash mismatch … got: sha256-…`, copy the hash
into `belayd-harness.pnpmDeps.hash` in `flake.nix` and rebuild.

### 2. Unit coverage of the pure helpers

```bash
pnpm test -- extension-bootstrap
```

Covers `sanitizeProjectName`, `classifyTargetDir`, `substituteIdentifierTokens`,
`hasBeadsManagedBlock`, the copy/substitution round-trip, the handoff text, the
`/bootstrap` registration, and the empty-directory abort. The scripted I/O flow
is verified manually below.

### 3. Scaffold into an empty directory

```bash
mkdir /tmp/boot-test && cd /tmp/boot-test
nix develop --command pi        # or run belayd-agent-harness/bin/pi
> /bootstrap
```

Expect an `info` notification naming the project, the template file count, the
scripted commands, and the agent-owned remainder, followed by the
`belayd-bootstrap` handoff turn.

### 4. No leftover identifier tokens

```bash
cd /tmp/boot-test
grep -rn '__PROJECT_NAME__\|__PACKAGE_SCOPE__' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.direnv
cat packages/core/package.json      # "name": "@boot-test/core"
```

Expect **no** matches. The prose tokens `__PROJECT_DESCRIPTION__` (README.md)
and `__PROJECT_ONELINER__` (AGENTS.md) are expected to remain until the handoff
turn replaces them.

### 5. Flake locked and direnv allowed

```bash
test -f flake.lock && echo "flake.lock ok"
direnv status          # .envrc shows as allowed
```

`flake.lock` is created by `nix flake lock`; `direnv allow` records the
`.envrc` approval. Both are skipped on a resume when the artifact already
exists.

### 6. Dependencies installed

```bash
test -d node_modules && ls node_modules/.bin/lefthook
pnpm install --frozen-lockfile   # no-op re-run
```

### 7. Git hook installed

```bash
ls .git/hooks/pre-commit          # right after lefthook install
git config core.hooksPath
cat "$(git config core.hooksPath)/pre-commit"
```

`lefthook install` writes `.git/hooks/pre-commit`. `bd init` then runs **after**
lefthook and sets `core.hooksPath` to `.beads/hooks`, migrating the lefthook
hook and appending `bd hooks run <hook>` — so on a completed run the effective
`pre-commit` is the one under `core.hooksPath` and it chains lefthook first,
then beads. Both outcomes are correct for their point in the flow.

### 8. Turbo green in the generated repo

```bash
cd /tmp/boot-test
pnpm turbo run build typecheck lint test
```

All tasks for `@boot-test/core` must pass.

### 9. Beads wired to the shared Dolt server

```bash
cd /tmp/boot-test
bd ready
bd list
bd config get dolt.shared-server   # true
bd config get dolt.auto-start      # false
bd config get sync.remote          # not set
```

`bd ready` / `bd list` must answer from the new repo. Assert
`dolt.shared-server` is `true`, `dolt.auto-start` is `false`, and no
`sync.remote` is configured. If `bd` reports `database "…" not found on Dolt
server`, the shared Dolt server was not running when `bd init` ran (or `bd init`
did not use `--shared-server --external`); start the server and re-run
`/bootstrap` to resume.

### 10. No commit created by the command

The scripted steps stop before the project's initial commit.

```bash
cd /tmp/boot-test
git log --oneline --all
```

The only commit that may exist is bd's own
`bd init: initialize beads issue tracking`. The project's initial commit is
agent-owned and appears only after the handoff turn (step 11). No commit
containing the scaffold is created by `/bootstrap` itself.

### 11. Handoff turn

The `belayd-bootstrap` message triggers a turn. The agent must replace
`__PROJECT_DESCRIPTION__` / `__PROJECT_ONELINER__`, fill the AGENTS.md
Technology Stack table, Project Structure tree, and Documentation Map, confirm
`pnpm turbo run build typecheck lint test`, and create the initial commit.

```bash
cd /tmp/boot-test
grep -rn '__PROJECT' . --exclude-dir=node_modules --exclude-dir=.git   # nothing
git log --oneline                                                     # initial commit present
```

### 12. Resume path

Force a mid-flow failure, then re-run:

```bash
mkdir /tmp/boot-resume && cd /tmp/boot-resume
pi
> /bootstrap          # interrupt during `nix flake lock` (e.g. drop network, Ctrl-C)
> /bootstrap          # re-run in the same directory
```

Expect on failure an `error` notification naming the failing step followed by
the **exact remaining commands**, e.g.:

```
Finish the remaining steps manually from /tmp/boot-resume:
  git add -A
  nix flake lock
  direnv allow
  pnpm install
  ./node_modules/.bin/lefthook install
  bd init --shared-server --external --non-interactive --init-if-missing
  bd config set dolt.auto-start false
  bd prime
```

The scaffold stays in place. On re-run, the template files are copied again
(overwriting the previous attempt), `git add -A` always re-runs, and
`git init` / `nix flake lock` / `pnpm install` / `lefthook install` are skipped
or re-run based on their artifacts — the run must finish without a collision
error. A bd-injected `AGENTS.md` is preserved across the re-copy.

### What is scripted vs. agent-owned (recap)

Scripted: precondition checks, template copy, identifier substitution,
`git init` → `git add -A` → `nix flake lock` → `direnv allow` → `pnpm install`
→ `lefthook install` → `bd init`/`bd config`/`bd prime`, and the handoff
message.

Agent-owned: the prose placeholders (`__PROJECT_DESCRIPTION__`,
`__PROJECT_ONELINER__`), the AGENTS.md project sections, the package layout,
and the initial commit.

## How to Use

### What it does

`/bootstrap` writes the `templates/bootstrap/**` tree into the current
directory, substitutes the identifier tokens, runs the mechanical setup steps,
then hands the prose work to the agent in a triggered turn. There are no
arguments; the project name and npm scope come from the current directory's
basename.

```
/bootstrap
```

### Preconditions

- **Directory**: empty, holds only `.git`, or is a resumable `/bootstrap`
  scaffold. A resumable directory must show **at least two** scaffold-signature
  entries (`.config`, `turbo.json`, `pnpm-workspace.yaml`, `lefthook.yml`) and
  contain only entries from the template tree or the generated-artifact set.
  Anything else is refused so a real repo is never overwritten. (`flake.nix` and
  `.pi` are deliberately not signatures.)
- **Tools on PATH**: `nix`, `pnpm`, `git`, `bd`, `direnv`. Run `pi` from the
  harness devShell (`nix develop`) or use `bin/pi`, which provides them.
- **Template tree**: `templates/bootstrap/` must be resolvable relative to the
  extension module — true both for the dev checkout and the Nix store copy.

### Flow order

| # | Step | Notes |
|---|------|-------|
| 0 | Copy `templates/bootstrap/**` | overwrites existing template files (resume-safe) |
| 0b | Substitute `__PROJECT_NAME__`, `__PACKAGE_SCOPE__` | in template files only |
| 1 | `git init` | skipped when `.git` exists |
| 2 | `git add -A` | always runs; `nix flake lock` needs the files tracked |
| 3 | `nix flake lock` | skipped when `flake.lock` exists |
| 4 | `direnv allow` | |
| 5 | `pnpm install` | skipped when `node_modules` exists |
| 6 | `./node_modules/.bin/lefthook install` | skipped when `.git/hooks/pre-commit` exists |
| 7 | `bd init --shared-server --external --non-interactive --init-if-missing` | idempotent |
| 8 | `bd config set dolt.auto-start false` | verified with `bd config get` |
| 9 | `bd prime` | safe to re-run |
| 10 | Handoff turn | `belayd-bootstrap` message, `triggerTurn: true` |

The first failure aborts, shows the failing step plus the exact remaining
commands, and leaves the scaffold in place.

### Placeholder convention

| Token | Substituted by | Where |
|-------|----------------|-------|
| `__PROJECT_NAME__` | script (sanitized cwd basename) | `flake.nix`, `package.json`, `lefthook.yml`, `README.md`, … |
| `__PACKAGE_SCOPE__` | script (same value as the name) | `packages/core/package.json` |
| `__PROJECT_DESCRIPTION__` | agent, handoff turn | `README.md` |
| `__PROJECT_ONELINER__` | agent, handoff turn | `AGENTS.md` |

Only the identifier tokens are scripted: `pnpm install` runs in the same pass
and npm rejects an uppercase `@__PACKAGE_SCOPE__/core`. The prose tokens need
human judgement. AGENTS.md project sections (Technology Stack, Project
Structure, Documentation Map) are marked `TODO(agent)`; the `bd`-managed blocks
are injected by `bd init`.

### `--no-extensions` (`-ne`) caveat

`-ne` disables extension auto-discovery, including the project
`.pi/settings.json` `packages` array. The scaffold's
`.pi/settings.json` (`packages: ["../../belayd-agent-harness"]`) therefore only
matters for a **bare** `pi` run (no `-ne`) from the new repo, where it loads the
sibling harness checkout and provides `/belayd`, `/plan`, and the harness tools.
Under `-ne` it is ignored, but `/bootstrap` is still available because it is
baked into the devShell's `agent-harness.packages.<sys>.pi` and re-added
explicitly by `bin/pi`.

### Minimal example

```bash
# From the harness devShell (nix develop), in the harness checkout:
mkdir ~/git/my-new-project && cd ~/git/my-new-project
pi
> /bootstrap
# → info notification + agent turn completing the prose and initial commit
```

Full reference — what each template file contains, beads wiring rationale, the
resume classifier, and the template's drift from the reference repo — is above
in this document.
