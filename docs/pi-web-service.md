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
