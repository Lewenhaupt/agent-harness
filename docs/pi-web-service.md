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
- `SHELL`, `LD_LIBRARY_PATH`, `SSL_CERT_FILE`, `NIX_SSL_CERT_FILE` mirror the
  devShell.

`pi-web.service` (`pi-web-server`) is `After=`/`Wants=`
`pi-web-sessiond.service`. The referenced `/nix/store` paths are part of the
system closure, so they are GC-rooted automatically — no manual GC roots.

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
