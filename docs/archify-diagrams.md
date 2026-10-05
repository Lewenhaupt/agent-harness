# Archify diagram generation (bd-85, guidance in bd-87)

[archify](https://github.com/tt-a1i/archify) compiles a typed JSON IR into a
single self-contained interactive HTML diagram (architecture / workflow /
sequence / dataflow / lifecycle). bd-85 adds two things to the harness:

- a Nix package `archify` (upstream release zip v2.16.0), added to
  `devShellTools` so the binary is on `PATH` in `devShells.default` and in the
  `pi-web-runtime-env` used by every spawned agent session, and
- an **opt-in** pi tool `belayd_archify` that wraps `render` / `validate` /
  `deliver` and normalizes their receipts.

bd-87 makes the upstream agent material discoverable:

- The archify wrapper, the devShell `shellHook`, and the pi-web runtime systemd
  environment each export `ARCHIFY_HOME="$out/libexec/archify"` for the pinned
  package. The upstream agent skill (`$ARCHIFY_HOME/SKILL.md`) plus
  `$ARCHIFY_HOME/schemas/`, `$ARCHIFY_HOME/examples/`, and
  `$ARCHIFY_HOME/references/` are readable at that stable path, so nothing has
  to guess the store hash — a spawned agent session inherits the value from its
  environment.
- A thin router skill at `.agents/skills/archify/SKILL.md` (delivered by the
  `belayd-skills` Nix package) tells the agent to read `$ARCHIFY_HOME/SKILL.md`
  and follow it, then routes to the schema / example / reference directories.
- `belayd_archify` gains read-only guidance subcommands: `guide` (optional
  `scenario`), `examples`, `inspect` (architecture only), and `check`.
  `visual-check` and `preview` remain excluded.

Generated diagrams are committed under `docs/diagrams/` (see
`docs/diagrams/README.md`). The tool is consult-callable and is **not** part of
any workflow phase: it is never required by a phase ordering, and the process
gate does not demand it. It is listed in `GATED_TOOLS` only so it stays callable
while a gate is active; it is deliberately **not** in `PLANNING_GATED_TOOLS`.

`visual-check` (needs Chrome via `$ARCHIFY_CHROME`) and `preview` (opens a
loopback HTTP server) are intentionally outside the tool surface.

## How to Verify

Steps 1–4 are runnable in the project devShell. On a host where the runtime env
is on `PATH`, the `direnv` form works; otherwise wrap commands with
`nix develop -c`.

1. **Static checks pass** (unit tests include `src/__tests__/archify.test.ts`,
   `src/__tests__/archify-run.test.ts`, `src/__tests__/extension-archify-tool.test.ts`,
   and `src/__tests__/archify-assets.test.ts`; mocked `node:child_process` covers
   ENOENT, timeout/kill, buffer overflow, non-zero exit, stderr-first fallbacks,
   structured failure receipts, render path synthesis, and per-command param
   validation):

   ```bash
   pnpm typecheck && pnpm lint && pnpm test && pnpm build
   ```

   Expected: no type errors, Biome clean (`Checked 101 files`), all **1102 unit
   tests in 51 files** pass, and `tsc` emits `dist/`.

2. **Integration tests run against the real binary.** The suite skips (with
   `Skipping integration test: archify not available`) when `archify` is not on
   `PATH`, so put the freshly built package first:

   ```bash
   PATH="$(nix build .#archify --print-out-paths)/bin:$PATH" pnpm test:integration
   ```

   Expected: `Test Files 4 passed (4)`, `Tests 50 passed (50)`, of which
   `test/archify.integration.test.ts` contributes **8 tests**: the four bd-85
   render paths (normalized `9/9` check summary from `validate`, `deliver`
   re-computing the artifact `sha256` and matching `artifact.bytes`, `render`
   printing a path and writing the file, and a missing IR surfacing `ENOENT` via
   `render`) plus the four bd-87 guidance paths (`guide --json` returning an
   `ok` receipt with a `mode`, `inspect architecture` returning
   `diagram_type: "architecture"` and a `layout`, `check` re-validating a
   delivered artifact, and packaged example IRs listing from a resolved
   `$ARCHIFY_HOME`).

3. **The standalone CLI works.**

   ```bash
   nix build .#archify
   ./result/bin/archify doctor
   ```

   Expected: exit 0, a `[ok]` line per runtime component, ending with:

   ```
   Archify is ready.
   ```

4. **Manual end-to-end render.** Render the committed fixture into the committed
   output directory and open it:

   ```bash
   ./result/bin/archify deliver architecture \
     test/fixtures/archify/minimal.architecture.json \
     docs/diagrams/architecture.html \
     --quality showcase --json
   xdg-open docs/diagrams/architecture.html
   ```

   Expected: exit 0 and a receipt with
   `"ok": true`, `"specification": { "sha256": "a896dc...", "bytes": 450 }`,
   `"artifact": { "sha256": "4358...", "bytes": 697021 }` (the artifact hash
   changes if the input changes), and
   `"validation": { "checksPassed": 9, "checkCount": 9, "compositionProfile":
   "showcase", "compositionStatus": "pass", "errors": 0, "warnings": 0 }`.
   The HTML file opens as an interactive diagram with no network requests.

   The same call through the pi tool reports the formatted summary instead of
   raw JSON:

   ```
   archify deliver architecture: ok
   artifact: /abs/path/docs/diagrams/architecture.html
     sha256: 4358... (697021 bytes)
   validation: 9/9 checks passed, showcase, pass
   ```

5. **Guidance assets are on a stable `${ARCHIFY_HOME}`.** Inside a devShell the
   variable is already exported (the flake's `shellHook`):

   ```bash
   nix develop -c bash -c 'echo "$ARCHIFY_HOME"'
   ```

   Expected: a store path ending in `-archify-2.16.0/libexec/archify`. Then,
   inside that devShell (or after exporting the value as shown below), confirm
   the four asset groups exist next to the binary:

   ```bash
   ls "$ARCHIFY_HOME/SKILL.md" \
      "$ARCHIFY_HOME/schemas/architecture.schema.json" \
      "$ARCHIFY_HOME/examples/web-app.architecture.json" \
      "$ARCHIFY_HOME/references/authoring-contract.md"
   ```

   Expected: all four paths resolve (no `No such file or directory`). Outside a
   devShell, the built wrapper is self-describing — it exports the same value:

   ```bash
   nix build .#archify
   grep 'export ARCHIFY_HOME' result/bin/archify
   ARCHIFY_HOME="$(nix build .#archify --print-out-paths)/libexec/archify"
   ls "$ARCHIFY_HOME"/examples/*.json | wc -l
   ```

   Expected: `grep` prints
   `export ARCHIFY_HOME="/nix/store/…-archify-2.16.0/libexec/archify"` (`$out`
   already expanded to the concrete store path), and the count is **14**
   packaged example IRs. `nix develop -c bash -c 'echo "$ARCHIFY_HOME"'` and the
   pi-web runtime env resolve to the same path.

6. **The router skill is shipped.** `nix build .#belayd-skills` copies
   `.agents/skills/` verbatim, so the built package must contain
   `archify/ backlog/ beads/`:

   ```bash
   nix build .#belayd-skills --print-out-paths
   S="$(nix build .#belayd-skills --print-out-paths)"
   ls "$S"
   head -3 "$S/archify/SKILL.md"
   ```

   Expected: `ls` shows `archify`, `backlog`, `beads`; the first three lines of
   the skill are the frontmatter (`---`, `name: archify`, `description: …`).

   Caveat: Nix flakes only see *git-tracked* files. On a fresh worktree where
   `.agents/skills/archify/SKILL.md` is still untracked, the normal
   `.#belayd-skills` build warns `Git tree … is dirty` and omits `archify/`. To
   check the working tree before committing, build through the path flake, which
   copies the whole directory:

   ```bash
   ls "$(nix build --print-out-paths 'path:.#belayd-skills')"
   ```

   Expected: `archify backlog beads`.

7. **Guidance commands behave.** The raw CLI is the fastest check (use the
   binary from step 3):

   ```bash
   ./result/bin/archify guide --json | jq -r .mode
   ./result/bin/archify guide "API request retries" --json | jq -r '.mode, .recommendation.type'
   ./result/bin/archify inspect architecture \
     test/fixtures/archify/minimal.architecture.json | jq -r '.ok, .diagram_type'
   ./result/bin/archify deliver architecture \
     test/fixtures/archify/minimal.architecture.json /tmp/architecture.html \
     --quality showcase --json >/dev/null
   ./result/bin/archify check /tmp/architecture.html | jq -r '.ok, (.checks | length)'
   ```

   Expected, in order: `list`; then `recommendation` and `sequence`; then `true`
   and `architecture`; then (no output from `deliver`); then `true` and `9`.
   `guide` without a scenario returns the recipe list (11 recipes), with a
   scenario it returns a recommendation with `confidence` and `recommendation`.

   Through the pi tool (an agent session), the same behavior with harness-shaped
   responses and an ignored-param note:

   ```
   belayd_archify command=guide
   belayd_archify command=guide scenario="API request retries"
   belayd_archify command=examples
   belayd_archify command=guide quality=showcase
   belayd_archify command=inspect type=architecture input=test/fixtures/archify/minimal.architecture.json
   belayd_archify command=check input=/tmp/architecture.html
   ```

   Expected: `guide` prints the recipe-list JSON; with `scenario` it prints a
   `"mode": "recommendation"` receipt; `examples` prints `archify examples (14):`
   followed by one `$ARCHIFY_HOME/examples/*.json` path per line; the
   `quality=showcase` call still answers and appends
   `note: quality ignored for command=guide.`; `inspect` and `check` print
   raw JSON and exit 0 (exit 1 on failure). `command=check` needs an
   already-delivered HTML — render one first, as above.

   Regression guards: `src/__tests__/archify-assets.test.ts` asserts the skill
   exists, has `name: archify` frontmatter, references the `$ARCHIFY_HOME`
   skill/schemas/examples/references paths, does not vendor the upstream
   SKILL.md, and that `flake.nix` exports `ARCHIFY_HOME` from the wrapper, the
   devShell shellHook, and the pi-web module;
   `src/__tests__/extension-archify-tool.test.ts` covers command routing, the
   ignored-param notes, and that `belayd_archify` stays callable under the
   process gate without joining the planning-mode tool set.

## How to Use

### As an agent (the `belayd_archify` pi tool)

The tool compiles one IR file into one HTML document. `input` is the JSON IR
path; `output` defaults to `<cwd>/docs/diagrams/<type>.html`.

| Param | Required | Values | Default | Notes |
| --- | --- | --- | --- | --- |
| `type` | render/inspect | `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle` | — | Selects the IR schema/renderer (`diagram_type` must match). `inspect` requires `architecture`. |
| `input` | render/inspect/check | path | — | The typed JSON IR file (for `check`, the delivered HTML). |
| `output` | no | path | `<cwd>/docs/diagrams/<type>.html` | **Ignored for `validate`** — only `render`/`deliver` write files. |
| `command` | no | `deliver`, `render`, `validate`, `guide`, `examples`, `inspect`, `check` | `deliver` | `deliver` = render + validate + write; `render` writes the HTML; `validate` only checks; the rest are read-only guidance. |
| `quality` | no | `showcase`, `standard` | `showcase` | Composition profile. Commit-diagrams default to `showcase`. |
| `repoRoot` | no | path | — | `architecture` only; archify rejects it for other types with exit 2, and the tool rejects it early. |
| `scenario` | no | text | — | Plain-language prompt for `command=guide`. Must not start with `--`. |

Example calls:

```
belayd_archify command=guide
belayd_archify command=guide scenario="request lifecycle for a login flow"
belayd_archify command=examples
belayd_archify command=inspect type=architecture input=test/fixtures/archify/minimal.architecture.json
belayd_archify command=check input=docs/diagrams/architecture.html
belayd_archify type=architecture input=docs/diagrams/web-app.architecture.json
belayd_archify type=sequence input=docs/diagrams/login.sequence.json command=validate
belayd_archify type=dataflow input=/tmp/pipeline.dataflow.json output=/tmp/pipeline.html quality=standard
belayd_archify type=architecture input=docs/diagrams/web-app.architecture.json repoRoot=/home/me/project
```

Behavior worth knowing:

- `command=guide` calls `archify guide [scenario] --json`. With no `scenario` it
  returns the recipe **list** (`"mode": "list"`); with a `scenario` it returns a
  **recommendation** (`"mode": "recommendation"`, with `confidence`,
  `matchedSignals`, and `recommendation.type`). A `scenario` that starts with
  `--` is rejected before any process runs (upstream would parse it as a flag).
- `command=inspect type=architecture input=<ir.json>` dumps the compiled layout
  (`"layout"`); it is architecture-only and other types are rejected with
  `inspect only supports the architecture type`.
- `command=check input=<delivered.html>` re-validates an already-delivered
  artifact (9 checks for a showcase architecture diagram). It takes the HTML,
  not the IR. `command=inspect` and `command=check` return raw JSON text on
  success and the first informative stdout/stderr line on failure.
- Params irrelevant to a guidance command are reported in a `note:` line, e.g.
  `note: quality, repoRoot ignored for command=guide.` — in the canonical order
  `type, input, output, quality, repoRoot, scenario`, with the params the
  command does use omitted — so a mismatched param is never silently dropped.
- `command=examples` lists the packaged `$ARCHIFY_HOME/examples/*.json` files
  directly rather than shelling out to `archify examples`, which would try to
  render HTML into the read-only Nix store. `$ARCHIFY_HOME` must be set
  (wrapper / devShell / pi-web runtime env); the tool reports a clear error when
  it is missing.
- `command=render` prints the output path and **no JSON** — upstream `render`
  has no `--json` flag. The wrapper synthesizes a minimal receipt from that path
  and confirms the file exists on disk before reporting success, so a banner or
  a stale path is never mistaken for a rendered artifact.
- `command=validate` ignores `output`; if you pass it the tool appends a note
  saying so.
- A validation failure still returns a structured receipt (`ok: false`); the
  tool exit code is 1 whenever the operation fails. Render/validate/deliver
  behavior is unchanged from bd-85.
- Authoring guidance: read `.agents/skills/archify/SKILL.md`, which routes to
  `$ARCHIFY_HOME/SKILL.md`, `$ARCHIFY_HOME/schemas/`,
  `$ARCHIFY_HOME/examples/`, and `$ARCHIFY_HOME/references/`.

### As a human (the raw CLI)

```bash
nix build .#archify
./result/bin/archify doctor

# render then validate then write (the tool's default command):
./result/bin/archify deliver architecture in.architecture.json out.html --quality showcase --json

# write only; prints the output path, no JSON:
./result/bin/archify render workflow in.workflow.json out.html --quality showcase

# validate only (no output positional):
./result/bin/archify validate sequence in.sequence.json --json

# read-only guidance (what belayd_archify command=guide/examples/inspect/check wrap):
./result/bin/archify guide --json
./result/bin/archify guide "API request retries" --json
./result/bin/archify inspect architecture in.architecture.json
./result/bin/archify check out.html
```

`archify` is on `PATH` inside `nix develop` and inside spawned sessions
(provided by the `archify` derivation in `flake.nix`); `nix build .#archify`
gives you `./result/bin/archify` for one-off use. The wrapper sets
`ARCHIFY_UPDATE_CHECK_DISABLED=1` so the update checker's network GET never
runs, and the `belayd_archify` tool injects the same variable. It also exports
`ARCHIFY_HOME` (same value the devShell shellHook and the pi-web runtime env
export), so `$ARCHIFY_HOME/SKILL.md`, `$ARCHIFY_HOME/schemas/`,
`$ARCHIFY_HOME/examples/`, and `$ARCHIFY_HOME/references/` are always reachable
next to the binary — the store hash never has to be hard-coded. Note that
`archify examples` is not used by the harness tool: it renders HTML into the
read-only Nix store, so the tool lists `$ARCHIFY_HOME/examples/*.json` itself.

### Output location

Write diagrams to `docs/diagrams/<type>.html` (the tool's default). That
directory is committed on purpose so reviewers can open diagrams without
running the generator. Expect **large, mostly-generated HTML diffs**;
`belayd_commit`'s `git add -A` includes them, and the stale-file guard does not
hash-track files written by the external CLI — both expected.

## Related documentation

- `docs/diagrams/README.md` — the committed-diagrams directory and the IR schema summary.
- `.agents/skills/archify/SKILL.md` — the thin router skill; read `$ARCHIFY_HOME/SKILL.md` for the upstream authoring contract.
- `AGENTS.md` § "Archify diagram generation (`archify`)" — Nix wiring, `$ARCHIFY_HOME`, and re-pinning the version/hash.
- AGENTS.md § "Technology Stack" — build/test commands.
