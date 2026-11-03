# unslop UI-design skill — operator guide (bd-253)

`unslop` is Damir Sokolovsky's ([@heydamir](https://x.com/heydamir),
<https://heydamir.design/unslop>) UI-design skill, licensed **CC BY 4.0**. It
audits the tells of vibecoded UI — purple gradients, glows, gradient text, emoji
labels, `New ✨` badges, glossy blobs, uppercase tracked labels, pulsing elements,
uneven spacing — derives a direction from the product, then fixes the screen in
nine ordered passes: spacing, color, icons, copy, type, layout, details, visuals,
motion.

bd-253 makes it callable in this harness in three pieces: a pinned Nix package
`unslop`, a thin router skill at `.agents/skills/unslop/SKILL.md` that reads
`$UNSLOP_HOME/SKILL.md` in place, and the `belayd_unslop` tool backed by the
`belayd-unslop` agent. It adds **no workflow phase**.

This page is the operator walkthrough. The design and packaging rationale live in
[`docs/unslop-skill.md`](unslop-skill.md) — read that for the pin layout, the
`NODE_PATH` wrappers, the three `UNSLOP_HOME` sites and the risk list. The
routing surface is `.agents/skills/unslop/SKILL.md`.

The credit is load-bearing: upstream requires it in every copy or adaptation,
including a rendered story video. It appears in the router's frontmatter
(`license: CC-BY-4.0`), in the router body, and in `docs/unslop-skill.md`.

## How to Verify

Run these from the repository root, in a devShell (`nix develop`). The outputs
shown were produced in this worktree on 2026-11-03.

### 1. `$UNSLOP_HOME` is exported and the wrappers are on `PATH`

```bash
echo "$UNSLOP_HOME"
command -v unslop-snapshot unslop-story
ffmpeg -version | head -1
```

Expected: a store path ending in `-unslop-a6f121e/libexec/unslop`, both wrappers
under the same store path's `bin/`, and an ffmpeg banner. Actual:

```text
/nix/store/757pmwfsgq6zzi8pr1jd3yf0hmk10k5s-unslop-a6f121e/libexec/unslop
/nix/store/757pmwfsgq6zzi8pr1jd3yf0hmk10k5s-unslop-a6f121e/bin/unslop-snapshot
/nix/store/757pmwfsgq6zzi8pr1jd3yf0hmk10k5s-unslop-a6f121e/bin/unslop-story
ffmpeg version 8.1.2 ...
```

Outside a devShell (empty variable), the pinned value is still resolvable through
the devShell's `shellHook`:

```bash
nix develop -c bash -c 'echo "$UNSLOP_HOME"; command -v unslop-snapshot'
```

Expected: the same two store paths. (`nix develop` may print `warning: Git tree
… is dirty` on an uncommitted worktree; that is not a failure.)

### 2. The wrappers render, and print usage instead of a Playwright error

A render needs network access for a remote URL:

```bash
unslop-snapshot https://example.com /tmp/u.html
ls -l /tmp/u.html /tmp/u.live.png
```

Expected: `saved /tmp/u.html` on stdout, then both files exist; the PNG is the
screenshot `describe_image` reads. Actual: 2.3 KB HTML, 78 KB PNG.

Offline variant, using the pinned practice screen (no network, no credentials):

```bash
unslop-snapshot "file://$UNSLOP_HOME/examples/dashboard.html" /tmp/dash.html
ls -l /tmp/dash.html /tmp/dash.live.png
```

Expected: `saved /tmp/dash.html` and a much larger pair (1.5 MB HTML, 465 KB PNG).

No arguments must print the upstream usage rather than fail on Playwright — both
exit **1** on that path, which is upstream's behaviour, not a broken wrapper:

```bash
unslop-snapshot; echo "exit=$?"
unslop-story; echo "exit=$?"
```

Expected:

```text
usage: node snapshot.mjs <url of the screen> <out.html> [pass label] [--dark | --light] [--width=1440] [--height=810]
exit=1
usage: node story.mjs <story.html> <out.mp4> [--wide], or node story.mjs <story.html> --play to watch it live in a browser window
exit=1
```

A Playwright resolution failure instead prints `Playwright is not installed …` —
fix the derivation, do not add `agent_browser` to the agent allowlist.

### 3. The pin carries the skill material

```bash
nix build .#unslop --print-out-paths
ls "$UNSLOP_HOME"
ls "$UNSLOP_HOME/references"
```

Expected: `/nix/store/…-unslop-a6f121e`; then `agents examples references scripts
SKILL.md`; then `effects.md refs refs.md signs.md tokens.md visuals.md`.

### 4. The router is shipped by `belayd-skills`

Flakes see only git-tracked files, so while the router is untracked the normal
`.#belayd-skills` build omits `unslop/`; use the path flake:

```bash
S="$(nix build --print-out-paths 'path:.#belayd-skills')"
ls "$S"
head -3 "$S/unslop/SKILL.md"
```

Expected: `archify backlog beads fleet-supervision unslop`, and the first three
lines are `---`, `name: unslop`, `description: Turns vibecoded, AI-looking UI …`.
The package output *is* the `~/.agents/skills` tree the NixOS module links.

### 5. The skill is advertised

Deterministic part:

```bash
ls .agents/skills/unslop/SKILL.md
grep -A3 '"skills"' package.json
```

Expected: the file exists, and `package.json` declares `"skills": ["./.agents/skills"]`,
which pi discovers from the worktree cwd *and* every spawned agent inherits.

Session part: start `./bin/pi` in the worktree and type `/skill:`. The menu must
offer `skill:unslop` (`enableSkillCommands` defaults to `true`), and the system
prompt advertises the skill as name + description + path. A sub-agent has nobody
to type the command, so the router must stay model-invocable — the guard test
asserts the frontmatter has no `disable-model-invocation`.

If `~/.agents/skills/unslop` does not exist yet, the global copy has not been
linked: rebuild the NixOS/home-manager config that consumes `belayd-skills`. A
worktree session does not need it (project discovery covers `.agents/skills/`).

### 6. `belayd_unslop` is declared and audited

In a session call `belayd_doctor`. Expected, in an interactive (ungated) session:
the allowlist audit ends with

```text
- ✅ every agent allowlist resolves to a declared or external tool
```

and no line reads `belayd-implementer: missing belayd_unslop` — the implementer's
allowlist names the tool, so a missing registration surfaces as exactly that.
Under an active workflow gate the doctor instead prints the
`this session declares N/M harness tools` warning and skips the per-agent rows;
in that case check the tool directly from the orchestrator (step 8).

The same facts as a machine check, without a model call:

```bash
grep -n '"belayd_unslop"' src/tool-audit.ts src/role-tools.ts
pnpm exec vitest run src/__tests__/tool-contract.test.ts
```

Expected: two matches (`HARNESS_TOOL_NAMES`, `CONSULT_TOOLS`) and a passing
contract test. `tool-contract.test.ts` fails when an agent may call a `belayd_*`
tool that no workflow gate leaves active — that guard is why `belayd_unslop` is
in `CONSULT_TOOLS`: `pi.setActiveTools(workflowGateToolSet(...))` would otherwise
refuse it for the whole gated session.

### 7. Regression guards

```bash
pnpm exec vitest run src/__tests__/unslop-assets.test.ts \
  src/__tests__/extension-unslop-tool.test.ts \
  src/__tests__/tool-contract.test.ts
```

Expected: `Test Files 3 passed (3)`, `Tests 30 passed (30)`. The asset guard pins
the rev, the derivation layout, the wrappers, all three `UNSLOP_HOME` sites,
`pkgs.ffmpeg` + `unslop` as real `devShellTools` entries, the router's promises and
the CC BY 4.0 credit. The tool guard pins the spawn args, the exit codes and the
no-output fallback. Full suite: `pnpm test` → 4698 tests in 171 files.

### 8. Two-pass smoke on a scratch screen

```text
belayd_unslop task="Pass 1 only: audit file://$UNSLOP_HOME/examples/dashboard.html"
```

Expected: a block ending in `## Audit` (one line per sign, with where it lives),
`## Direction` (Product, Character, World, Moments, Signature — one line each) and
`## Screenshot` (absolute PNG path the child described). Pass 1 must not have
edited the screen. Reply with the confirmed or edited direction:

```text
belayd_unslop task="Pass 2: apply this direction to the dashboard — Product: … Character: … World: … Moments: … Signature: …"
```

Expected: the nine passes applied in order, a re-render, a comparison against the
audit list, and a few lines per pass. If the child returns `The unslop agent
produced no output.` the spawn worked but the child said nothing; if it returns
`unslop agent could not run: …` (exit 1) the spawn failed and no audit was made.

### 9. Re-pinning upstream

Procedure and layout checklist: [`docs/unslop-skill.md`](unslop-skill.md#re-pinning-upstream).
The short form, in `flake.nix`'s `unslop` derivation:

1. set `rev` to the new commit;
2. set `hash = pkgs.lib.fakeHash;`, run `nix build .#unslop --print-out-paths`,
   and paste the reported `got:` hash into `hash`;
3. confirm the new rev still has `skills/unslop/{SKILL.md,references,scripts}` and
   `examples/` — if not, update the `installPhase` and the router together;
4. copy a changed upstream `description:` verbatim into the router frontmatter;
5. `pnpm exec vitest run src/__tests__/unslop-assets.test.ts`, then rebuild
   `.#unslop` and `'path:.#belayd-skills'`.

## How to Use

### When to reach for it

Use the `unslop` skill when a screen looks AI-generated and the user wants it to
stop: a hero with a purple-to-blue gradient, glows or gradient text, emoji
section labels, `New ✨`-style badges, glossy blobs, uppercase tracked labels,
pulsing status dots used as decoration, or a dashboard where every gap is the
same 16 px. The skill description carries exactly those triggers, so a model can
select it; force it with `/skill:unslop <what to fix>` when it does not.

Do not use it to invent a product, to change what the product is, or to make a
good screen "different". Upstream's light-slop branch polishes only what the audit
found, and the no-slop branch says so and stops.

### The two passes, from your side

A spawned child has no `ask_user`, so the direction confirmation happens in
*your* turn, not the child's:

| Pass | What the child does | What you do |
|---|---|---|
| 1 — audit | finds the files that render the screen, renders it with `unslop-snapshot`, reads the PNG with `describe_image`, audits against `$UNSLOP_HOME/references/signs.md`, writes the five direction lines (Product, Character, World, Moments, Signature), **edits nothing**, returns `## Audit`, `## Direction`, `## Screenshot` | read the audit, then confirm the direction or edit it. Editing the direction here is the whole point: it is what pass 2 applies verbatim |
| 2 — apply | runs the nine passes in order against the confirmed direction, re-renders, compares with its audit list, reports a few lines per pass plus any image prompt | check the report against the audit list; the screen's files are now changed |

The tool cannot tell which pass you are in — that lives in the `task` steer you
write.

### Calling it from the orchestrator

`belayd_unslop` takes one parameter, `task`: the screen (a file path or a URL)
plus any steer. The working directory is the session's, so relative paths resolve
in the worktree.

```text
belayd_unslop task="Pass 1: audit the signup screen at src/app/(auth)/signup/page.tsx — light theme, Tailwind"
belayd_unslop task="Pass 2: apply the confirmed direction to src/app/(auth)/signup/page.tsx — Product: job alerts for nurses. Character: calm, exact, a little warm. World: hospital night shift. Moments: the alert card preview. Signature: a shift-clock status dot."
```

For a live site with no code in the worktree, pass the URL and let the child work
on a snapshot copy:

```text
belayd_unslop task="Pass 1: audit https://example.com/pricing — copy the rendered page first, we own the real site"
```

Behaviour you can rely on:

| Property | Value |
|---|---|
| Effect | blocking (`detached: false`) — the audit arrives in the same turn, like the proof verifier |
| Success | exit 0, text is the child's reply |
| Child said nothing | exit 0, `The unslop agent produced no output.` |
| Spawn failed (no provider, quota, crash) | exit 1, `unslop agent could not run: <message>` — the turn continues |
| No working directory | exit 1, `belayd_unslop has no working directory …`, nothing spawned |
| Model | `UNSLOP_AGENT.modelClass: "frontier"` (`src/agent-registry.ts`); `belayd-unslop` is not a phase, so there is no `agentOverrides` entry to change it |
| Ledger | nothing: ad-hoc runs never appear in `belayd_status` or the phase ledger, and no phase requires it |

### Calling it from a phase agent

`belayd_unslop` is in the `belayd-implementer` allowlist, so UI work can hand a
screen to the unslop agent without leaving the phase — for example an implementer
that is already editing the page. The call is identical (`task` only), it blocks,
and the audit comes back as text the phase agent can act on. It is also in
`CONSULT_TOOLS`, so it stays callable (and is never *required*) while a workflow
gate or an ask-human wait is active.

### Degrade paths

| Situation | Behaviour |
|---|---|
| `describe_image` not registered in the session (bare pi without the vision extension) | the child cannot read the PNG. The prompt requires it to report the absolute paths it produced and say the screenshot is missing — never to claim a pass from the code alone. The doctor's allowlist audit will not flag the name (it is a known external tool), so check the session's tool list instead |
| The render failed (no network, bad URL) | same: paths plus an explicit "screenshot missing", no blind pass reported as verified |
| No image-generation service | none is wired in (no vendor, no key, no `.mcp.json`). The skill's "no image tool connected" branch is the answer: the child writes the image prompt into the report instead of generating, and never fakes the visual with gradients or blobs |
| `$UNSLOP_HOME` empty (session outside a harness shell) | the child stops and says so — run it inside `nix develop`, or start the session from the devShell or pi-web |
| Story video requested, `ffmpeg` missing | `unslop-story` fails; the video is never an acceptance criterion, so report and move on |

### Cost and scope

The tool's description is advertised in every session and every spawned agent, and
each pass is a child conversation on the `frontier` class. Budget one audit and
one apply per screen, not a loop. The child's own scope rules: only the files that
render the named screen (plus the story file), no tests, no typecheck, no lint, no
commit, no redesign of what the product is.

### Credit

Keep the credit in anything you publish — a redesigned screen, a report, a story
video: *unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY
4.0*. It is already in the router and in `docs/unslop-skill.md`; do not strip it
when you copy the skill material elsewhere.
