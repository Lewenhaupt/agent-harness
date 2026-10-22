# `agent_browser` in the harness (bd-68)

The harness now bundles the pi npm extension
[`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native)
(v0.9.2), which exposes an `agent_browser` tool backed by the Nix-provided
[`agent-browser`](https://agent-browser.dev/) CLI (`llm-agents` 0.38.2, with a
bundled chromium). The extension is loaded in three places:

- the configured `pi` binary (`packages.${system}.pi`), via an explicit
  `--extension` flag pointing at the store path of
  `pi-agent-browser-native/dist/extensions/agent-browser/index.js`;
- the isolated repo-dev wrapper `bin/pi`, via
  `-e npm:pi-agent-browser-native@0.9.2` (fetched into `~/.pi/agent/npm` at
  runtime, then cached);
- the devShell (`devShells.default`), because `llm-agents.packages.${system}.agent-browser`
  was added to the shared `devShellTools` list, which also feeds
  `pi-web-runtime-env` (the `PATH` for the `pi-web` systemd services).

`agent_browser` is in the tool allowlists of the `belayd-implementer` and
`belayd-proof-generator` agents in `src/agent-registry.ts`. bd-114 removed it
from `belayd-tester` (0 browser calls across 55 sessions) and switched the
prompt section to a managed instruction group so sessions whose allowlist
excludes every browser tool no longer receive the ~35k-char section at all —
see [Managed instruction-group gate](#managed-instruction-group-gate).

The flake also exports `packages.${system}.pi-agent-browser-extension`, a
directory artifact of the whole package, for the pi-web orchestrator symlink.

**Wired in the flake.nix + nix-tmp working tree; blocked on the belayd push +
nix-tmp flake.lock bump before a rebuild will evaluate.** pi-web is pinned to
upstream tag v1.202610.6 (`flake.nix`), whose embedded
`@earendil-works/pi-coding-agent` resolves to 1.3.0 — meeting the extension's
declared Pi `>= 1.0.0` floor, so its `defaultActive`/`namespace`/`outputSchema`
features are supported. The nix-tmp `belayd-pi-web` home-manager module now
creates `~/.pi/agent/extensions/pi-agent-browser` pointing at that artifact
(recorded here as `nix/nix-tmp-belayd-pi-web.patch`). A rebuild today errors
because nix-tmp's `flake.lock` still pins `belayd` at a rev that predates the
`pi-agent-browser-extension` export; see the full prerequisite chain under
[pi-web orchestrator status](#pi-web-orchestrator-status). A live `agent_browser`
run in an orchestrator session has **not** yet been verified. The Node engine
divergence (extension declares Node `>= 24.21.0`, the devShell provides 24.18.0)
is tracked in bd-82.

## How to Verify

Run these from the repository root. Steps 1–6 are runnable in the project
devShell (`direnv exec . bash`, or `nix develop -c bash -c '<cmd>'`).

1. **Confirm the `agent-browser` CLI resolves in the devShell and reports the
   bundled version.**

   ```bash
   nix develop -c agent-browser --version
   nix develop -c which agent-browser
   ```

   Expected:

   ```text
   agent-browser 0.38.2
   /nix/store/<hash>-agent-browser-0.38.2/bin/agent-browser
   ```

   The store hash is machine-specific; what matters is the `agent-browser-0.38.2`
   derivation name and exit status 0. The wrapper sets
   `AGENT_BROWSER_EXECUTABLE_PATH` to the bundled chromium, so no system Chrome is
   needed.

2. **Confirm `agent-browser` propagates into the pi-web service `PATH`.** The
   systemd units prepend `pi-web-runtime-env/bin`. Same list as the devShell, so
   this one build proves both:

   ```bash
   env=$(nix build .#pi-web-runtime-env --print-out-paths --no-link)
   ls "$env/bin" | grep -E 'agent-browser|pi$|node'
   "$env/bin/agent-browser" --version
   ```

   Expected: `agent-browser`, `pi`, and `node` in the listing, then
   `agent-browser 0.38.2`. On a live host, the equivalent runtime check is
   `systemctl show pi-web -p Environment` / the unit's
   `PATH=<pi-web-runtime-env>/bin:…` line (see `docs/pi-web-service.md`).

3. **Build every affected flake output.**

   ```bash
   nix build .#pi-extensions .#pi .#pi-agent-browser-extension .#belayd-harness .#pi-web-runtime-env \
     --print-out-paths
   ```

   Expected: five store paths printed, exit status 0. Spot-check the extension
   artifact:

   ```bash
   ext=$(nix build .#pi-agent-browser-extension --print-out-paths --no-link)
   ls -l "$ext"
   jq -r '.pi.extensions[]' "$ext/package.json"
   ```

   Expected: symlinks `package.json`, `dist`, `scripts`, `node_modules` into the
   `pi-extensions` tree, and `./dist/extensions/agent-browser/index.js`.

4. **Run the harness quality gates.**

   ```bash
   pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build
   ```

   Expected: `tsc --noEmit` is clean, `biome check .` reports "Checked 117
   files … No fixes applied", and `tsc` emits `dist/`.

   The suite sizes quoted here were originally observed on the bd-68
   verification host: 45 unit test files / 931 tests and 3 integration files /
   42 tests. **Those counts are superseded by bd-114** — the bd-114 verification
   host observes 63 unit test files / 1361 tests and 5 integration files / 58
   tests. Do not treat the bd-68 numbers as live; see
   [instruction-groups.md](instruction-groups.md) for the current counts.

5. **Smoke-test the real `agent_browser` tool in the configured `pi`.** This is
   the end-to-end check: a store-path extension loading into Pi 1.0.2, launching
   the bundled chromium against a `data:` URL, with no network. Run it **inside
   the devShell** so `agent-browser` is on `PATH`:

   ```bash
   nix run .#pi -- -p --no-session --tools agent_browser \
     'Use the agent_browser tool with args ["open", "data:text/html,<h1>bd-68 smoke</h1>"] and then report the URL it navigated to. Do not use any other tool.'
   ```

   Expected: startup logs including
   `[belayd-harness] registering tools/commands from file:///nix/store/…/belayd-harness-0.0.1/extensions/index.ts`,
   then a real navigation result (observed:
   `Navigated to: data:text/html,<h1>bd-68 nix smoke</h1>`), and exit status 0.
   There must be **no** `agent-browser not found`, no
   `Chromium distribution 'chrome' is not found`, and no missing-shared-library
   error. This uses the default `llmgateway` model, so it consumes a little model
   quota.

   The isolated repo-dev wrapper does the same thing via the npm-sourced copy
   (first run needs registry access to populate `~/.pi/agent/npm`):

   ```bash
   ./bin/pi -p --no-session --tools agent_browser \
     'Use the agent_browser tool with args ["open", "data:text/html,<h1>bd-68 smoke</h1>"] and then report the URL it navigated to. Do not use any other tool.'
   ```

   A cheap no-model fallback that only proves the browser engine works is the
   raw CLI: `nix develop -c agent-browser open "data:text/html,<h1>ok</h1>"`.

6. **Confirm the two agent allowlists include `agent_browser` and the tester
   does not.** After `pnpm build`:

   ```bash
   node -e 'const {DEFAULT_AGENTS}=require("./dist/src/agent-registry.js"); for (const n of ["belayd-implementer","belayd-tester","belayd-proof-generator"]) { const a=DEFAULT_AGENTS.find(x=>x.name===n); console.log(n, "agent_browser="+a.tools.includes("agent_browser")); }'
   ```

   Expected:

   ```text
   belayd-implementer agent_browser=true
   belayd-tester agent_browser=false
   belayd-proof-generator agent_browser=true
   ```

   Source inspection equivalent: `src/agent-registry.ts` line 560
   (`belayd-implementer`) and line 604 (`belayd-proof-generator`) each end their
   `tools` array with `"agent_browser"`; `belayd-tester` (`src/agent-registry.ts`
   line 588) does not.

7. **Automated regression guard.**

   ```bash
   pnpm vitest run src/__tests__/flake-agent-browser.test.ts src/__tests__/agent-registry.test.ts
   ```

   Expected: `2 passed (2)` files / `56 passed (56)` tests. The flake test asserts
   the npm dependency, the `devShellTools` entry, all three wiring points
   (`devShellTools` → `devShells.default` and `pi-web-runtime-env`), the explicit
   store-path `--extension` in the configured binary, the exported
   `pi-agent-browser-extension` artifact, and the `-e
   npm:pi-agent-browser-native@0.9.2` line in `bin/pi`.

## Managed instruction-group gate

Full runbook (verification, configuration, log lines, troubleshooting):
[Managed instruction groups](instruction-groups.md).

The browser extension ships ~35k chars (~8.7k tokens) of prompt instructions.
It tries to gate them on tool availability through pi's `pi:instruction-groups`
event channel, but pi 1.0.2 emits nothing on that channel, so the extension's
unconditional fallback (`event.systemPromptOptions.sections.agent_browser =
fullInstructions(ctx)`) always wins — even in sessions whose `--tools`
allowlist has no browser tool.

The harness closes that gap:

- `src/instruction-groups.ts` implements the collector contract. It emits
  `pi:instruction-groups` from `before_agent_start` until a group registers,
  registers a collector, and applies the registered groups to
  `systemPromptOptions.sections`.
- A group's instructions are written under the **group name** (`browser`), not
  the legacy fallback key (`agent_browser`). When the collector owns any group
  the harness deletes `agent_browser` so a load order that lets the fallback
  run cannot append a duplicate section. Browser-enabled sessions therefore
  change their section tag from `<agent_browser>…</agent_browser>` to
  `<browser>…</browser>` — a one-time prompt-cache invalidation, not a
  regression.
- A group is active only when at least one of its tools is in the session's
  `selectedTools`. A session whose allowlist excludes every browser tool gets
  no `<browser>` section; a session with `agent_browser` in `--tools` keeps it.

The gate is bypassed (and unmanaged fallback behaviour preserved exactly) when
`selectedTools` is missing/empty or no extension registered a group.

**Verify the gate:**

```bash
pnpm vitest run src/__tests__/instruction-groups.test.ts
```

To prove it against the real agent allowlists, run the pure function with each
`DEFAULT_AGENTS` entry's `tools`: scout/reviewer produce no `browser` section;
implementer/proof-generator do. For a live check, spawn the scout sub-agent and
confirm its session JSONL's `message.sections` contains no `browser` /
`agent_browser` key, then spawn the implementer and confirm `browser` is
present. Use `jq` on `.message.sections` rather than grepping the raw JSONL —
the transcript legitimately contains those tag strings in `project_context` and
in tool output. The exact `node -e`, `jq`, and session-path commands are in
[instruction-groups.md](instruction-groups.md#how-to-verify).

## How to Use

Agents and humans invoke the tool through pi, which loads the extension listed
above. The tool takes an argv-style `args` array (plus optional `sessionMode`,
`outputPath`, and other fields), not a shell string.

Natural-language request to the agent:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

Equivalent native tool calls:

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
{ "args": ["click", "@e2"] }
{ "args": ["snapshot", "-i"] }
```

Common operations:

- **Open / navigate** — `{ "args": ["open", "https://example.com"] }`; use
  `{ "args": ["navigate", "https://example.com"] }` for a fresh navigation on an
  existing page, and `open` with no URL to read the current URL.
- **Screenshot** — `{ "args": ["screenshot", "/tmp/page.png"] }`. Artifact paths
  are caller-owned and normalized; prefer absolute paths because the browser
  daemon's working directory may differ from pi's. On the harness, write proof
  screenshots under `proof-of-work/<task-id>/`.
- **Inspect / interact** — take `snapshot -i` for interactive `@eN` refs, then
  click/fill those refs. Re-snapshot after navigation, scroll, or any rerender
  (refs go stale). `find role button click --name Close` is a stable alternative.
- **Batch / code** — `batch --bail` for a fixed sequence of commands, and the
  companion `agent_browser_code` tool for loops/branches. Other specialized
  tools (`agent_browser_action`, `agent_browser_qa`, …) are available through
  `agent_browser_tools` and are not enabled by default.

### Environment prerequisites

- **`agent-browser` must be on `PATH` with its chromium.** In this repo that
  means: run inside the devShell, or run under the `pi-web` service (whose
  `PATH` includes `pi-web-runtime-env`). The extension itself ships no browser.
- **`nix run .#pi` outside a devShell does *not* provide `agent-browser` or the
  bundled chromium.** The pi wrapper is self-contained for extensions, not for
  the browser engine. Use it from inside `nix develop`, or put
  `llm-agents.packages.${system}.agent-browser` on `PATH` another way.
- **`bin/pi` and `PI_OFFLINE`.** The repo-dev wrapper loads the extension from
  npm (`-e npm:pi-agent-browser-native@0.9.2`), so the first run needs registry
  access; with `PI_OFFLINE=1` (or no network) the fetch cannot happen and the
  tool is silently absent. This affects only the dev wrapper — the configured
  `pi` binary reads the extension from the Nix store; pi-web will once the
  rebuild lands (see the wiring chain below).

### pi-web orchestrator status

The `agent_browser` tool is wired for pi-web orchestrator sessions in the
flake.nix + nix-tmp working tree, but it is **not** active yet and the wiring is
blocked before a rebuild will evaluate. pi-web discovers extensions from
`~/.pi/agent/extensions/` and is now pinned to upstream tag v1.202610.6, whose
embedded `@earendil-works/pi-coding-agent` resolves to 1.3.0 (satisfying the
extension's Pi `>= 1.0.0` floor). The NixOS side adds:

```nix
home.file.".pi/agent/extensions/pi-agent-browser".source = "${belaydPkgs.pi-agent-browser-extension}";
```

in the nix-tmp `belayd-pi-web` home-manager module (patch recorded at
`nix/nix-tmp-belayd-pi-web.patch`). A rebuild **today errors**: nix-tmp's
`flake.lock` still pins `belayd` at a rev older than the flake that exports
`pi-agent-browser-extension`, so `belaydPkgs.pi-agent-browser-extension` is
undefined. The prerequisite chain is:

1. commit + push the belayd flake (bd-68/bd-81/bd-83);
2. in nix-tmp: `nix flake lock --update-input belayd` (or equivalent flake.lock
   bump);
3. `nixos-rebuild` + `sudo systemctl restart pi-web pi-web-sessiond`;
4. verify `readlink -f ~/.pi/agent/extensions/pi-agent-browser` and a real
   `agent_browser` navigate/screenshot in an orchestrator session (bd-83).

The runnable pre-rebuild checks, the expected blocked rebuild error, and the
post-rebuild live verification steps are spelled out in
[`agent_browser` in pi-web orchestrator sessions](pi-web-agent-browser.md).

Related: the extension declares Node `>= 24.21.0` while the devShell provides
24.18.0. It loads and registers fine today; the version alignment is tracked in
**bd-82**.

## Related documentation

- [Managed instruction groups](instruction-groups.md) — bd-114: how the
  browser prompt section is gated on the session tool allowlist, and how to
  verify it.
- [`agent_browser` in pi-web orchestrator sessions](pi-web-agent-browser.md) —
  the bd-83 verification runbook: pre-rebuild checks, blocked-state proof, and
  post-rebuild live checks.
- [pi-web systemd system services](pi-web-service.md) — the service `PATH` and
  `pi-web-runtime-env`, plus the agent-browser extension wiring status.
- [Playwright proof tooling in the Nix runtime env](playwright-proof-env.md) —
  the other browser stack (`playwright`, `playwright-cli`) available to agents.
- [Proof verifier](proof-verifier.md) — how proof artifacts are validated.
- Upstream extension docs: `docs/TOOL_CONTRACT.md`, `docs/COMMAND_REFERENCE.md`,
  and `README.md` inside the `pi-agent-browser-native` package.
