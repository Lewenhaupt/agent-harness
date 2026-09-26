# pi-web systemd system services (NixOS module)

pi-web (browser UI + session daemon) runs as two systemd **system** services,
declared by the flake's `nixosModules.pi-web`. There is no Docker container and
no imperative installer: this host's NixOS has a read-only `/etc`
(`/etc/systemd/system` is a symlink into the nix store), so systemd system
units must be materialised by `nixos-rebuild`.

## Why a module

pi-web used to run as an arion container. pi processes spawned inside that
container had no Nix, so `nix develop`/direnv could not work in sessions — and
a container image cannot carry Nix itself. A native service runs on the host
with Nix and the devShell tools on PATH, which is what agent sessions need. The
earlier imperative `nix run .#install-pi-web` approach was dropped because
read-only `/etc` forbids writing `/etc/systemd/system`.

## Enable

```nix
# in your NixOS configuration
imports = [ belayd.nixosModules.pi-web ];

services.belayd-pi-web = {
  enable = true;
  user = "alice";    # runs the services, owns ~/.pi-web, git config, signing key
  # host = "0.0.0.0"; # PI_WEB_HOST (default)
  # port = 8504;      # PI_WEB_PORT (default)
  # dataDir = null;   # PI_WEB_DATA_DIR; defaults to <home>/.pi-web
  # devShellWhitelistPrefixes = [ "/home/alice/git" ];  # direnv.toml whitelist
};
```

Then `nixos-rebuild switch`.

Both units are `WantedBy=multi-user.target`, so they start at boot and survive
SSH logout — no login, linger, or SSH agent involved.

## Environment

Both units run as `user` with an explicit environment:

- `PATH` = `pi-web-runtime-env` (a `buildEnv` of `nix`, `direnv`, `git`,
  `openssh`, and the flake's `devShellTools`: pnpm, node, `bd`, `dolt`, `wt`,
  `pi`, …) plus `/run/current-system/sw/bin` and `~/.nix-profile/bin`. This is
  the fix: spawned pi processes can run `nix develop`/direnv.
- `HOME`/`XDG_*` point at the user's home, so agents see the same git config,
  SSH keys, `~/.pi`, and `~/.direnv` as interactive use.
- `PI_WEB_DATA_DIR=~/.pi-web` and
  `PI_WEB_SESSIOND_SOCKET=~/.pi-web/sessiond.sock` — the same host state the
  old arion container bind-mounted, so no migration.
- `PI_CODING_AGENT_DIR=~/.pi/agent` (the pi SDK default).
- `SHELL=belayd-shell` (the wrapper below), `LD_LIBRARY_PATH`, `SSL_CERT_FILE`,
  `NIX_SSL_CERT_FILE` mirror the devShell.

### devShell routing (`SHELL` + `shellPath`)

Both units set `SHELL` to `belayd-shell`, a cwd-aware wrapper (built by the
flake's `belayd-shell`) that resolves the project devShell from `$PWD`:

- It walks up from `$PWD` to the first `.envrc`, `flake.nix`, or `shell.nix`.
  A `.pi/no-devshell` marker stops the walk and forces pass-through.
- `.envrc` → direnv applies the `.envrc` environment (`direnv export
  bash`, then `eval`) and the wrapper `exec`s `<real-shell>` directly;
  `flake.nix` → `nix develop <root> -c <real-shell> …`; `shell.nix`-only →
  `nix-shell`.
- A blocked or denied `.envrc` fails the command; the flake path is never used
  as a silent fallback.
- No marker anywhere → `exec <real-shell> …`, a strict pass-through with no
  output and no env mutation, so repos without a devShell behave exactly as
  before and `pi-web-runtime-env` tools (`bd`, `dolt`, `wt`, `pnpm`, `node`)
  stay on `PATH`.
- `BELAYD_SHELL_ACTIVE` guards recursion: a process already inside a devShell
  gets the ambient shell. A consequence is that a process already inside one
  repo's devShell does **not** switch to another repo's devShell.

`-c`, `-lc`, `-l`, and no-arg invocations are forwarded verbatim, so the agent
`bash` tool, plugin `runCommand`, and interactive terminals all behave
correctly (interactive terminals stay login shells). The direnv entry path and
`nix develop -c` both preserve the caller's cwd, verified from a subdirectory,
so relative paths keep working.

The same wrapper is installed as the global `shellPath` in
`~/.pi/agent/settings.json`, which is what makes the agent `bash` tool and
spawned sub-agents (bd-47) resolve the same devShell. `pi-web-sessiond`'s
`ExecStartPre` merges that key idempotently (and provisions the direnv
whitelist below); the interactive `pi` wrapper does the same merge on launch.
Both merges are non-strict: a corrupt `settings.json`/`direnv.toml` warns and
exits 0 rather than blocking the unit, and unrelated keys are never touched.

#### direnv whitelist (arbitrary-code-execution caveat)

When a repo has an `.envrc`, the wrapper requires direnv to have allowed it.
`ExecStartPre` ensures `~/.config/direnv/direnv.toml` has a `[whitelist]
prefix` array containing `devShellWhitelistPrefixes` (default `<home>/git`).
A whitelisted prefix makes direnv trust **every** `.envrc` beneath it
*content-independently* — i.e. an arbitrary-code-execution grant for anything
a collaborator with VCS write access can commit. Keep the list as narrow as
possible (point it at a single repo instead of `~/git`) and use `direnv deny`
for exceptions, which still overrides the whitelist. A blocked/denied `.envrc`
fails the command loudly with the `direnv allow <root>` instruction — the
wrapper never silently bypasses direnv when an `.envrc` exists.

`pi-web.service` (`pi-web-server`) is `After=`/`Wants=`
`pi-web-sessiond.service`. The referenced `/nix/store` paths are part of the
system closure, so they are GC-rooted automatically — no manual GC roots.

## How to verify devShell routing

The wiring lives in systemd and in `~/.pi/agent/settings.json`, so it only takes
effect after a rebuild and a restart:

```bash
cd ~/git/belayd-agent-harness
sudo nixos-rebuild switch
sudo systemctl restart pi-web pi-web-sessiond
```

> Restarting `pi-web`/`pi-web-sessiond` kills every in-flight session and
> terminal. Never restart while work is in flight; drain first.

### 1. Automated gates

```bash
cd ~/git/belayd-agent-harness
pnpm install
pnpm test              # wrapper, setup helpers, spawn env stripping (unit)
pnpm test:integration  # real direnv/nix: loads .envrc, resolves nix develop
pnpm typecheck && pnpm lint && pnpm build
```

Expected: all pass. Integration cases self-skip with a `Skipping integration
test:` warning when `direnv`, `nix`, or `jq` is missing — a skip is not a pass.

### 2. Wiring (inspect without touching the running system)

```bash
readlink -f ~/.pi/agent/settings.json
jq -r '.shellPath' ~/.pi/agent/settings.json
# → /nix/store/<hash>-belayd-shell/bin/belayd-shell

# both units export the wrapper as SHELL
systemctl show pi-web -p Environment | tr ' ' '\n' | grep '^SHELL='
systemctl show pi-web-sessiond -p Environment | tr ' ' '\n' | grep '^SHELL='
# → SHELL=/nix/store/<hash>-belayd-shell/bin/belayd-shell

# direnv whitelist provisioned by ExecStartPre
grep -A3 '^\[whitelist\]' ~/.config/direnv/direnv.toml
# → prefix = ["/home/hugo/git"]

# set-up helpers are silent when healthy; their warnings/errors appear here
# (a bare `grep belayd` also matches belayd-harness registration lines)
journalctl -u pi-web-sessiond | grep -E 'belayd-(shell-path-setup|direnv-setup)'
```

`<hash>` is whatever `readlink -f` printed. If `settings.json` is missing,
corrupt, or a symlink, `belayd-shell-path-setup` warns under the
`belayd-shell-path-setup:` prefix and exits 0 (non-strict: a broken user config
never blocks the unit). Fix the file, then restart `pi-web-sessiond`.

### 3. Idempotent settings merge

```bash
stat -c '%y %a' ~/.pi/agent/settings.json
sudo systemctl restart pi-web-sessiond
stat -c '%y %a' ~/.pi/agent/settings.json   # identical mtime and mode
jq 'keys' ~/.pi/agent/settings.json          # unrelated keys preserved
```

A second run rewrites nothing (the helper compares `shellPath` first). To test
the merge on a scratch copy instead of the live file:

```bash
cp ~/.pi/agent/settings.json /tmp/probe-settings.json
/nix/store/<hash>-belayd-shell/bin/belayd-shell-path-setup \
  --settings /tmp/probe-settings.json --strict
diff <(jq -S . ~/.pi/agent/settings.json) <(jq -S . /tmp/probe-settings.json)
```

### 4. devShell-only tool resolution

Create a probe repo whose devShell provides a tool that is *not* in the ambient
`pi-web-runtime-env` (call it `belayd-devshell-only-tool`):

```bash
rm -rf ~/git/belayd-shell-probe
mkdir -p ~/git/belayd-shell-probe
cd ~/git/belayd-shell-probe
cp ~/git/belayd-agent-harness/flake.lock .
cat > flake.nix <<'EOF'
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";   # `uname -m` if different
      pkgs = import nixpkgs { inherit system; };
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          (pkgs.writeShellScriptBin "belayd-devshell-only-tool" "echo devshell-only")
        ];
      };
    };
}
EOF
nix develop -c command -v belayd-devshell-only-tool   # warm the flake
```

Then exercise each channel from this directory:

- **Wrapper directly** (all channels ultimately exec it):
  ```bash
  /nix/store/<hash>-belayd-shell/bin/belayd-shell -c \
    'command -v belayd-devshell-only-tool'
  ```
- **(a) agent `bash` tool** — open a pi-web session with this repo as the
  workspace and ask the agent to run
  `command -v belayd-devshell-only-tool`. It resolves via the global
  `shellPath`.
- **(b) pi-web terminal** — open the terminal in that session and run the same
  command. It resolves via the daemon's `SHELL`.
- **(c) plugin `runCommand`** — open the Proof of Work panel, select a
  `.trace.zip`, and click **Open in Trace Viewer**. That button calls
  `context.terminal.runCommand` (`pi-web-plugins/proof-of-work/panel.js`), which
  creates a workspace terminal. In that terminal run
  `command -v belayd-devshell-only-tool` (and `echo "$SHELL"`): it resolves the
  probe devShell's tool, proving the plugin-spawned command shares the workspace
  `SHELL` and cwd.

Expected in every channel: a `/nix/store/<hash>-belayd-devshell-only-tool/…`
path and no `direnv:`/`nix` banner noise.

### 5. Pass-through and ambient tools

```bash
cd /tmp
/nix/store/<hash>-belayd-shell/bin/belayd-shell -c \
  'command -v bd dolt wt pnpm node'
```

Expected: no devShell is entered, `bd`/`dolt`/`wt`/`pnpm`/`node` all resolve
from `pi-web-runtime-env`, and stderr is empty. The same holds for a repo with a
`.pi/no-devshell` marker:

```bash
mkdir -p ~/git/belayd-shell-probe/.pi
touch ~/git/belayd-shell-probe/.pi/no-devshell
cd ~/git/belayd-shell-probe
/nix/store/<hash>-belayd-shell/bin/belayd-shell -c \
  'command -v belayd-devshell-only-tool || echo pass-through'
# → pass-through
rm -rf ~/git/belayd-shell-probe/.pi
```

### 6. Login-shell behaviour

Open a pi-web terminal in a repo, or run `belayd-shell -l` from a real TTY.
Confirm a prompt appears, arrow-key history works, Ctrl-C interrupts the
foreground command without killing the terminal, and it is a login shell:

```bash
/nix/store/<hash>-belayd-shell/bin/belayd-shell -lc \
  'shopt -q login_shell && echo login'
# → login
```

### 7. No recursion / no hang

```bash
cd ~/git/belayd-shell-probe
BELAYD_SHELL_ACTIVE=1 /nix/store/<hash>-belayd-shell/bin/belayd-shell -c 'echo guarded'
# → guarded, immediately, no devShell entry

/nix/store/<hash>-belayd-shell/bin/belayd-shell -c \
  '/nix/store/<hash>-belayd-shell/bin/belayd-shell -c "echo nested"'
# → nested, immediately: the guard short-circuits re-entry
```

If either blocks, the guard is not firing — inspect `BELAYD_SHELL_ACTIVE`
propagation.

### 8. Sub-agent inheritance

The harness spawns each sub-agent with `cwd` = its worktree and strips
`BELAYD_SHELL_ACTIVE` (`src/spawn.ts`), so a sub-agent in another repo resolves
*that* worktree's devShell. From pi-web, start a workflow/sub-agent whose
worktree includes the probe devShell and ask it to run
`command -v belayd-devshell-only-tool`; expect the devShell path and no hang.
The env-stripping is unit-tested in `src/__tests__/spawn.test.ts`.

### 9. Fail-loud direnv

A repo under the whitelist prefix is allowed without `direnv allow`; one
outside it must fail loud. Use `/home/hugo/git` (whitelisted) and `/tmp`
(not) to see both:

```bash
rm -rf ~/git/belayd-envrc-probe /tmp/belayd-envrc-outside
mkdir -p ~/git/belayd-envrc-probe /tmp/belayd-envrc-outside
printf 'export BELAYD_PROBE=ok\n' > ~/git/belayd-envrc-probe/.envrc
printf 'export BELAYD_PROBE=ok\n' > /tmp/belayd-envrc-outside/.envrc

cd /tmp/belayd-envrc-outside
/nix/store/<hash>-belayd-shell/bin/belayd-shell -c 'echo ran'
# → belayd-shell: .envrc at /tmp/belayd-envrc-outside is not allowed … Run:
#   direnv allow /tmp/belayd-envrc-outside     (exit 1, `ran` not printed)

cd ~/git/belayd-envrc-probe
/nix/store/<hash>-belayd-shell/bin/belayd-shell -c 'echo ran; echo "$BELAYD_PROBE"'
# → ran / ok   (whitelisted)

direnv deny ~/git/belayd-envrc-probe
/nix/store/<hash>-belayd-shell/bin/belayd-shell -c 'echo ran'
# → fails loud; deny overrides the whitelist
direnv allow ~/git/belayd-envrc-probe
```

A broken `.envrc` (non-zero exit) also fails loud with a `direnv export bash
exited N` message and no command is run.

Clean up the probes:

```bash
rm -rf /tmp/belayd-envrc-outside /tmp/probe-settings.json \
  ~/git/belayd-envrc-probe ~/git/belayd-shell-probe
```

## How to use devShell routing

### Mental model

One global config, resolved per-repo from `$PWD`. You do not configure anything
per repository: `belayd-shell` walks up from the current directory to the first
`.envrc`, `flake.nix`, or `shell.nix` and enters it. Everything pi-web runs —
terminals, plugin `runCommand`, workspace removal — plus the agent `bash` tool
and spawned sub-agents share this one wrapper.

### Opt a repo out

Create the marker at the repo root:

```bash
mkdir -p .pi
touch .pi/no-devshell
```

The walk stops there and the shell passes through even if an ancestor directory
carries a devShell marker. Remove the file to re-enable routing. Use it for
repos whose devShell is broken or unwanted.

### Narrow or extend the whitelist

The whitelist is provisioned by `pi-web-sessiond`'s `ExecStartPre` from
`services.belayd-pi-web.devShellWhitelistPrefixes` (default `[ "/home/hugo/git"
]`). Point it at a single repo to narrow it, or add trusted roots to extend it:

```nix
services.belayd-pi-web.devShellWhitelistPrefixes = [
  "/home/hugo/git/belayd-agent-harness"
];
```

Then rebuild and restart:

```bash
sudo nixos-rebuild switch
sudo systemctl restart pi-web pi-web-sessiond
```

The helper only *adds* missing prefixes; it never deletes an entry that is
already in `~/.config/direnv/direnv.toml`. Narrowing the option therefore does
not remove a broader prefix provisioned earlier — delete that prefix entry by
hand and restart.

### Arbitrary-code-execution caveat

A whitelisted prefix makes direnv trust every `.envrc` beneath it
*content-independently*. Anything a collaborator with VCS write access can
commit becomes code that runs on entry; there is no per-path or per-content
approval and edits do not invalidate trust. Only add trusted paths, and keep the
list as narrow as possible. `direnv deny` still overrides the whitelist, but the
whitelist itself performs no validation.

### Nested shells and the one-repo-per-process-tree rule

`BELAYD_SHELL_ACTIVE` prevents re-entry: once a process is inside a devShell,
any nested `belayd-shell` gets the ambient shell instead of switching to another
repo's devShell. A pi-web terminal opened in repo A and then `cd`-ing to repo B
keeps A's environment. Sub-agents are exempt because the harness strips the
marker when spawning them and sets `cwd` = their worktree (bd-47). To switch
repos, start a new pi-web terminal/agent from the target workspace rather than
nesting.

### Troubleshooting

- `belayd-shell: .envrc at <root> is not allowed … Run: direnv allow <root>` —
  run `direnv allow <root>` as the same user (`hugo`), or cover `<root>` with
  `devShellWhitelistPrefixes`.
- `direnv deny` wins over the whitelist. Check the effective state with
  `cd <root> && direnv status --json | jq .state.foundRC.allowed` (`0` allowed,
  `1` blocked, `2` denied). `direnv allow <root>` re-allows.
- `no readable state (foundRC is null)` — the `.envrc` is not readable by the
  service user.
- Other fail-loud messages: `direnv is not on PATH`, `nix is not on PATH`,
  `nix-shell is not on PATH`, and `failed to load <root>/.envrc (direnv export
  bash exited N)` for a broken `.envrc`.

### Debug overrides

```bash
BELAYD_REAL_SHELL="$(command -v bash)" \
  /nix/store/<hash>-belayd-shell/bin/belayd-shell -c 'echo "$SHELL"'
```

- `BELAYD_REAL_SHELL` — absolute path to the shell the wrapper execs, instead of
  the shell baked in at build time.
- `BELAYD_JQ` — path to the `jq` used to read `direnv status --json`.
- `BELAYD_SHELL_ACTIVE=1` — force the no-recursion short-circuit (pass-through)
  without entering a devShell.

## Extension loading: rebuild → restart

pi-web sessions run **in-process** inside `pi-web-sessiond` — the daemon loads
pi's extension modules once at startup and keeps that module graph for its
whole lifetime. `nixos-rebuild switch` (or `home-manager switch`) only replaces
files on disk; a running daemon keeps the old extensions until restarted. That
includes the belayd harness (`~/.pi/agent/extensions/belayd-harness.ts` and its
`src/` tree), so any change to `extensions/` or `src/` needs:

```bash
sudo systemctl restart pi-web pi-web-sessiond
```

before it takes effect in pi-web sessions. (The interactive `bin/pi` dev
wrapper is unaffected — it reloads extensions on every launch.)

### How the belayd harness dedupes duplicate copies

The harness ships in two places that can load together: globally
(`~/.pi/agent/extensions/belayd-harness.ts`) and project-locally (a
`.pi/settings.json` `packages` entry). Registering the same `belayd_*` tools
twice is reported as `Tool "belayd_*" conflicts with ...`. Dedup must be scoped
to a single load batch, not the whole process:

- pi's extension factory cannot read registration state — `pi.getAllTools()`
  and `pi.getCommands()` throw `"Extension runtime not initialized"` until
  `Runner.bindCore()` runs *after* all extensions load.
- The harness instead claims on the batch's shared event bus (`pi.events`):
  the first copy leaves a probe listener and later copies in the same batch
  detect it with a synchronous emit. Separate batches (the provider-bootstrap
  pass and each session) get fresh buses, so each session registers again.

A process-wide marker was tried and broke this: the daemon first runs a
"provider bootstrap" pass (`global extension provider baseline bootstrapped and
frozen` in the logs) with a scratch cwd, which set the marker once; every real
session then saw the stale flag and registered nothing — `/belayd` and every
`belayd_*` tool disappeared.

### Detecting a stale build

The harness logs its own path when it registers:

```bash
journalctl -u pi-web-sessiond | grep "belayd-harness.*registering"
# [belayd-harness] registering tools/commands from file:///nix/store/<hash>-belayd-harness/extensions/index.ts
```

Compare the `<hash>` against the current symlink target:

```bash
readlink -f ~/.pi/agent/extensions/belayd-harness.ts
```

If they differ, the daemon is still running a pre-rebuild copy — restart it.

## Git commit signing

The service has no SSH agent socket, so agents sign commits with the on-disk
key at `~/.ssh/git-signing` (provisioned via sops in the NixOS config; the
public half is `~/.ssh/git-signing.pub`). Signing works because `ssh-keygen`
(openssh) and git are on the service PATH and `HOME` points at the user's home.

## Manage

```bash
systemctl status pi-web pi-web-sessiond
journalctl -u pi-web -f
journalctl -u pi-web-sessiond -f
sudo systemctl restart pi-web pi-web-sessiond
```

## Remove

Set `services.belayd-pi-web.enable = false;` and `nixos-rebuild switch`.
