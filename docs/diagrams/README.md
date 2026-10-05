# Diagrams

Committed [archify](https://github.com/tt-a1i/archify) diagrams live here.
Each file is a single self-contained interactive HTML document compiled from a
typed JSON IR; there are no external assets or network dependencies.

## Why this directory is committed

Generated HTML is part of the repository documentation, so reviewers can open
a diagram without running the generator. Expect large, mostly-generated HTML
diffs. The stale-file guard tracks pi's `edit`/`write` path only, so files
written here by the `archify` CLI are not hash-tracked — that is expected, not
a bug.

## The typed JSON IR

Archify consumes a JSON IR whose top-level `diagram_type` selects one of five
renderers. The IR is validated against a per-type schema before anything is
written, and the last-good artifact is only replaced after validation passes.

| `diagram_type` | Use for |
| --- | --- |
| `architecture` | Components, boundaries, and connections (supports `--repo-root`) |
| `workflow` | Lane-ordered process steps |
| `sequence` | Actor message ordering over time |
| `dataflow` | Data movement between stores and processors |
| `lifecycle` | State transitions over a lifecycle |

See `${ARCHIFY_HOME}/references/authoring-contract.md` for the full authoring
contract and `${ARCHIFY_HOME}/schemas/` for the per-type schemas
(`architecture.schema.json`, `workflow.schema.json`, `sequence.schema.json`,
`dataflow.schema.json`, `lifecycle.schema.json`, and the shared
`common.schema.json`). The harness agent skill at
`.agents/skills/archify/SKILL.md` routes to them; it tells the agent to read
`${ARCHIFY_HOME}/SKILL.md` and follow it. `${ARCHIFY_HOME}` is exported by the
archify wrapper, the devShell shellHook, and the pi-web runtime env.

## Generating diagrams

The harness exposes an opt-in pi tool, `belayd_archify`, which wraps the
archify CLI (`render` / `validate` / `deliver`) and adds four read-only
guidance commands. It requests `--json` for `validate` and `deliver` (which
emit a receipt) and parses the plain output path that `render` prints, since
upstream `render` has no `--json` flag:

```
belayd_archify type=architecture input=docs/diagrams/web-app.architecture.json
```

- `type` — one of the five diagram types above (required for
  render/validate/deliver/inspect; `inspect` accepts `architecture` only).
- `input` — path to the JSON IR (required for render/validate/deliver/inspect;
  for `command=check`, the delivered HTML path).
- `output` — HTML output path; defaults to
  `<cwd>/docs/diagrams/<type>.html`. Ignored for `validate`.
- `command` — `deliver` (default), `render`, `validate`, `guide`, `examples`,
  `inspect`, or `check`.
- `quality` — `showcase` (default) or `standard`.
- `repoRoot` — repository root, `architecture` diagrams only.
- `scenario` — optional plain-language prompt for `command=guide` (must not
  start with `--`).

Read-only guidance commands:

- `command=guide` (optional `scenario=`) — returns the recipe list
  (`"mode": "list"`, 11 recipes), or a type recommendation
  (`"mode": "recommendation"`, with `confidence` and `recommendation.type`)
  when a `scenario` is given. Params irrelevant to the command are reported in
  a `note:` line rather than silently dropped.
- `command=examples` — lists the packaged example IRs under
  `$ARCHIFY_HOME/examples/` (read directly, never rendered; 14 `*.json` files
  in the pinned release).
- `command=inspect type=architecture input=<ir.json>` — dumps the compiled
  layout (architecture only).
- `command=check input=<delivered.html>` — re-validates a delivered artifact
  (9 checks for a showcase architecture diagram); it takes the HTML, not the
  IR.

Example guidance calls:

```
belayd_archify command=guide
belayd_archify command=guide scenario="API request retries"
belayd_archify command=examples
belayd_archify command=inspect type=architecture input=test/fixtures/archify/minimal.architecture.json
belayd_archify command=check input=docs/diagrams/architecture.html
```

The tool is consult-callable and not part of any workflow phase; it is listed
in `GATED_TOOLS` so it stays available while the process gate is active.

## Verifying `${ARCHIFY_HOME}` and the router skill

Inside a devShell the shellHook already exports the pinned path:

```bash
nix develop -c bash -c 'echo "$ARCHIFY_HOME"'
# …-archify-2.16.0/libexec/archify
ls "$ARCHIFY_HOME/SKILL.md" "$ARCHIFY_HOME/examples" \
   "$ARCHIFY_HOME/schemas" "$ARCHIFY_HOME/references"
```

Expected: the store path ends in `-archify-2.16.0/libexec/archify`, and all
four asset paths resolve (including
`$ARCHIFY_HOME/examples/web-app.architecture.json` and
`$ARCHIFY_HOME/references/authoring-contract.md`). Outside a devShell the built
wrapper is self-describing:

```bash
nix build .#archify
grep 'export ARCHIFY_HOME' result/bin/archify
# export ARCHIFY_HOME="/nix/store/…-archify-2.16.0/libexec/archify"
```

The router skill is installed by the `belayd-skills` package, which copies
`.agents/skills/` into its output:

```bash
ls "$(nix build .#belayd-skills --print-out-paths)"
# archify  backlog  beads
```

Flakes only see git-tracked files, so the normal build omits `archify/` while
`.agents/skills/archify/SKILL.md` is untracked. Use the path flake to check the
working tree before committing:
`nix build --print-out-paths 'path:.#belayd-skills'`. The regression guard
`src/__tests__/archify-assets.test.ts` pins the skill frontmatter and the
`ARCHIFY_HOME` exports in the wrapper, devShell, and pi-web module.

### Direct CLI use

```bash
nix build .#archify
./result/bin/archify doctor
./result/bin/archify render architecture in.architecture.json out.html --quality showcase
./result/bin/archify validate architecture in.architecture.json --json
./result/bin/archify guide --json
./result/bin/archify inspect architecture in.architecture.json
./result/bin/archify check out.html
```

`visual-check` (requires Chrome via `$ARCHIFY_CHROME`) and `preview` (opens a
loopback HTTP server) are intentionally outside the tool surface. Authoring
guidance is reachable through `.agents/skills/archify/SKILL.md` (which points at
`$ARCHIFY_HOME/SKILL.md`) or `belayd_archify command=guide`.
