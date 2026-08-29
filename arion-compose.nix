# Local scotty + portainer stack, autostarted by arion. pi-web is no longer a
# container — it runs as systemd system services declared by the flake's
# `nixosModules.pi-web` (see flake.nix / docs/pi-web-service.md).
#
# Usage (from the repo root, inside `nix develop`):
#   arion up -d          # start all containers, restart on boot/daemon start
#   arion ps             # list services
#   arion logs -f        # follow logs
#   arion down           # stop and remove containers
#
# arion builds each image with Nix and `docker load`s it, so no Dockerfile or
# registry is involved. The images themselves are defined in flake.nix
# (package scotty-image); this file references that derivation so there is a
# single source of truth for image contents.
#
# `user` is set to the host uid:gid so `bd` writes into the bind-mounted repos
# (/repos) are owned by the host user rather than root.
{ lib, ... }:
let
  flake = builtins.getFlake (toString ./.);
  pkgs = flake.packages.${builtins.currentSystem};

  fromEnv = name: default:
    let value = builtins.getEnv name;
    in if value == "" then default else value;

  home = builtins.getEnv "HOME";

  uid = fromEnv "BELAYD_UID" "1000";
  gid = fromEnv "BELAYD_GID" "1000";
  actor = fromEnv "BELAYD_ACTOR" (builtins.getEnv "USER");

  # Host git repos. Mounted read-write at /repos (for new project registration)
  # and at the host path itself, so existing scotty/pi-web configs that store
  # host-absolute repo paths (/home/<user>/git/...) keep resolving.
  reposDir = fromEnv "BELAYD_REPOS_DIR" "${home}/git";

  # Host state dirs, bind-mounted so the containers reuse the state the host's
  # non-container scotty/pi-web already wrote instead of empty named volumes.
  scottyConfigDir = fromEnv "BELAYD_SCOTTY_CONFIG_DIR" "${home}/.config/bead-me-up-scotty";

  # Single dolt sql-server for all Beads projects (shared-server mode). State
  # lives here on the host; host bd and scotty dial it over 127.0.0.1.
  beadsSharedServerDir = fromEnv "BELAYD_BEADS_SHARED_SERVER_DIR" "${home}/.beads/shared-server";

  scottyPort = fromEnv "SCOTTY_HOST_PORT" "7687";

  # Portainer manages the host's container engine over its socket. This host
  # runs Podman behind a Docker-compatible socket (/var/run/docker.sock ->
  # /run/podman/podman.sock); override DOCKER_SOCKET for a plain Docker host.
  dockerSocket = fromEnv "DOCKER_SOCKET" "/var/run/docker.sock";
  portainerPort = fromEnv "PORTAINER_HOST_PORT" "9443";
  portainerEdgePort = fromEnv "PORTAINER_EDGE_PORT" "8000";
  portainerHttpPort = fromEnv "PORTAINER_HTTP_PORT" "9000";
in
{
  project.name = "belayd-local-stack";

  # State is shared with the host via bind mounts (no named volumes), so a
  # plain `arion down` + `arion up -d` keeps settings and projects intact.

  services.scotty = {
    # Use the exact image built in flake.nix instead of letting arion rebuild
    # an equivalent image from `image.contents`.
    build.image = lib.mkForce pkgs.scotty-image;
    service.user = "${uid}:${gid}";
    # scotty's `bd` must share the host's dolt sql-server (dolt holds an
    # exclusive lock on .beads/dolt). Run it on the host network so bd's
    # dial-first connection reaches the host server over 127.0.0.1 using the
    # port from the bind-mounted .beads/dolt-server.port, instead of starting
    # a competing server. bd dials before any PID check, so no pid:host needed.
    #
    # BEADS_DOLT_AUTO_START=false is the crux: if scotty's bd ever fails to
    # dial (e.g. stale .beads/dolt-server.port), auto-start would spawn a dolt
    # server inside the container. That server holds the data-dir lock, and its
    # port never reaches the host's port file, so every subsequent bd run
    # (host or scotty) auto-starts yet another competing server that dies with
    # "database is locked" — a self-sustaining churn that clobbers the port
    # file. With auto-start disabled scotty only ever dials; the host owns the
    # server (started by host-run bd).
    service.network_mode = "host";
    service.restart = "unless-stopped";
    # With host networking there is no port mapping — scotty binds the host
    # port directly.
    service.command = [ "scotty" "--host" "0.0.0.0" "--port" scottyPort "--no-open" ];
    service.environment = {
      HOME = "/config";
      XDG_CONFIG_HOME = "/config";
      # Root scotty's add-project file browser at the repos using the HOST
      # path, so scotty/bd write dolt-server-config.yaml with the same paths
      # as host-run bd (no /repos vs /home/<user> flip-flop).
      BEADS_FS_ROOT = reposDir;
      BEADS_DOLT_AUTO_START = "false";
    } // (if actor == "" then { } else { BEADS_ACTOR = actor; });
    service.volumes = [
      # Host git repos at their host path, so scotty and host bd share one
      # view of .beads (and dolt-server-config.yaml paths match).
      { type = "bind"; source = reposDir; target = reposDir; }
      # Host scotty config (config.json with projects + actor).
      { type = "bind"; source = scottyConfigDir; target = "/config/bead-me-up-scotty"; }
    ];
  };

  services.beads-shared-server = {
    # Single dolt sql-server for all Beads projects (shared-server mode),
    # replacing the per-project servers. The host owns it; host bd and the
    # host-networked scotty container dial 127.0.0.1:<port>.
    #
    # Official Dolt image, but we override its entrypoint: the stock
    # docker-entrypoint.sh hardcodes `dolt sql-server --host=0.0.0.0 --port=3306`,
    # which would clobber the listener (127.0.0.1:3308) that bd generated in
    # dolt-server-config.yaml and that every project expects. Run dolt directly.
    service.image = "dolthub/dolt-sql-server:2.3.1";
    service.user = "${uid}:${gid}";
    # Host networking so the server binds the host loopback (127.0.0.1:3308),
    # reachable by host bd and scotty without a published port.
    service.network_mode = "host";
    service.restart = "unless-stopped";
    service.entrypoint = "dolt";
    service.command = [ "sql-server" "--config" "${beadsSharedServerDir}/dolt-server-config.yaml" ];
    # dolt defaults data_dir to the working directory; bd created the databases
    # under <shared-server>/dolt, so run from there.
    service.working_dir = "${beadsSharedServerDir}/dolt";
    service.volumes = [
      # Host shared-server state (data, config, port file) at its host path so
      # the absolute cfg_dir in the bd-generated config keeps resolving.
      { type = "bind"; source = beadsSharedServerDir; target = beadsSharedServerDir; }
    ];
  };

  # Portainer's own state (database + settings) lives in a named volume.
  docker-compose.volumes.portainer-data = { };

  services.portainer = {
    # Portainer is pulled from Docker Hub, not built by Nix.
    service.image = "portainer/portainer-ce:latest";
    service.ports = [
      # Edge-agent reverse tunnel (only used if you attach edge agents).
      "${portainerEdgePort}:8000"
      # HTTPS web UI.
      "${portainerPort}:9443"
      # Plain HTTP, loopback-only — used by `tailscale serve` so the tailnet
      # proxy can speak HTTP to Portainer instead of re-terminating its
      # self-signed TLS on 9443.
      "127.0.0.1:${portainerHttpPort}:9000"
    ];
    service.restart = "unless-stopped";
    service.volumes = [
      # Host container-engine socket, so Portainer can manage the containers.
      { type = "bind"; source = dockerSocket; target = "/var/run/docker.sock"; }
      { type = "volume"; source = "portainer-data"; target = "/data"; }
    ];
  };
}
