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

See the upstream `references/authoring-contract.md` (shipped inside the
archify package) for the full schema and authoring guidance.

## Generating diagrams

The harness exposes an opt-in pi tool, `belayd_archify`, which wraps the
archify CLI (`render` / `validate` / `deliver`). It requests `--json` for
`validate` and `deliver` (which emit a receipt) and parses the plain output
path that `render` prints, since upstream `render` has no `--json` flag:

```
belayd_archify type=architecture input=docs/diagrams/web-app.architecture.json
```

- `type` — one of the five diagram types above (required).
- `input` — path to the JSON IR (required).
- `output` — HTML output path; defaults to
  `<cwd>/docs/diagrams/<type>.html`. Ignored for `validate`.
- `command` — `deliver` (default), `render`, or `validate`.
- `quality` — `showcase` (default) or `standard`.
- `repoRoot` — repository root, `architecture` diagrams only.

The tool is consult-callable and not part of any workflow phase; it is listed
in `GATED_TOOLS` so it stays available while the process gate is active.

### Direct CLI use

```bash
nix build .#archify
./result/bin/archify doctor
./result/bin/archify render architecture in.architecture.json out.html --quality showcase
./result/bin/archify validate architecture in.architecture.json --json
```

`visual-check` (requires Chrome via `$ARCHIFY_CHROME`) and `preview` (opens a
loopback HTTP server) are intentionally outside the tool surface.
