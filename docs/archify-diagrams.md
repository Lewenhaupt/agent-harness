# Archify diagram generation (bd-85)

[archify](https://github.com/tt-a1i/archify) compiles a typed JSON IR into a
single self-contained interactive HTML diagram (architecture / workflow /
sequence / dataflow / lifecycle). bd-85 adds two things to the harness:

- a Nix package `archify` (upstream release zip v2.16.0), added to
  `devShellTools` so the binary is on `PATH` in `devShells.default` and in the
  `pi-web-runtime-env` used by every spawned agent session, and
- an **opt-in** pi tool `belayd_archify` that wraps `render` / `validate` /
  `deliver` and normalizes their receipts.

Generated diagrams are committed under `docs/diagrams/` (see
`docs/diagrams/README.md`). The tool is consult-callable and is **not** part of
any workflow phase: it is never required by a phase ordering, and the process
gate does not demand it. It is listed in `GATED_TOOLS` only so it stays callable
while a gate is active; it is deliberately **not** in `PLANNING_GATED_TOOLS`.

`visual-check` (needs Chrome via `$ARCHIFY_CHROME`) and `preview` (opens a
loopback HTTP server) are intentionally outside the tool surface.

## How to Verify

Steps 1–3 are runnable in the project devShell. On a host where the runtime env
is on `PATH`, the `direnv` form works; otherwise wrap commands with
`nix develop -c`.

1. **Static checks pass** (unit tests include `src/__tests__/archify.test.ts` and
   `src/__tests__/archify-run.test.ts`; mocked `node:child_process` covers
   ENOENT, timeout/kill, buffer overflow, non-zero exit, stderr-first fallbacks,
   structured failure receipts, and render path synthesis):

   ```bash
   pnpm typecheck && pnpm lint && pnpm test && pnpm build
   ```

   Expected: no type errors, Biome clean, all unit tests pass (1033 currently), `tsc`
   emits `dist/`.

2. **Integration tests run against the real binary.** The suite skips (with
   `Skipping integration test: archify not available`) when `archify` is not on
   `PATH`, so put the freshly built package first:

   ```bash
   PATH="$(nix build .#archify --print-out-paths)/bin:$PATH" pnpm test:integration
   ```

   Expected: `test/archify.integration.test.ts (4 tests)` passes alongside the
   other integration files. The four tests assert the normalized `9/9` check
   summary from `validate`, that `deliver` re-computes the artifact `sha256`
   (697021 bytes for the fixture) and matches `artifact.bytes`, that `render`
   prints a path and writes the file, and that a missing IR surfaces `ENOENT`
   (via `render`, which has no `--json`).

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

## How to Use

### As an agent (the `belayd_archify` pi tool)

The tool compiles one IR file into one HTML document. `input` is the JSON IR
path; `output` defaults to `<cwd>/docs/diagrams/<type>.html`.

| Param | Required | Values | Default | Notes |
| --- | --- | --- | --- | --- |
| `type` | yes | `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle` | — | Selects the IR schema/renderer (`diagram_type` must match). |
| `input` | yes | path | — | The typed JSON IR file. |
| `output` | no | path | `<cwd>/docs/diagrams/<type>.html` | **Ignored for `validate`** — only `render`/`deliver` write files. |
| `command` | no | `deliver`, `render`, `validate` | `deliver` | `deliver` = render + validate + write; `render` writes the HTML; `validate` only checks. |
| `quality` | no | `showcase`, `standard` | `showcase` | Composition profile. Commit-diagrams default to `showcase`. |
| `repoRoot` | no | path | — | `architecture` only; archify rejects it for other types with exit 2, and the tool rejects it early. |

Example calls:

```
belayd_archify type=architecture input=docs/diagrams/web-app.architecture.json
belayd_archify type=sequence input=docs/diagrams/login.sequence.json command=validate
belayd_archify type=dataflow input=/tmp/pipeline.dataflow.json output=/tmp/pipeline.html quality=standard
belayd_archify type=architecture input=docs/diagrams/web-app.architecture.json repoRoot=/home/me/project
```

Behavior worth knowing:

- `command=render` prints the output path and **no JSON** — upstream `render`
  has no `--json` flag. The wrapper synthesizes a minimal receipt from that path
  and confirms the file exists on disk before reporting success, so a banner or
  a stale path is never mistaken for a rendered artifact.
- `command=validate` ignores `output`; if you pass it the tool appends a note
  saying so.
- A validation failure still returns a structured receipt (`ok: false`); the
  tool exit code is 1 whenever `ok` is false.

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
```

`archify` is on `PATH` inside `nix develop` and inside spawned sessions
(provided by the `archify` derivation in `flake.nix`); `nix build .#archify`
gives you `./result/bin/archify` for one-off use. The wrapper sets
`ARCHIFY_UPDATE_CHECK_DISABLED=1` so the update checker's network GET never
runs, and the `belayd_archify` tool injects the same variable.

### Output location

Write diagrams to `docs/diagrams/<type>.html` (the tool's default). That
directory is committed on purpose so reviewers can open diagrams without
running the generator. Expect **large, mostly-generated HTML diffs**;
`belayd_commit`'s `git add -A` includes them, and the stale-file guard does not
hash-track files written by the external CLI — both expected.

## Related documentation

- `docs/diagrams/README.md` — the committed-diagrams directory and the IR schema summary.
- `AGENTS.md` § "Archify diagram generation (`archify`)" — Nix wiring and re-pinning the version/hash.
- AGENTS.md § "Technology Stack" — build/test commands.
