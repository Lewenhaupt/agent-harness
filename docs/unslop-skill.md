# unslop UI-design skill (bd-253)

[unslop](https://github.com/heydamir/unslop) is Damir Sokolovsky's
([@heydamir](https://x.com/heydamir)) UI-design skill: it audits the tells of
vibecoded UI (purple gradients, glows, emoji labels, uneven spacing), fixes them
in nine ordered passes, and gives the screen a direction derived from the
product. Licensed **CC BY 4.0** — the credit travels with every copy and
adaptation, including a rendered story video.

bd-253 makes it usable in this harness in three pieces, and nothing else:

1. a pinned Nix package `unslop` (flake.nix) that carries the upstream skill
   material at a stable store path,
2. a thin **router skill** at `.agents/skills/unslop/SKILL.md` that reads the
   pinned material in place instead of vendoring it, and
3. an ad-hoc **`belayd_unslop`** tool backed by the `belayd-unslop` agent, so a
   session gets a rendered screenshot and a vision read without
   `agent_browser`.

It adds **no workflow phase**: `belayd-unslop` is deliberately absent from
`DEFAULT_AGENTS`, so the phase-tool registration loop never creates a
`belayd_unslop` phase tool and there is no `agentOverrides` surface for it.

## The pin and `$UNSLOP_HOME`

`flake.nix` fetches upstream by rev
(`a6f121eee5f29c2f74976b75456feae8b66afb3a`) and hash, and lays it out as:

| Path under `$out` | Contents |
| --- | --- |
| `libexec/unslop/` | upstream `skills/unslop/` — `SKILL.md`, `references/` (incl. `refs/*.webp`), `scripts/{snapshot,story}.mjs`, `agents/openai.yaml` |
| `libexec/unslop/examples/` | upstream `examples/` — `dashboard.html`, `hero.html`, `assets/blob.webp` |
| `lib/node_modules/playwright-core/` | `${pkgs.playwright-driver}/.`, the same derivation `PLAYWRIGHT_BROWSERS_PATH` is built from |
| `bin/unslop-snapshot`, `bin/unslop-story` | wrappers that export `NODE_PATH` and exec node on the upstream script |

`examples/` lives *inside* the skill directory because upstream `SKILL.md` and
`references/refs.md` name `examples/dashboard.html` relatively.

`UNSLOP_HOME` mirrors `ARCHIFY_HOME` in three places, so every consumer sees the
same value without guessing a store hash:

| Place | What it covers |
| --- | --- |
| pi-web module `environment` (`"UNSLOP_HOME=${unslop}/libexec/unslop"`) | `pi-web` and `pi-web-sessiond` (both use `Environment = environment`), and therefore every spawned agent through `spawn.ts`'s env copy |
| devShell `shellHook` (`export UNSLOP_HOME=...`) | `nix develop` shells, which is also what `belayd-shell` resolves from `$PWD` |
| `unslop` in `devShellTools` → `pi-web-runtime-env` | the wrappers on `PATH` in all of the above |

No `spawn.ts` change is needed: skills are session-level (pi advertises each
skill as name + description + path, `docs/skills.md`), and `AgentDefinition` has
no skills field. `.agents/skills/` is shipped by `belayd-skills` into
`~/.agents/skills` and is also discovered from the worktree cwd, so the router
reaches the orchestrator *and* each spawned agent.

## Why the wrappers exist

Both upstream scripts resolve Playwright with
`createRequire(join(process.cwd(), "package.json"))("playwright-core")`. That
only works from a project that installed it — and their earlier
`import("playwright")` attempt inside an ESM module never consults `NODE_PATH`,
so it fails silently. `unslop-snapshot` and `unslop-story` therefore export
`NODE_PATH="$out/lib/node_modules"` before exec'ing node, which resolves the
pinned `playwright-core` regardless of the caller's cwd.

The router maps upstream's absolute paths onto them:

| Upstream | Here |
| --- | --- |
| `node /scripts/snapshot.mjs <url> <out.html> [pass label] [--dark\|--light] [--width=] [--height=]` | `unslop-snapshot <url> <out.html> [pass label] [--dark\|--light] [--width=] [--height=]` |
| `node /scripts/story.mjs <story.html> <out.mp4> [--wide]` | `unslop-story <story.html> <out.mp4> [--wide]` |
| `node /scripts/story.mjs <story.html> --play` | `unslop-story <story.html> --play` |

`unslop-snapshot` writes `<out>.live.png` next to the HTML; that PNG is what
`describe_image` reads.

`pkgs.ffmpeg` is in `devShellTools` because `scripts/story.mjs` hard-fails
without it. Nothing else in the harness shells out to ffmpeg, and the story
video is never an acceptance criterion — it works when asked for.

## The agent and the tool

- `src/agent-registry.ts`: `UNSLOP_TOOLS`, `UNSLOP_SYSTEM_PROMPT`,
  `UNSLOP_AGENT` (`belayd-unslop`, `modelClass: "frontier"`).
- `extensions/capabilities/unslop.ts`: `runUnslop` + `registerUnslop`, wired in
  `extensions/index.ts` next to the supervision tools.
- `"belayd_unslop"` is in `HARNESS_TOOL_NAMES` (`src/tool-audit.ts`), in
  `CONSULT_TOOLS` (`src/role-tools.ts`) and in the `belayd-implementer`
  allowlist; `UNSLOP_AGENT` is in the doctor's audited agent list, which is the
  only place a non-default agent's allowlist is audited.

The `CONSULT_TOOLS` entry is load-bearing: when a workflow gate is active the
harness calls `pi.setActiveTools(workflowGateToolSet(...))`, which denies every
registered tool outside that set. Consult means "callable mid-workflow, never a
required step" — the same role `belayd_archify` has — so both passes can run from
the gated orchestrator. `src/__tests__/tool-contract.test.ts` fails if a
`belayd_*` tool an agent may call is not reachable under some workflow's gate.

The tool is **blocking** (`detached: false`), like the proof verifier: the
orchestrator shows the audit to the human in the same turn. Ad-hoc runs never
appear in `belayd_status` or the phase ledger.

### Two passes, split by the human

Upstream's run loop sets a direction and waits for the user before editing.
A spawned child has no `ask_user`, so the protocol is explicit in the system
prompt:

1. **Pass 1** — render the screen with `unslop-snapshot`, describe the PNG with
   `describe_image`, write the audit against `references/signs.md`, write the
   five direction lines (Product, Character, World, Moments, Signature), then
   **stop** and return `## Audit`, `## Direction` and `## Screenshot`.
2. **Pass 2** — the orchestrator replies with the confirmed (or edited)
   direction; only then does the agent apply the nine passes, re-render, compare
   against its audit list, and report per pass.

Degraded mode: if `describe_image` is unavailable (bare pi without
pi-vision-tool) or the render failed, the agent reports the paths it produced
and says the screenshot is missing. A blind pass is never reported as verified.
`belayd_doctor` shows the missing tool.

## No image-generation service

No image-generation MCP is wired in: no vendor, no key, no `.pi/mcp.json`. When
the skill reaches its "no image tool connected" branch, the agent writes the
image prompt into the report instead of generating an image, and never fakes the
visual with gradients or blobs.

## Re-pinning upstream

1. Pick the new commit and set `rev` in the `unslop` derivation in `flake.nix`.
2. Set `hash = pkgs.lib.fakeHash;`, run `nix build .#unslop --print-out-paths`,
   and paste the reported `got:` hash into `hash`.
3. Check the layout the router promises still exists in the new rev:
   `skills/unslop/{SKILL.md,references,scripts}`, `examples/`, and the
   `snapshot.mjs` / `story.mjs` names. If upstream moves them, update the
   `installPhase` and `.agents/skills/unslop/SKILL.md` together —
   `src/__tests__/unslop-assets.test.ts` guards the router's promises.
4. If the upstream description changed, copy it verbatim into the router's
   frontmatter again (that is the routing surface).
5. `pnpm test` (the assets guard), then rebuild the consumers:
   `nix build .#unslop --print-out-paths` and
   `nix build --print-out-paths 'path:.#belayd-skills'` (flakes see only
   git-tracked files, so an untracked router needs `path:`).

The rev is recorded twice on purpose: the `rev` attribute is the pin itself and
the derivation comment names the commit, so a bump is one edit plus one hash.

## Verify

```bash
# inside the devShell
echo "$UNSLOP_HOME"                         # non-empty, ends in /libexec/unslop
unslop-snapshot https://example.com /tmp/u.html   # writes /tmp/u.html + /tmp/u.live.png
unslop-story                                  # prints its usage, not a Playwright error
pnpm test -- unslop-assets                    # router + flake guard
```

- `nix build .#unslop --print-out-paths` then `ls $out/libexec/unslop` must show
  `SKILL.md`, `references/`, `scripts/`, `agents/`, `examples/`.
- `nix build --print-out-paths 'path:.#belayd-skills'` then `ls $out` must show
  `unslop/` (the package output *is* the `~/.agents/skills` tree).
- `belayd_doctor` in a fresh session: `belayd_unslop` appears in the declared
  tool catalog and no "unknown allowlist names" warning names it.
- Two-pass smoke on a scratch screen: pass 1 returns an audit, five direction
  lines and a screenshot the agent actually described; pass 2 applies the
  confirmed direction and reports per pass.

## Risks this shape accepts

- **Upstream drift** — covered by the guard test and the re-pin checklist.
- **Playwright resolution** — if the wrapper path breaks, `unslop-snapshot`
  fails loudly with upstream's "Playwright is not installed" message; fix the
  derivation rather than adding `agent_browser` to the agent allowlist.
- **Cost** — the tool description is advertised in every session and every
  spawned agent. That is the accepted price of making it callable from both the
  orchestrator and the implementer.
- **Taste** — the direction pass is judgement-heavy; the screenshot plus
  `describe_image` is what keeps it honest.
