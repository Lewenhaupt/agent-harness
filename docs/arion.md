# Local scotty + portainer stack (arion)

`arion-compose.nix` defines a two-service local stack, autostarted by the
container engine's restart policy. pi-web is no longer a container — it runs
as a native systemd system service (see
[docs/pi-web-service.md](pi-web-service.md)).

| Service | Purpose | Host port | Container port |
|---------|---------|-----------|----------------|
| `scotty` | `bead-me-up-scotty` web UI for beads (`bd`) repos | `7687` | `7687` |
| `portainer` | Container management web UI | `9443` (HTTPS), `8000` (edge) | `9443`, `8000` |

The scotty image is built by Nix from the package in `flake.nix`
(`scotty-image`) and loaded with `docker load`; portainer is pulled from Docker
Hub. `arion-pkgs.nix` bootstraps arion with the same nixpkgs pinned in
`flake.lock`.

## Prerequisites

- A running Docker daemon. On NixOS:

  ```nix
  virtualisation.docker.enable = true;
  ```

  arion and the devShell cannot start the daemon themselves — start it with
  `systemctl start docker` (NixOS) or your distribution's equivalent first.
- Enter the devShell to get `arion`, `docker-compose` and `docker-client`:

  ```bash
  nix develop
  ```

> Podman works here: this host runs Podman behind a Docker-compatible socket
> (`/var/run/docker.sock` → `/run/podman/podman.sock`), which arion uses
> transparently. Portainer manages the same engine through that socket —
> Podman's Docker-compatible API covers most of what Portainer needs, but some
> Docker-only features may be unavailable.

## Usage

```bash
nix develop          # get arion + docker tooling
arion up -d          # build/load images, start all containers (autostart)
arion ps             # list services
arion logs -f        # follow logs (optionally: arion logs -f scotty)
arion down           # stop and remove containers + the arion network
```

The `restart = "unless-stopped"` setting is the autostart mechanism: Docker
restarts the containers when the daemon boots or the containers crash, until
you run `arion down`.

### Autostart via systemd (optional)

If you prefer explicit lifecycle management over Docker's restart policy, run
the stack from a oneshot service instead:

```nix
systemd.services.belayd-local-stack = {
  wantedBy = [ "multi-user.target" ];
  after = [ "docker.service" ];
  requires = [ "docker.service" ];
  path = [ config.virtualisation.docker.package pkgs.arion ];
  serviceConfig = {
    Type = "oneshot";
    RemainAfterExit = true;
    WorkingDirectory = "/path/to/belayd-agent-harness";
    # arion-compose.nix reads BELAYD_GID to run the containers as the host
    # user. The default is 1000; set it to your `id -g` (100 on this host) so
    # bind-mounted files get the right group ownership.
    Environment = "BELAYD_GID=100";
    ExecStart = "${pkgs.arion}/bin/arion up -d";
    ExecStop = "${pkgs.arion}/bin/arion down";
  };
};
```

## Ports and volumes

scotty shares state with the host via bind mounts, so settings and projects
persist across `arion down`/`arion up -d` and are shared with host-run scotty.
Portainer keeps its state in a named volume.

- **scotty** — host `:7687` (override with `SCOTTY_HOST_PORT`). Its config is
  bind-mounted from `~/.config/bead-me-up-scotty` to `/config/bead-me-up-scotty`
  (container `XDG_CONFIG_HOME` is `/config`).
- **portainer** — host `:9443` (HTTPS UI) and `:8000` (edge-agent tunnel). It
  bind-mounts the container-engine socket (`/var/run/docker.sock`; override
  `DOCKER_SOCKET`) so it can manage the host's containers, and stores its
  database/settings in the `portainer-data` named volume.

scotty bind-mounts the host repos read-write so `bd` can create and edit
worktrees/`.beads`: it mounts `reposDir` at its **host path**
(`/home/<user>/git`) and runs with `network_mode: host`, so its `bd` shares the
host's dolt sql-server (see below) and reads the same `.beads` state as
host-run `bd`. pi-web is native (no container) and sees the repos directly at
their host paths.

Default `reposDir` is `$HOME/git`; override with `BELAYD_REPOS_DIR`.

The containers run as the host user (override `BELAYD_UID` / `BELAYD_GID`;
defaults `1000`/`1000`) so files written into the bind-mounted repos are not
root-owned. Match these to `id -u` / `id -g` on your host — in particular
`BELAYD_GID` defaults to `1000`, but many distros use `100` for the primary
group.

## Portainer first run

Open `https://localhost:9443` (self-signed certificate — accept it) and create
the admin account. The first-run setup token is printed in the log:

```bash
arion logs portainer
```

Portainer manages the same Podman engine the rest of the stack runs on, via
the Docker-compatible socket. Podman's API covers most of Portainer's needs,
but a few Docker-only features may not work.

## scotty project registration

After `arion up -d`, open `http://localhost:7687`. The add-project file browser
is rooted at the host repos path (`BEADS_FS_ROOT` = `reposDir`, e.g.
`/home/<user>/git`), so existing repos appear immediately. Each project must
contain a `.beads` directory; projects use the same host paths as host-run
`bd`, so scotty and host `bd` see one set of `.beads`.

### Sharing the dolt server with host `bd`

scotty runs with `network_mode: host` so its `bd` reaches the host's dolt
sql-server over `127.0.0.1`. bd connects by dialing the port from the shared
`.beads/dolt-server.port` first, and only auto-starts a server if that dial
fails — so whichever side starts the server (host `bd` or scotty's `bd`), the
other connects to it instead of fighting over dolt's single-writer lock. No PID
namespace sharing is required. The scotty image ships `dolt` and `procps` so bd
can auto-start and verify a server when none is running.

## Environment overrides

| Variable | Default | Meaning |
|----------|---------|---------|
| `BELAYD_UID` / `BELAYD_GID` | `1000` / `1000` | Container user (match your host `id -u` / `id -g`) |
| `BELAYD_ACTOR` | `$USER` | Human actor scotty falls back to (`BEADS_ACTOR`) |
| `BELAYD_REPOS_DIR` | `$HOME/git` | Host repos dir (scotty mounts it at its host path) |
| `BELAYD_SCOTTY_CONFIG_DIR` | `$HOME/.config/bead-me-up-scotty` | Host scotty config dir |
| `SCOTTY_HOST_PORT` | `7687` | Host port scotty binds directly (host networking) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Container-engine socket Portainer manages |
| `PORTAINER_HOST_PORT` | `9443` | Host HTTPS port for Portainer |
| `PORTAINER_EDGE_PORT` | `8000` | Host edge-agent tunnel port for Portainer |

Set them when invoking arion, e.g. `BELAYD_REPOS_DIR=$HOME/src arion up -d`.
