---
name: archify
description: Use when authoring, generating, or validating a standalone interactive HTML diagram — architecture, workflow, sequence, dataflow, or lifecycle/state — or when routing a diagram request (system architecture, infrastructure, process, API call sequence, request lifecycle, data pipeline, state machine, Mermaid conversion) to the right archify type. Also use when inspecting a delivered archify artifact or re-checking a diagram before commit.
---

# Archify

[archify](https://github.com/tt-a1i/archify) compiles a small typed JSON IR into
one self-contained interactive HTML document. This skill is a thin router to the
pinned upstream material — it does not reproduce the authoring contract itself.

## Authoritative source

Read `${ARCHIFY_HOME}/SKILL.md` and follow it. That file is the upstream agent
skill shipped with the pinned package: fast authoring path, the do-not-read
renderer-internals rule, update-check etiquette, and the delivery contract. Do
not copy it here; read it in place so it always matches the installed version.

Then read only what you need:

- Per-type schema plus the shared one: `${ARCHIFY_HOME}/schemas/` (for example
  `architecture.schema.json` and `common.schema.json`).
- One matching IR example for field shape (not facts):
  `${ARCHIFY_HOME}/examples/` — or run `belayd_archify command=examples` to list
  the packaged `*.json` files.
- Deeper contracts: `${ARCHIFY_HOME}/references/` (`authoring-contract.md`,
  `delivery-contract.md`, `brand-marks.md`, `viewer-runtime.md`).

`${ARCHIFY_HOME}` is exported by the `archify` wrapper and by the devShell /
pi-web runtime env, and `archify` is on `PATH` in spawned sessions. If
`${ARCHIFY_HOME}` is empty, you are outside a harness shell — run the command
inside `nix develop`.

## Routing a request

| Command | Use it for |
| --- | --- |
| `belayd_archify command=guide scenario="..."` | Get a type recommendation and authoring route for a plain-language request. |
| `belayd_archify command=examples` | List the packaged example IRs. |
| `belayd_archify type=<type> input=<ir.json>` | Render + validate + write (the default `deliver` path). |
| `belayd_archify type=<type> input=<ir.json> command=validate` | Validate only; no file written. |
| `belayd_archify type=<type> input=<ir.json> command=render` | Write HTML only. |
| `belayd_archify command=inspect type=architecture input=<ir.json>` | Dump the compiled layout for an architecture IR (architecture only). |
| `belayd_archify command=check input=<delivered.html>` | Re-validate a delivered artifact. |

Write the candidate IR first, then validate after **every** edit. A showcase
pass must report all **9/9** artifact checks with zero composition errors and
zero warnings; a 4-check receipt is basic validation and is not showcase
acceptance. Commit diagrams under `docs/diagrams/` (see
`docs/diagrams/README.md`).

`visual-check` (needs Chrome via `$ARCHIFY_CHROME`) and `preview` (opens a
loopback HTTP server) are intentionally **not** exposed by the harness tool.
