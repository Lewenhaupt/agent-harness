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

`agent_browser` was added to the tool allowlists of the `belayd-implementer`,
`belayd-tester`, and `belayd-proof-generator` agents in
`src/agent-registry.ts`.

The flake also exports `packages.${system}.pi-agent-browser-extension`, a
directory artifact of the whole package, for the future pi-web orchestrator
symlink.

**Not wired yet.** The pi-web orchestrator discovers extensions from
`~/.pi/agent/extensions/`; that symlink is **not** created. pi-web embeds
`@earendil-works/pi-coding-agent` 0.84.1, below the extension's declared Pi
`>= 1.0.0` floor, so registering it there would be ignored or fail. That work is
tracked in bd-83. The Node engine divergence (extension declares Node
`>= 24.21.0`, the devShell provides 24.18.0) is tracked in bd-82.

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

   Expected (observed on the bd-68 verification host): 45 unit test files / 931
   tests pass, 3 integration files / 42 tests pass, `tsc --noEmit` is clean,
   `biome check .` reports "Checked 164 files … No fixes applied", and `tsc`
   emits `dist/`.

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

6. **Confirm the three agent allowlists include `agent_browser`.** After
   `pnpm build`:

   ```bash
   node -e 'const {DEFAULT_AGENTS}=require("./dist/src/agent-registry.js"); for (const n of ["belayd-implementer","belayd-tester","belayd-proof-generator"]) { const a=DEFAULT_AGENTS.find(x=>x.name===n); console.log(n, "agent_browser="+a.tools.includes("agent_browser")); }'
   ```

   Expected:

   ```text
   belayd-implementer agent_browser=true
   belayd-tester agent_browser=true
   belayd-proof-generator agent_browser=true
   ```

   Source inspection equivalent: `src/agent-registry.ts` lines ~536, ~562, and
   ~578 each end their `tools` array with `"agent_browser"`.

7. **Automated regression guard.**

   ```bash
   pnpm vitest run src/__tests__/flake-agent-browser.test.ts src/__tests__/agent-registry.test.ts
   ```

   Expected: `2 passed (2)` files / `50 passed (50)` tests. The flake test asserts
   the npm dependency, the `devShellTools` entry, all three wiring points
   (`devShellTools` → `devShells.default` and `pi-web-runtime-env`), the explicit
   store-path `--extension` in the configured binary, the exported
   `pi-agent-browser-extension` artifact, and the `-e
   npm:pi-agent-browser-native@0.9.2` line in `bin/pi`.

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
  `pi` binary and pi-web runtime read the extension from the Nix store.

### pi-web orchestrator limitation

The `agent_browser` tool is **not** available in pi-web orchestrator sessions
yet. pi-web discovers extensions from `~/.pi/agent/extensions/` and embeds
`@earendil-works/pi-coding-agent` 0.84.1, below the extension's declared Pi
`>= 1.0.0` floor. The flake exports
`packages.${system}.pi-agent-browser-extension` for the eventual NixOS symlink;
the symlink plus the pi-web SDK bump are tracked in **bd-83**. When that lands,
the NixOS side needs merely:

```nix
home.file.".pi/agent/extensions/pi-agent-browser".source = "${belaydPkgs.pi-agent-browser-extension}";
```

Related: the extension declares Node `>= 24.21.0` while the devShell provides
24.18.0. It loads and registers fine today; the version alignment is tracked in
**bd-82**.

## Related documentation

- [pi-web systemd system services](pi-web-service.md) — the service `PATH` and
  `pi-web-runtime-env`, plus the extension-discovery limitation.
- [Playwright proof tooling in the Nix runtime env](playwright-proof-env.md) —
  the other browser stack (`playwright`, `playwright-cli`) available to agents.
- [Proof verifier](proof-verifier.md) — how proof artifacts are validated.
- Upstream extension docs: `docs/TOOL_CONTRACT.md`, `docs/COMMAND_REFERENCE.md`,
  and `README.md` inside the `pi-agent-browser-native` package.
