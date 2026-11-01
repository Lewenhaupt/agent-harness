# `agent_browser` in pi-web orchestrator sessions (bd-83)

The `agent_browser` tool (from the `pi-agent-browser-native` extension, see
[docs/agent-browser-tool.md](agent-browser-tool.md)) is loaded in the
configured `pi` binary, the `bin/pi` dev wrapper, the devShell, spawned harness
sub-agents, **and pi-web orchestrator sessions**. It reaches pi-web by
extension discovery, not by an `-e` flag — no install step, no `pi install`.

## Why discovery, not `-e`

pi-web's session daemon does **not** run the `pi` binary. It imports the bundled
pi SDK in-process (`PI_WEB_PI_PACKAGE_DIR`) and discovers extensions from
`$PI_CODING_AGENT_DIR/extensions/<name>/package.json` `pi.extensions`.

The `-e`/`-ne` list derived from `nix/pi-extensions/package.json` reaches only
`bin/pi`, `belayd-pi`, and spawned sub-agents. An extension that exists only in
that list therefore works in a terminal and is invisible in pi-web. bd-205 fixed
that for every third-party extension; bd-83 was the agent-browser instance of
it. The two symptoms that pinned the cause:

- no `commandcode` provider in pi-web — 95 models in a terminal session, 0 in
  pi-web;
- `belayd_doctor` reporting `ast_grep`, `web_search_exa`, `web_fetch_exa`,
  `deep_search_exa` and `describe_image` as unknown tool names in a pi-web
  session.

## Wiring

`flake.nix` derives both forms from the same manifest:

- `packages.<system>.pi-extension-<dirName>` — one store dir per package, holding
  symlinks to the package's top-level entries (`package.json`, `dist`,
  `scripts`, …) plus a `node_modules` symlink into the pi-extensions tree, so a
  loader that follows the symlink still resolves the entry's runtime deps.
  Buildable names: `pi-extension-pi-agent-browser`,
  `pi-extension-pi-commandcode-provider`, `pi-extension-openrouter`,
  `pi-extension-pi-exa`, `pi-extension-pi-ast-grep`,
  `pi-extension-pi-vision-tool`, `pi-extension-plannotator`.
- `legacyPackages.<system>.pi-web-extension-dirs` — the set nix-tmp symlinks,
  keyed by directory name (those seven plus `belayd-harness`). It is a set, not
  a derivation, hence `legacyPackages`.

The nix-tmp `modules/core/belayd-pi-web.nix` home-manager module turns that set
into every `~/.pi/agent/extensions/` symlink:

```nix
belaydLegacyPackages = inputs.agent-harness.legacyPackages.${system};
...
home.file = {
  ".agents/skills/beads"…;
  ".agents/skills/backlog"…;
}
// lib.mapAttrs' (name: source: lib.nameValuePair ".pi/agent/extensions/${name}" { inherit source; force = true; })
  belaydLegacyPackages.pi-web-extension-dirs;
```

`//` rather than a second `home.file."<path>"` entry because Nix cannot
statically merge `home.file` with `home.file.<path>` inside the
dynamically-keyed `home-manager.users.${username}` attrset. The two old
hand-listed symlinks (`belayd-harness`, `pi-agent-browser`) are subsumed by the
set. The delta is recorded in `nix/nix-tmp-belayd-pi-web.patch`.

`piWebDirFor` in `flake.nix` throws at **evaluation** time when a `piExtensions`
entry has no `piWebDirs` name, so a new dependency cannot silently stay
terminal-only.

## Status: wired and live

`~/.pi/agent/extensions/` is home-manager-managed from that set on this host,
the agent-browser extension has been live in pi-web sessions for a while, and
its tools are in a pi-web session's tool catalog. The earlier "blocked on push +
`flake.lock` bump" state is history: that rebuild chain landed.

A future bump keeps the same ordering:

1. push the harness rev;
2. in nix-tmp: `nix flake lock --update-input agent-harness`;
3. `nixos-rebuild switch`;
4. restart `pi-web-sessiond` (and `pi-web` only if the web/API process itself
   changed).

### Restart rule: provider extensions only

pi-web freezes the provider registry when `pi-web-sessiond` starts and logs
later registrations as ignored:

```json
{"context":"global-provider-bootstrap","code":"PROVIDER_MUTATION_IGNORED",
 "operation":"registerProvider","providerId":"commandcode",
 "reason":"not-in-startup-baseline"}
```

"Provider registrations are shared across sessions and fixed at daemon startup."
A newly added **provider** extension (`openrouter`, `pi-commandcode-provider`)
therefore needs a `pi-web-sessiond` restart — restarting only `pi-web`/the web
API does not rebuild the baseline, and `/reload` does not either.

**Tool-only** extensions (agent-browser, exa, ast-grep, vision, plannotator) are
picked up by the next session with **no** restart.

pi-web stays pinned to upstream tag v1.202610.8, whose embedded
`@earendil-works/pi-coding-agent` resolves to 1.3.0 — meeting the extension's
declared Pi `>= 1.0.0` floor, so its
`defaultActive`/`namespace`/`outputSchema` features are supported.

## How to Verify

Run steps 1–2 from this repository root, in the project devShell
(`direnv exec . bash`, or wrap each command in `nix develop -c bash -c '<cmd>'`);
3–5 on the host. They need no sudo and no rebuild.

A `path:` flake ref is required in this repo (`nix build "path:$PWD#…"`) because
the checkout is currently marked bare, and `git status` fails there for the same
reason. That is a checkout quirk, not a symptom.

1. **Build the artifact the symlink points at and read its shape.**

   ```bash
   ext=$(nix build "path:$PWD#pi-extension-pi-agent-browser" --no-link --print-out-paths)
   ls -l "$ext"
   jq -r '.pi.extensions[]' "$ext/package.json"
   test -f "$ext/dist/extensions/agent-browser/index.js" && echo entry-ok
   ```

   Expected: a store dir of top-level symlinks (`package.json`, `dist`,
   `scripts`, …) plus a `node_modules` symlink into the pi-extensions tree,
   exactly `./dist/extensions/agent-browser/index.js` from `jq`, and `entry-ok`.
   pi's discovery reads this `package.json` from the directory root, so this is
   the entry the orchestrator loads.

2. **Confirm the set pi-web actually symlinks.**

   ```bash
   nix eval --json "path:$PWD#legacyPackages.x86_64-linux.pi-web-extension-dirs" \
     --apply builtins.attrNames
   ```

   Expected: 8 names — `belayd-harness`, `openrouter`, `pi-agent-browser`,
   `pi-ast-grep`, `pi-commandcode-provider`, `pi-exa`, `pi-vision-tool`,
   `plannotator`.

   Optional, and the proof that discovery alone is enough: build a temp dir `T`
   with `T/extensions/<name>` symlinks and ask a plain `pi` for its models.

   ```bash
   PI_CODING_AGENT_DIR=$T /nix/store/kxm7hbq3yqq2yy1jszb1zxn777zhar82-pi-1.0.2/bin/pi --list-models
   # 95 commandcode rows, 450 openrouter rows
   PI_CODING_AGENT_DIR=$T /nix/store/kxm7hbq3yqq2yy1jszb1zxn777zhar82-pi-1.0.2/bin/pi -ne --list-models
   # 0 rows: -ne turns discovery off, which is how the -e surfaces load
   ```

3. **Confirm the host symlinks.**

   ```bash
   ls -l ~/.pi/agent/extensions/
   readlink -f ~/.pi/agent/extensions/pi-agent-browser
   # /nix/store/<hash>-pi-extension-pi-agent-browser
   jq -r '.pi.extensions[]' ~/.pi/agent/extensions/pi-agent-browser/package.json
   # ./dist/extensions/agent-browser/index.js
   ```

   Expected: eight entries, each resolving into the store —
   `…-pi-extension-<dirName>` for the third-party packages, home-manager's file
   tree for `belayd-harness`. A missing entry means the rebuild came from a
   stale generation or the harness rev in nix-tmp's `flake.lock` predates
   `pi-web-extension-dirs`.

4. **Confirm the extension is visible to a pi-web session without a restart.**
   Call `belayd_doctor` in a pi-web orchestrator session: `agent_browser` is in
   the declared catalog with its source extension, and no unknown-name entries
   are reported for the tool-only extensions listed above.

5. **End-to-end: call `agent_browser` from an orchestrator session.** Open the
   pi-web UI (`PI_WEB_HOST`/`PI_WEB_PORT`, default `0.0.0.0:8504`), start a
   session in this repository (or any worktree), and ask the orchestrator — not
   a sub-agent — to use the tool:

   ```text
   Use the agent_browser tool with args ["open", "data:text/html,<h1>bd-83 live</h1>"] and then report the URL it navigated to. Do not use any other tool.
   ```

   Then a screenshot round-trip:

   ```text
   Use the agent_browser tool with args ["screenshot", "/tmp/bd83-live.png"], then confirm the file exists.
   ```

   Expected evidence:

   - a real tool call named `agent_browser` in the session (an orchestrator
     without the extension reports an unknown tool or falls back to `bash` +
     `curl`);
   - the navigation result echoing the `data:text/html` URL, exit status 0;
   - the screenshot written to an existing file (`ls -l /tmp/bd83-live.png`);
   - **no** `agent-browser not found`, no
     `Chromium distribution 'chrome' is not found`, no missing-shared-library
     error.

   This uses the session's model, so it consumes model quota. The raw-CLI
   fallback (`nix develop -c agent-browser open "data:text/html,<h1>ok</h1>"`)
   only proves the browser engine, not the orchestrator wiring.

Daemon-side log, if a session does not see the extension:

```bash
journalctl -u pi-web-sessiond -f
# session start with no extension-load error for pi-agent-browser
```

## Failure modes

| Symptom in a pi-web session | Likely cause | Check |
|-----------------------------|--------------|-------|
| `agent_browser` unknown / not offered | symlink missing or misnamed; tool-only, so no restart is involved | `ls -l ~/.pi/agent/extensions/`, then step 3 |
| Any third-party tool present in a terminal but absent in pi-web | not in `pi-web-extension-dirs` (no `piWebDirs` name) | step 2's `attrNames`, then `piWebDirs` in `nix/pi-extensions/package.json` |
| Provider missing (`/model` lists none in pi-web, 95 in a terminal) | provider registered after the daemon's startup baseline | `sudo systemctl restart pi-web-sessiond`; look for `PROVIDER_MUTATION_IGNORED` / `not-in-startup-baseline` in `journalctl -u pi-web-sessiond` |
| Old extension behavior right after a rebuild | `pi-web-sessiond` still running the pre-rebuild closure | `systemctl show -p ExecStart pi-web-sessiond`, compare with the current store path, restart |
| `agent-browser not found` | CLI not on the session `PATH` | `agent-browser` must come from `pi-web-runtime-env`; see [agent-browser-tool.md](agent-browser-tool.md) |
| Chromium launch / shared-library errors | bundled chromium not wired | `AGENT_BROWSER_EXECUTABLE_PATH` is set by the Nix wrapper; re-check the runtime env build |
| Node engine warning (`pi-agent-browser-native` wants Node `>= 24.21.0`) | version divergence, tracked in bd-82, non-fatal today | `node --version` vs the extension's `engines.node` |

## How to Use

In a pi-web orchestrator session the tool behaves exactly as in the configured
`pi`; nothing needs installing by hand (the extension is Nix-managed, no
`pi install`). Ask in natural language:

```text
Use the agent_browser tool to open https://react.dev and then take an interactive snapshot.
```

or call it with the same argv-style `args` array the other surfaces use:

```json
{ "args": ["open", "https://example.com"] }
{ "args": ["snapshot", "-i"] }
{ "args": ["click", "@e2"] }
{ "args": ["screenshot", "/tmp/page.png"] }
```

Key points for orchestrator sessions:

- **The orchestrator can use it directly** — the reason for bd-83 — and the
  `belayd-implementer` and `belayd-proof-generator` sub-agents keep it via
  their existing allowlists (`src/agent-registry.ts`). `belayd-tester` dropped
  it in bd-114 (0 browser calls in 55 sessions).
- **`agent-browser` plus its chromium must be on the session `PATH`.** In
  pi-web that is `pi-web-runtime-env`; the same tool outside pi-web needs the
  devShell. The extension ships no browser.
- **Prefer absolute artifact paths** for screenshots; the browser daemon's
  working directory can differ from the session's. On the harness, write proof
  screenshots under `proof-of-work/<task-id>/`.
- **Re-snapshot after navigation or rerender** — `@eN` refs from `snapshot -i`
  go stale.
- Command reference, session modes, and the `agent_browser_code` /
  `agent_browser_tools` companions: [docs/agent-browser-tool.md](agent-browser-tool.md).

## Related documentation

- [docs/agent-browser-tool.md](agent-browser-tool.md) — the tool itself:
  every load surface, the CLI prerequisite, and the full argument reference.
- [docs/packaging.md](packaging.md) — the two extension manifests and why every
  entry needs both the `-e` form and the discovery (directory) form.
- [docs/instruction-groups.md](instruction-groups.md) — bd-114: the prompt-section
  tool allowlist gate (why non-browser agents no longer pay ~8.7k tokens/turn)
  and its verification runbook.
- [docs/pi-web-service.md](pi-web-service.md) — the systemd services, the
  `pi-web-runtime-env` `PATH`, and the restart rules after a rebuild.
- [docs/playwright-proof-env.md](playwright-proof-env.md) — the other browser
  stack (`playwright`, `playwright-cli`) available to pi-web sessions.
