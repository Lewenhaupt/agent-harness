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
   points. `bin/pi`, `flake.nix` and the project settings file all read it;
   nothing else may list them. `.pi/settings.json` loads the repo as one package
   (`{"packages": [{"source": ".."}]}`) rather than six raw file paths, because
   raw path arrays are concatenated and never deduped while a package has an
   identity (its resolved absolute path).
2. **`nix/pi-extensions/package.json` → `piExtensions` / `piWebDirs`** —
   third-party extensions as `package name → entry path inside that package`,
   plus `package name → directory name under ~/.pi/agent/extensions/`. The same
   file already owns the npm dependency specs, so the entry path lives next to
   the version it belongs to, and the directory name next to the path it has to
   mirror.

Adding an extension is therefore a one-file change:

- harness extension: create `extensions/<name>.ts` and add it to
  `package.json` `pi.extensions` (a test enforces that the two agree);
- third-party extension: add the dependency **and** the `piExtensions` entry
  (and its `piWebDirs` name) to `nix/pi-extensions/package.json`, then
  `pnpm install` + `nix build .#pi-extensions` for the new `npmDepsHash`.

`bin/pi` no longer hardcodes an `-e` list and no longer fetches
`npm:pi-agent-browser-native@0.9.2` at startup (that fetch silently produced a
smaller tool set under `PI_OFFLINE=1`). It resolves entry points from
`$BELAYD_PI_EXTENSIONS_DIR`, the Nix-built node_modules tree exported by the
devShell and by the pi-web runtime environment; outside the devShell it falls
back to the manifest's npm specs and warns.

The third-party list is therefore also where the provider extensions live:
`@robhowley/pi-openrouter` and `pi-commandcode-provider` register the
`openrouter` and `commandcode` providers (pi ships neither). Command Code's key
precedence, model ids and plan-gating behaviour are documented in
`docs/commandcode-provider.md`.

## The directory form: `-e` is not enough

The two consumers take extension lists differently, and only one of them takes
`-e`:

| Consumer | Gets extensions from |
|---|---|
| `pi` binary, spawned sub-agents | the `-e` list derived from the manifests (it runs `-ne`) |
| pi-web orchestrator | discovery of `$PI_CODING_AGENT_DIR/extensions/<name>/package.json` `pi.extensions` |

So every manifest entry needs both forms. `flake.nix` builds them from the same
manifest:

- `packages.<system>.pi-extension-<dirName>` — a store dir per package, holding
  symlinks to the package's top-level entries plus a `node_modules` link into
  the pi-extensions tree (so a loader that follows the symlink still resolves
  the entry's runtime deps);
- `legacyPackages.<system>.pi-web-extension-dirs` — the set pi-web needs, keyed
  by directory name: one artifact per third-party extension plus
  `belayd-harness` (whose own `package.json` carries the harness entry list).
  It is a set, not a derivation, hence `legacyPackages`.

The nix-tmp `belayd-pi-web` home-manager module turns that set into symlinks
(`home.file = { skills } // lib.mapAttrs' …`; the delta is recorded in
`nix/nix-tmp-belayd-pi-web.patch`). `piWebDirFor` in `flake.nix` throws at
**evaluation** time when a `piExtensions` entry has no `piWebDirs` name, so a
new dependency cannot silently stay terminal-only — the failure mode bd-205
fixed, where bd-178's `commandcode` provider had 95 selectable models in a
terminal and 0 in pi-web.

Provider registrations additionally need a **daemon restart**: pi-web freezes
the provider registry when `pi-web-sessiond` starts and logs
`PROVIDER_MUTATION_IGNORED` (`reason: not-in-startup-baseline`) for anything
registered later. `/reload` and a web/API restart do not rebuild it. Tools-only
extensions (exa, ast-grep, vision, plannotator, agent-browser) are picked up by
the next session with no restart.

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

## Per-role tool surfaces (bd-133)

Every declared tool is sent on every request, and a bigger catalog measurably
hurts tool choice — DeepSeek's own scaffold benchmark on identical weights puts
a ~12-tool minimal scaffold above a full-featured one, and Anthropic's
tool-search guidance puts the deferral threshold near 10 tools / 10k tokens of
definitions. `src/role-tools.ts` therefore computes each role's surface instead
of declaring one flat list:

| Set | Contents |
|---|---|
| `WORKFLOW_CONTROL_TOOLS` | start-followup, stack-rebase, stop-task, status, doctor, proof-verifier, `bd`, read/grep/find/ls |
| `MEMBER_FLEET_TOOLS` | `fleet_status`, `fleet_inbox`, `fleet_note` — a gated member must be able to see a pause and answer it |
| `SUPERVISOR_FLEET_TOOLS` | launch, merge, pause, resume, advance, reconcile — **not** declared under a gate; the supervisor session arms no gate |
| `CONSULT_TOOLS` | `belayd_outline`, `belayd_archify`, `belayd_unslop` — callable, never a required step |
| `PLANNING_TOOL_SET` | read-only investigation + `bd` + planning sub-agents; no edit/write/bash/browser |

A gated session declares its own workflow's phase tools (required + consult) plus
the control, member-fleet, and consult sets. That drops the surface from 35 tools
to at most 26, and removes phase tools the workflow never runs (a bugfix session
is not offered `belayd_userguide`) plus `belayd_documenter`, which no phase order
contains.

`src/__tests__/role-tools.test.ts` pins the contents, the "no edit/write/bash
under a gate" rule, and a budget bound; `src/__tests__/tool-contract.test.ts`
fails when an agent allowlist or a role set names a tool that no build registers,
when a registered `belayd_*` tool is missing from `HARNESS_TOOL_NAMES` (the list
`belayd_doctor` audits against), and when an agent may call a `belayd_*` tool that
no workflow gate leaves active (bd-253: `belayd_unslop` was registered and
allowlisted but refused under the gate until it joined `CONSULT_TOOLS`).

## Load order caveat

pi loads user-scope extensions before project-scope ones, and the harness
extension factories self-dedupe on a process-wide marker — so when the NixOS
config also installs the harness at `~/.pi/agent/extensions/belayd-harness.ts`,
**that copy wins and the worktree's `extensions/` is not the code that runs**.
This is why the dev loop goes through `bin/pi` (`-ne` plus explicit `-e` paths to
the worktree). A pi-web orchestrator session inherits the same rule: it runs
whatever copy loaded first, which is normally the Nix-built one. Verified with a
clean `PI_CODING_AGENT_DIR` (no user extensions): the project package alone
declares all 30 harness tools, so the package form itself is sound.

## Where a global install belongs (nix-tmp)

The NixOS home-manager module (`nix-tmp/modules/core/belayd-pi-web.nix`) installs
the harness for pi-web's embedded orchestrator. Point it at the **package
directory**, not at individual files:

```nix
home.file.".pi/agent/extensions/belayd-harness".source = "${belaydPkgs.belayd-harness}";
```

That replaces three loose `.ts` symlinks plus the `~/.pi/agent/src` symlink: the
store path carries `extensions/`, `src/` and `node_modules/`, so the extensions'
`../src` imports resolve inside it, and `package.json` supplies the entry list.

**Ordering matters.** pi does not descend into `extensions/<dir>/` looking for
loose files, so the manifest must already be in the store path when the symlink
changes: push the harness, bump `agent-harness` in nix-tmp's `flake.lock`, then
rebuild. Probes that establish this:

| Layout | Result |
|---|---|
| `extensions/belayd-harness -> <store>` **without** `package.json` | 0 harness tools |
| same symlink **with** `package.json` | 30 harness tools, loaded via the symlink |
| `packages: [{ source = "<store>", skills = [] }]` in settings | 30 harness tools |

Pass `"skills": []` when using the settings form: the copied manifest declares
`pi.skills`, but the derivation does not install `.agents/`, and skills stay
owned by the `~/.agents/skills` symlinks that `belayd-skills` provides.
