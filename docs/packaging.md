# pi packaging: one manifest, explicit binaries

Three consumers run this harness and they used to disagree about which
extensions — and therefore which tools — a session gets. This page records the
contract, the two manifests that define it, and how to verify a session got what
it should.

## The three consumers

| Consumer | How it runs | Extension source |
|---|---|---|
| pi-web orchestrator | pi-web's **bundled pi SDK, in-process** ("PI WEB runs sessions on the bundled pi SDK only") | pi discovery: `~/.pi/agent/extensions/`, the global settings `packages` array, and the project `.pi/settings.json` |
| spawned sub-agents | a `pi` **process** started by `src/spawn.ts` | whatever binary `src/pi-binary.ts` resolves; the Nix wrapper bakes the extension list in and runs with `-ne` |
| repo dev loop | `bin/pi` | derived from the two manifests below, resolved against `$BELAYD_PI_EXTENSIONS_DIR` |

The orchestrator cannot be the Nix wrapper (it is not a child process), so its
tool set is discovery-driven. That is a known split; `belayd_doctor` reports it
rather than hiding it.

## The two manifests

1. **`package.json` → `pi.extensions` / `pi.skills`** — the harness's own entry
   points. `bin/pi` and `flake.nix` both read it; nothing else may list them.
2. **`nix/pi-extensions/package.json` → `piExtensions`** — third-party
   extensions as `package name → entry path inside that package`. The same file
   already owns the npm dependency specs, so the entry path lives next to the
   version it belongs to.

Adding an extension is therefore a one-file change:

- harness extension: create `extensions/<name>.ts` and add it to
  `package.json` `pi.extensions` (a test enforces that the two agree);
- third-party extension: add the dependency **and** the `piExtensions` entry to
  `nix/pi-extensions/package.json`.

`bin/pi` no longer hardcodes an `-e` list and no longer fetches
`npm:pi-agent-browser-native@0.9.2` at startup (that fetch silently produced a
smaller tool set under `PI_OFFLINE=1`). It resolves entry points from
`$BELAYD_PI_EXTENSIONS_DIR`, the Nix-built node_modules tree exported by the
devShell and by the pi-web runtime environment; outside the devShell it falls
back to the manifest's npm specs and warns.

## Which pi binary a sub-agent gets

`src/pi-binary.ts` resolves in this order and reports provenance:

1. `BELAYD_PI_BINARY` (explicit override)
2. `PI_BINARY_PATH` (direnv shells point this at the repo wrapper)
3. `/run/current-system/sw/bin/pi` (the NixOS `belayd-pi` wrapper)
4. legacy install locations (`~/.npm-global/bin/pi`, `~/.local/bin/pi`, …)

If 3 or 4 wins, the harness logs one line naming the env var that would pin it,
because the binary decides the extension set: a sub-agent on the system wrapper
carries `exa`/`ast_grep`/`vision`/`plannotator`, while the same agent under a
bare pi does not. An empty `BELAYD_PI_BINARY=` counts as unset.

## Verify

```bash
# in a pi session, any role:
belayd_doctor
```

It prints the running pi install, the binary resolution for spawned agents (with
the fallback warning), the declared tool catalog with an estimated per-request
token cost grouped by source extension, and any agent allowlist entry that no
declared or external tool satisfies. A gap is reported as a gap only when the
session actually declares the harness surface; a `--tools`/gate-restricted
session is labelled as such instead of blaming every agent.

Checks that must stay green:

```bash
pnpm test                      # src/__tests__/pi-manifest.test.ts guards both manifests
nix build .#pi --no-link       # wrapper carries exactly the manifest's extensions
./bin/pi --version 2>&1 | head # dev loop resolves the same set from the store tree
```
