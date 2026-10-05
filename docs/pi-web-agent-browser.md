# `agent_browser` in pi-web orchestrator sessions (bd-83)

The `agent_browser` tool (from the `pi-agent-browser-native` extension, see
[docs/agent-browser-tool.md](agent-browser-tool.md)) is loaded in the
configured `pi` binary, the `bin/pi` dev wrapper, the devShell, and spawned
harness sub-agents. **pi-web orchestrator sessions are the one place it does not
load yet**: pi-web's session daemon runs pi in-process through its own embedded
`@earendil-works/pi-coding-agent`, and that SDK was too old to register the
extension.

bd-83 closes that gap in two halves:

1. **pi-web SDK floor** — `flake.nix` pins pi-web to upstream tag
   `v1.202610.1` (`rev 3f5f39eb988810b468f486e4334f10adcdb96b21`), whose
   `package-lock.json` resolves `@earendil-works/pi-coding-agent` to **1.0.0**.
   That meets `pi-agent-browser-native`'s declared Pi `>= 1.0.0` floor (its
   devDependency pins `@earendil-works/pi-coding-agent@1.0.0`), so the
   extension's `defaultActive`/`namespace`/`outputSchema` features are
   supported. The 1.0.0 lockfile nests a different `@earendil-works` set than
   0.84.1 did, so `nix/pi-web-integrity.patch` was regenerated for the new
   entries (`chord`, `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`,
   `pi-telemetry`, `pi-tui`).
2. **Extension discovery** — pi-web's orchestrator discovers extensions from
   `PI_CODING_AGENT_DIR` (`~/.pi/agent/extensions/`). The nix-tmp
   `belayd-pi-web` home-manager module adds a fourth symlink next to the
   `belayd-*` ones:

   ```nix
   home.file.".pi/agent/extensions/pi-agent-browser".source = "${belaydPkgs.pi-agent-browser-extension}";
   ```

   That change lives in the separate nix-tmp repo; its reviewable record here is
   `nix/nix-tmp-belayd-pi-web.patch` (it is already applied in the local
   nix-tmp working tree).

## Status: wired, not live

**The end-to-end behavior does not work today.** Nothing in this branch has
been pushed, nix-tmp still locks the old flake, and no live `agent_browser` call
has been made in an orchestrator session:

| Piece | Where | State |
|-------|-------|-------|
| pi-web v1.202610.1 + embedded SDK 1.0.0 | `flake.nix`, `nix/pi-web-integrity.patch` | builds and verifiable now |
| `packages.${system}.pi-agent-browser-extension` export | `flake.nix` (bd-68) | builds now |
| `~/.pi/agent/extensions/pi-agent-browser` symlink | nix-tmp `modules/core/belayd-pi-web.nix`, recorded in `nix/nix-tmp-belayd-pi-web.patch` | in the working tree only |
| belayd flake pushed to GitHub | `github:Lewenhaupt/agent-harness` | **not pushed** |
| nix-tmp `flake.lock` belayd rev | nix-tmp (currently `f84a227…`, pre-bd-68) | **not bumped** |
| `nixos-rebuild` + service restart | host | **not done** |
| live `agent_browser` navigate/screenshot in an orchestrator session | host | **unverified** |

Prerequisite chain (each step is a hard gate on the next):

1. commit + push the belayd flake (bd-68 / bd-81 / bd-83);
2. in nix-tmp: `nix flake update belayd` (or `nix flake lock --update-input belayd`);
3. `sudo nixos-rebuild switch --flake .` + `sudo systemctl restart pi-web pi-web-sessiond`;
4. verify `readlink -f ~/.pi/agent/extensions/pi-agent-browser` and a real
   `agent_browser` navigate/screenshot in an orchestrator session.

## How to Verify

Run steps 1–5 from this repository root, in the project devShell
(`direnv exec . bash`, or wrap each command in `nix develop -c bash -c '<cmd>'`).
They need no push, no rebuild, and no sudo. Step 6 proves the *current* blocked
state. Steps 7–10 are the only ones that prove the live orchestrator behavior,
and they require the push + lock bump + rebuild + restart chain above.

### A. Runnable now (pre-rebuild)

1. **Confirm the pi-web pin and that upstream really resolves the SDK to
   1.0.0.** The cheap, no-build check reads the pinned tag's lockfile directly:

   ```bash
   nix eval --raw .#pi-web.version
   # 1.202610.1

   curl -sL https://raw.githubusercontent.com/jmfederico/pi-web/3f5f39eb988810b468f486e4334f10adcdb96b21/package-lock.json \
     | jq -r '.packages["node_modules/@earendil-works/pi-coding-agent"].version'
   # 1.0.0
   ```

   If the second command needs to compile anything you are offline — skip to
   step 2, which checks the SDK actually shipped in the build.

2. **Build pi-web and read the SDK version out of the output.** This is the
   authoritative check: it exercises the new `npmDepsHash`, the regenerated
   `nix/pi-web-integrity.patch`, and the npm install, then inspects the tree the
   service will run:

   ```bash
   piweb=$(nix build .#pi-web --no-link --print-out-paths)
   echo "$piweb"
   # /nix/store/<hash>-pi-web-1.202610.1

   jq -r .version "$piweb/lib/node_modules/pi-web/node_modules/@earendil-works/pi-coding-agent/package.json"
   # 1.0.0
   ```

   Expected: `1.202610.1` in the store path name and `1.0.0` from `jq`. A
   missing-integrity failure from `prefetch-npm-deps` means the patch no longer
   covers every nested `@earendil-works` dep; a `hash mismatch` on
   `npmDepsHash` means the lockfile or patch changed.

3. **Confirm the extension artifact the symlink will point at.** The
   `pi-agent-browser-extension` export is what nix-tmp references; it must exist
   and expose pi's discovery entry:

   ```bash
   nix eval .#pi-agent-browser-extension.drvPath
   ext=$(nix build .#pi-agent-browser-extension --no-link --print-out-paths)
   ls -l "$ext"
   jq -r '.pi.extensions[]' "$ext/package.json"
   readlink -f "$ext/dist/extensions/agent-browser/index.js"
   ```

   Expected: a `.drv` path, then a directory of symlinks (`package.json`,
   `dist`, `scripts`, `node_modules`) into the `pi-extensions` store path, then
   exactly `./dist/extensions/agent-browser/index.js`, and that file resolving
   to an existing store path. pi's discovery reads this `package.json` from the
   directory root, so this is the entry the orchestrator loads.

4. **Confirm the nix-tmp side matches the recorded patch.** The nix-tmp repo is
   separate; only the patch is tracked here. Set `<this-repo>` to the absolute
   path of this checkout (for example `/home/hugo/git/belayd-agent-harness`).

   ```bash
   cd ~/git/nix-tmp
   grep -n 'pi-agent-browser' modules/core/belayd-pi-web.nix

   # exit 0 means the working tree already contains the change (today's state)
   git apply --check --reverse \
     <this-repo>/nix/nix-tmp-belayd-pi-web.patch

   # on a tree without it, the forward check must also succeed
   git apply --check \
     <this-repo>/nix/nix-tmp-belayd-pi-web.patch
   ```

   Expected: the `grep` prints the
   `home.file.".pi/agent/extensions/pi-agent-browser".source = …` line, and
   `git apply --check --reverse` exits 0. On a clean nix-tmp checkout, use the
   forward `git apply --check` instead — `nixos-rebuild` needs the file content,
   not the patch, so apply it (`git apply …`) if it is absent.

5. **Run the regression guard.** `src/__tests__/flake-agent-browser.test.ts`
   pins the tag + rev, asserts every nested 1.0.0 `@earendil-works` dep has an
   added `integrity` line, and asserts the nix-tmp patch still records the
   symlink:

   ```bash
   pnpm vitest run src/__tests__/flake-agent-browser.test.ts
   # 1 passed (1) file / 10 passed (10) tests
   ```

   A future pi-web bump must update `flake.nix` and this test in lockstep; a
   new nested `@earendil-works` dep without an `integrity` line fails here
   rather than at `prefetch-npm-deps` time.

### B. Expected failure until the chain lands

6. **Watch the rebuild fail for the documented reason.** nix-tmp's `flake.lock`
   still pins `belayd` at `f84a2274be9f7815928d5b2dfaef083bd7e97d74`, which
   predates the `pi-agent-browser-extension` export, so evaluating the NixOS
   config fails on the new symlink:

   ```bash
   cd ~/git/nix-tmp
   nix flake metadata --json | jq -r '.locks.nodes.belayd.locked.rev'
   # f84a2274be9f7815928d5b2dfaef083bd7e97d74  (pre-bd-68)

   nix eval --raw .#nixosConfigurations.desktop.config.system.build.toplevel.drvPath
   # error: attribute 'pi-agent-browser-extension' missing
   #   at .../modules/core/belayd-pi-web.nix:57:67
   ```

   Same failure against the pinned rev directly, without evaluating the host
   config:

   ```bash
   nix eval --raw github:Lewenhaupt/agent-harness/f84a2274be9f7815928d5b2dfaef083bd7e97d74#pi-agent-browser-extension.drvPath
   # error: flake 'github:…' does not provide attribute '…pi-agent-browser-extension.drvPath'
   ```

   Do **not** treat this as a bug in bd-83: it is the missing
   `nix flake update belayd` step. It stops once step 7 lands.

### C. Post-rebuild live verification

7. **Bump nix-tmp's belayd input** (only valid after the belayd flake is pushed
   to `github:Lewenhaupt/agent-harness`):

   ```bash
   cd ~/git/nix-tmp
   nix flake update belayd          # older Nix: nix flake lock --update-input belayd
   nix flake metadata --json | jq -r '.locks.nodes.belayd.locked.rev'
   # a rev past bd-68/bd-83, no longer f84a227…
   ```

8. **Rebuild, restart, and confirm the symlink + running SDK.** Rebuild first,
   then restart: `pi-web-sessiond` loads the extension module graph once at
   startup, so a stale daemon keeps the old extensions (see
   [pi-web-service.md](pi-web-service.md#extension-loading-rebuild--restart)).

   ```bash
   sudo nixos-rebuild switch --flake .   # in ~/git/nix-tmp
   sudo systemctl restart pi-web pi-web-sessiond
   systemctl status pi-web pi-web-sessiond

   readlink -f ~/.pi/agent/extensions/pi-agent-browser
   # /nix/store/<hash>-pi-agent-browser-extension

   jq -r '.pi.extensions[]' ~/.pi/agent/extensions/pi-agent-browser/package.json
   # ./dist/extensions/agent-browser/index.js

   test -f ~/.pi/agent/extensions/pi-agent-browser/dist/extensions/agent-browser/index.js \
     && echo entry-ok

   piweb=$(systemctl show --value -p ExecStart pi-web \
     | grep -oE '/nix/store/[a-z0-9]+-pi-web-[^/ ]+' | head -1)
   echo "$piweb"   # /nix/store/<hash>-pi-web-1.202610.1
   jq -r .version "$piweb/lib/node_modules/pi-web/node_modules/@earendil-works/pi-coding-agent/package.json"
   # 1.0.0
   ```

   Expected: four symlinks under `~/.pi/agent/extensions/` (`belayd-*` plus
   `pi-agent-browser`), `readlink -f` resolving into a
   `…-pi-agent-browser-extension` store path, `entry-ok`, and the running unit's
   store path ending in `-pi-web-1.202610.1` with SDK version `1.0.0`. If the
   symlink is missing, home-manager did not switch or the rebuild came from a
   stale generation; if the version is still `0.84.1`, the daemon is running a
   pre-rebuild closure.

9. **Watch the daemon while it loads extensions.** Keep this running in a second
   terminal and then start a session:

   ```bash
   journalctl -u pi-web-sessiond -f
   ```

   Expected: session start with no extension-load error for
   `pi-agent-browser` (a failed load or an ignored extension shows up here). The
   harness's own registration line is the
   `[belayd-harness] registering tools/commands from file:///nix/store/…` log —
   useful to confirm you are on the rebuilt daemon at all.

10. **End-to-end: call `agent_browser` from an orchestrator session.** Open the
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

    - a real tool call named `agent_browser` in the session (before bd-83 the
      orchestrator had no such tool, so it either reported an unknown tool or
      fell back to `bash` + `curl`);
    - the navigation result echoing the `data:text/html` URL, exit status 0;
    - the screenshot written to an existing file (`ls -l /tmp/bd83-live.png`);
    - **no** `agent-browser not found`, no
      `Chromium distribution 'chrome' is not found`, no missing-shared-library
      error.

    This uses the session's model, so it consumes model quota. The raw-CLI
    fallback (`nix develop -c agent-browser open "data:text/html,<h1>ok</h1>"`)
    only proves the browser engine, not the orchestrator wiring.

### Failure modes after rebuild

| Symptom in an orchestrator session | Likely cause | Check |
|------------------------------------|--------------|-------|
| `agent_browser` unknown / not offered | extension not discovered, or daemon not restarted | `readlink -f ~/.pi/agent/extensions/pi-agent-browser`, then `sudo systemctl restart pi-web pi-web-sessiond` |
| Extension ignored / SDK feature errors (`defaultActive`, `namespace`, `outputSchema`) | daemon still on the old pi-web (SDK 0.84.1) | `systemctl show -p ExecStart pi-web` and the `jq` SDK check in step 8 |
| `agent-browser not found` | CLI not on the session `PATH` | `agent-browser` must come from `pi-web-runtime-env`; see [agent-browser-tool.md](agent-browser-tool.md) steps 1–2 |
| Chromium launch / shared-library errors | bundled chromium not wired | `AGENT_BROWSER_EXECUTABLE_PATH` is set by the Nix wrapper; re-check the runtime env build |
| Node engine warning (`pi-agent-browser-native` wants Node `>= 24.21.0`) | version divergence, tracked in bd-82, non-fatal today | `node --version` vs the extension's `engines.node` |

## How to Use

Once step 7–10 pass, the tool behaves in a pi-web orchestrator session exactly
as it does in the configured `pi`; nothing needs installing by hand (the
extension is Nix-managed, no `pi install`). Ask in natural language:

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
  `belayd-implementer`, `belayd-tester`, and `belayd-proof-generator`
  sub-agents keep it via their existing allowlists (`src/agent-registry.ts`).
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
- [docs/pi-web-service.md](pi-web-service.md) — the systemd services, the
  `pi-web-runtime-env` `PATH`, and why a restart is required after a rebuild.
- [docs/playwright-proof-env.md](playwright-proof-env.md) — the other browser
  stack (`playwright`, `playwright-cli`) available to pi-web sessions.
