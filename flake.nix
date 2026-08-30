{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";
  inputs.systems.url = "github:nix-systems/default";
  inputs.backlog-md.url = "github:MrLesk/Backlog.md";
  inputs.beads.url = "github:gastownhall/beads";
  inputs.llm-agents.url = "github:numtide/llm-agents.nix";
  inputs.pi-nix.url = "github:lukasl-dev/pi.nix";

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      systems,
      backlog-md,
      beads,
      llm-agents,
      pi-nix,
      ...
    }:
    {
      nixosModules.pi-web = { config, lib, pkgs, ... }:
        let
          cfg = config.services.belayd-pi-web;

          # belayd builds pi-web and its runtime env against nixpkgs-unstable;
          # pull the matching gcc lib and CA bundle from that same package set.
          system = pkgs.stdenv.hostPlatform.system;
          belaydPkgs = self.inputs.nixpkgs.legacyPackages.${system};
          pi-web = self.packages.${system}.pi-web;
          pi-web-runtime-env = self.packages.${system}.pi-web-runtime-env;
          gccLib = belaydPkgs.stdenv.cc.cc.lib;
          cacert = belaydPkgs.cacert.out;

          userHome = config.users.users.${cfg.user}.home or "/home/${cfg.user}";
          dataDir = if cfg.dataDir != null then cfg.dataDir else "${userHome}/.pi-web";

          environment = [
            "HOME=${userHome}"
            "SHELL=${pi-web-runtime-env}/bin/bash"
            "XDG_CONFIG_HOME=${userHome}/.config"
            "XDG_CACHE_HOME=${userHome}/.cache"
            "PI_WEB_HOST=${cfg.host}"
            "PI_WEB_PORT=${toString cfg.port}"
            "PI_WEB_DATA_DIR=${dataDir}"
            "PI_WEB_SESSIOND_SOCKET=${dataDir}/sessiond.sock"
            "PI_CODING_AGENT_DIR=${userHome}/.pi/agent"
            "PATH=${pi-web-runtime-env}/bin:/run/current-system/sw/bin:${userHome}/.nix-profile/bin"
            "LD_LIBRARY_PATH=${gccLib}/lib"
            "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
            "NIX_SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
          ];
        in
        {
          options.services.belayd-pi-web = {
            enable = lib.mkEnableOption "pi-web (browser UI + session daemon) as systemd system services";
            user = lib.mkOption {
              type = lib.types.str;
              description = "User the services run as.";
            };
            host = lib.mkOption {
              type = lib.types.str;
              default = "0.0.0.0";
              description = "PI_WEB_HOST bind address.";
            };
            port = lib.mkOption {
              type = lib.types.port;
              default = 8504;
              description = "PI_WEB_PORT.";
            };
            dataDir = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "PI_WEB_DATA_DIR; defaults to <home>/.pi-web.";
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.pi-web-sessiond = {
              description = "PI WEB session daemon";
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];
              wantedBy = [ "multi-user.target" ];
              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Environment = environment;
                ExecStart = "${pi-web}/bin/pi-web-sessiond";
                Restart = "on-failure";
                RestartSec = 2;
              };
            };

            systemd.services.pi-web = {
              description = "PI WEB server";
              after = [
                "network-online.target"
                "pi-web-sessiond.service"
              ];
              wants = [
                "network-online.target"
                "pi-web-sessiond.service"
              ];
              wantedBy = [ "multi-user.target" ];
              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Environment = environment;
                ExecStart = "${pi-web}/bin/pi-web-server";
                Restart = "on-failure";
                RestartSec = 2;
              };
            };
          };
        };
    }
    // flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        # Bead Me Up, Scotty — multi-repo web UI for beads (bd).
        # `__noChroot` allows next/font/google to download fonts during `next build`.
        bead-me-up-scotty = pkgs.buildNpmPackage {
          pname = "bead-me-up-scotty";
          version = "0.1.0";
          src = pkgs.fetchFromGitHub {
            owner = "brendan-appstart";
            repo = "bead-me-up-scotty";
            rev = "e26e446cba697a522ecceabdeeb11dc99239a071";
            hash = "sha256-NZDins8ZZdbFdTk8MBXbD83Q89INz/ZXWDFc6jKkfNo=";
          };
          npmDepsHash = "sha256-Yr3l6WD1B1sTD3UxiHW5yZUiSNAfyrZpL0nFvBBUZcU=";
          npmFlags = [ "--no-audit" "--no-fund" ];
          NEXT_TELEMETRY_DISABLED = "1";

          # Drop next/font/google so the build works in the Nix sandbox (no
          # network to download Geist during `next build`).
          postPatch = ''
            cat > app/layout.tsx <<'LAYOUT'
            import type { Metadata } from "next";
            import "./globals.css";
            import { Providers } from "@/components/providers";
            import { APP_TITLE } from "@/lib/app-title";

            export const metadata: Metadata = {
              title: APP_TITLE,
              description: "A local web UI for the beads (bd) issue tracker",
            };

            export default function RootLayout({
              children,
            }: Readonly<{ children: React.ReactNode }>) {
              return (
                <html lang="en" suppressHydrationWarning className="h-full antialiased">
                  <body className="h-full">
                    <Providers>{children}</Providers>
                  </body>
                </html>
              );
            }
            LAYOUT
          '';

          buildPhase = ''
            runHook preBuild
            npm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            local outDir="$out/lib/node_modules/bead-me-up-scotty"
            mkdir -p "$outDir"
            cp -r .next "$outDir/.next"
            cp -r node_modules "$outDir/node_modules"
            cp -r public "$outDir/public"
            cp -r bin "$outDir/bin"
            cp next.config.ts package.json instrumentation.ts instrumentation-node.ts "$outDir/" 2>/dev/null || true
            mkdir -p "$out/bin"
            cat > "$out/bin/scotty" <<WRAPPER
            #!${pkgs.bash}/bin/bash
            exec ${pkgs.nodejs_24}/bin/node "$outDir/bin/bead-me-up-scotty.mjs" "\$@"
            WRAPPER
            chmod +x "$out/bin/scotty"
            ln -sf scotty "$out/bin/bead-me-up-scotty"
            runHook postInstall
          '';
        };

        # pi-web — browser UI + session daemon for persistent pi sessions.
        # The web server and sessiond must share PI_WEB_DATA_DIR and the unix
        # socket; the system service below runs them as two units that share
        # those paths via a common environment.
        pi-web = pkgs.buildNpmPackage {
          pname = "pi-web";
          version = "1.202608.1";
          src = pkgs.fetchFromGitHub {
            owner = "jmfederico";
            repo = "pi-web";
            # Upstream tag v1.202608.1.
            rev = "e3cd03aa18c9b677c45dc8f1992b3fe76816bafc";
            hash = "sha256-Py60R6rzcn7KnX5f2jF341Qn8nNq1YuE6zUUpjknzK4=";
          };
          # Upstream's package-lock.json omits `integrity` for a few nested
          # @earendil-works deps of pi-coding-agent; prefetch-npm-deps refuses
          # non-git deps without integrity. Fill in the registry-published
          # dist.integrity values (see nix/pi-web-integrity.patch).
          patches = [ ./nix/pi-web-integrity.patch ];
          npmDepsHash = "sha256-qaMOYKZpNGKxJRlra+lnbDb+KGodOA6GuR+3N/HCD9g=";
          npmFlags = [ "--no-audit" "--no-fund" ];
          # npm's cacache wants to rewrite index entries during `npm ci`; the
          # npmDeps store path is read-only, so give it a writable copy.
          makeCacheWritable = true;

          # node-pty is a native module (node-gyp). buildNpmPackage already
          # adds nodejs-slim.python; an explicit python3 keeps it unambiguous.
          nativeBuildInputs = [ pkgs.python3 ];

          buildPhase = ''
            runHook preBuild
            npm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            local outDir="$out/lib/node_modules/pi-web"
            mkdir -p "$outDir" "$out/bin"
            cp -r dist node_modules package.json "$outDir/"
            # Three explicit wrappers — upstream bin paths differ per command.
            cat > "$out/bin/pi-web" <<EOF
            #!${pkgs.bash}/bin/bash
            exec ${pkgs.nodejs_24}/bin/node "$outDir/dist/cli.js" "\$@"
            EOF
            cat > "$out/bin/pi-web-server" <<EOF
            #!${pkgs.bash}/bin/bash
            exec ${pkgs.nodejs_24}/bin/node "$outDir/dist/server/index.js" "\$@"
            EOF
            cat > "$out/bin/pi-web-sessiond" <<EOF
            #!${pkgs.bash}/bin/bash
            exec ${pkgs.nodejs_24}/bin/node "$outDir/dist/server/sessiond.js" "\$@"
            EOF
            chmod +x "$out/bin/pi-web" "$out/bin/pi-web-server" "$out/bin/pi-web-sessiond"
            runHook postInstall
          '';
        };

        # The development environment for pi sessions, shared between the
        # devShell and the pi-web system service (see pi-web-runtime-env).
        #
        # The pi-web session daemon spawns agent processes that inherit its
        # environment, so this list provides the tools a `nix develop` shell
        # would (pnpm, bd, dolt, wt, …).
        #
        # `bash` is explicit because the pi `bash` tool resolves `/bin/bash`
        # (falling back to `which bash` → `sh`), and a system service does not
        # get the user's login-shell PATH.
        devShellTools = [
          pkgs.bash
          pkgs.nodejs_24
          pkgs.pnpm
          pkgs.typescript
          pkgs.biome
          pkgs.qemu
          backlog-md.packages.${system}.default
          beads.packages.${system}.default
          pkgs.dolt
          pkgs.worktrunk # `wt` — worktree manager the harness shells out to
          bead-me-up-scotty
          llm-agents.packages.${system}.pi
          pkgs.stdenv.cc.cc.lib # runtime lib for native node modules (shellHook)
          pkgs.procps # bd's dolt-server liveness check runs `ps -axo`
        ];

        # Native runtime environment for the pi-web system service: a buildEnv
        # whose /bin is prepended to PATH. The pi-web session daemon spawns
        # agent processes that inherit its environment, so this must include
        # nix (for `nix develop`/direnv in sessions) plus the same dev tools
        # the devShell provides. Unlike the docker image, a native service can
        # carry nix itself — this is what fixes `nix develop` in sessions.
        pi-web-runtime-env = pkgs.buildEnv {
          name = "pi-web-runtime-env";
          paths = devShellTools ++ [
            pkgs.nix
            pkgs.direnv
            pkgs.gitMinimal
            pkgs.openssh # ssh-keygen for git SSH signing
          ];
          pathsToLink = [ "/bin" ];
        };

        # pi — the pi coding agent CLI, unconfigured (bare). Kept as the base
        # binary for the configured wrapper below and as an escape hatch.
        pi-bare = llm-agents.packages.${system}.pi;

        # The harness's agent skills (.agents/skills). Linked into
        # ~/.agents/skills/ by the NixOS config so pi discovers them globally.
        belayd-skills = pkgs.runCommand "belayd-skills" { } ''
          mkdir -p "$out"
          cp -r ${./.agents/skills}/. "$out/"
        '';

        # The harness's pi extensions plus the src/ tree they import from
        # (extensions/index.ts does `import "../src/index.js"`). Linked into
        # ~/.pi/agent/ by the NixOS config.
        belayd-harness = pkgs.runCommand "belayd-harness" { } ''
          mkdir -p "$out/extensions" "$out/src"
          cp -r ${./extensions}/. "$out/extensions/"
          cp -r ${./src}/. "$out/src/"
        '';

        # Third-party pi npm extensions (exa web search, ast-grep, vision,
        # plannotator, OpenRouter provider). Packaged as a Nix node_modules tree
        # so pi never needs a runtime `npm install` into ~/.pi/agent/npm. Each
        # package's `pi.extensions` entry is passed via --extension below.
        pi-extensions = pkgs.buildNpmPackage {
          pname = "pi-extensions";
          version = "0.1.0";
          src = ./nix/pi-extensions;
          npmDepsHash = "sha256-sicP/7UKlZqFj8VaNKaj/VsRJWHvcm/TpG/HQe9lfr8=";
          npmDepsFetcherVersion = 2;
          npmFlags = [ "--legacy-peer-deps" ];
          dontNpmBuild = true;
        };

        # pi configured via pi.nix's mkCodingAgent: harness + npm extensions,
        # skills, and the LLM Gateway models all baked into one binary. The only
        # global pi state left is ~/.pi/agent/auth.json (credentials), plus
        # sessions and the wrapper-managed models.json/settings.json.
        belayd-pi = pi-nix.lib.mkCodingAgent {
          inherit pkgs;
          modules = [{
            pi.coding-agent = {
              # Keep the llm-agents pi build as the base binary; pi.nix only
              # supplies the wrapper-generation logic here (no pi.cachix.org).
              package = pi-bare;
              extensions = [
                "${belayd-harness}/extensions/index.ts"
                "${belayd-harness}/extensions/stale-file-guard.ts"
                "${belayd-harness}/extensions/worktree-guard.ts"
                "${pi-extensions}/lib/node_modules/pi-extensions/node_modules/pi-exa/src/index.ts"
                "${pi-extensions}/lib/node_modules/pi-extensions/node_modules/pi-ast-grep/src/index.ts"
                "${pi-extensions}/lib/node_modules/pi-extensions/node_modules/pi-vision-tool/extensions/vision-tool.ts"
                "${pi-extensions}/lib/node_modules/pi-extensions/node_modules/@plannotator/pi-extension/index.ts"
                "${pi-extensions}/lib/node_modules/pi-extensions/node_modules/@robhowley/pi-openrouter/extensions/openrouter/index.ts"
              ];
              skills = [ belayd-skills ];
              models = ./models.json;
              settings = {
                defaultProvider = "llmgateway";
                defaultModel = "deepseek-v4-pro";
                defaultThinkingLevel = "high";
                theme = "dark";
              };
              # -ne disables ALL extension auto-discovery (global dirs, the
              # settings `extensions`/`packages` arrays, and project
              # .pi/settings.json), so the only extensions that load are the
              # explicit --extension flags above. This is the same trick as
              # bin/pi: it makes the binary self-contained and immune to
              # leftover global config double-loading the same tools.
              extraArgs = [ "-ne" ];
            };
          }];
        };

        # The configured pi binary, exposed as `pi` so nix-tmp and the NixOS
        # config keep installing `belaydPkgs.pi` unchanged, and so
        # `nix run .#pi --` / `nix run <flake>#pi --` just works.
        #
        # One extra layer on top of mkCodingAgent's wrapper: install the
        # pi-exa and pi-vision-tool config files into the agentDir if absent
        # (same install-if-absent pattern pi.nix uses for models.json). Both
        # extensions read $PI_CODING_AGENT_DIR/<name>.json, so this keeps
        # web_search_advanced_exa/deep_search_exa and describe_image configured
        # without any hand-maintained global config. User edits made via the
        # extensions' own /config commands persist (we only install when the
        # file is missing).
        pi = pkgs.writeShellScriptBin "pi" ''
          set -euo pipefail
          agent_dir="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
          install_if_absent() {
            local name="$1" src="$2"
            local dst="$agent_dir/$name"
            if [ -L "$dst" ]; then
              rm -f "$dst"
            fi
            if [ ! -f "$dst" ]; then
              mkdir -p "$agent_dir"
              install -m 0600 "$src" "$dst"
            fi
          }
          install_if_absent "pi-exa.json" ${./pi-exa.json}
          install_if_absent "vision-tool.json" ${./vision-tool.json}
          exec ${belayd-pi.package}/bin/pi "$@"
        '';

        # dockerTools.buildLayeredImage inherits `isExe = true` from its inner
        # streamLayeredImage even though its output is a plain tarball. Arion
        # keys off that flag to decide between executing the image and
        # `docker load`-ing it, so reset it to keep the tarball semantics.
        tarballImage = args: (pkgs.dockerTools.buildLayeredImage args).overrideAttrs (final: prev: {
          passthru = (prev.passthru or {}) // { isExe = false; };
        });

        # Container image for scotty. Arion loads this image and runs it with
        # --no-open (no browser inside the container). /config is created here
        # owned by 1000:1000 so the non-root container user can create bind-mount
        # targets under it (see arion-compose.nix).
        scotty-image = tarballImage {
          name = "belayd/scotty";
          tag = "latest";
          contents = [
            bead-me-up-scotty
            beads.packages.${system}.default
            # bd shells out to `dolt` for its SQL database; without it on PATH
            # bd can't auto-start the server and scotty can't open projects.
            pkgs.dolt
            # bd's server-liveness check runs `ps -axo` to confirm a running
            # dolt sql-server (isDoltProcess); without procps it can't detect
            # the host's server and starts a competing one on the shared lock.
            pkgs.procps
            pkgs.bash
            pkgs.gitMinimal
            pkgs.coreutils
            pkgs.cacert.out
          ];
          fakeRootCommands = ''
            mkdir -p config tmp
            chown 1000:1000 config tmp
          '';
          config = {
            Env = [
              "PATH=/bin"
              "HOME=/config"
              "XDG_CONFIG_HOME=/config"
            ];
            Cmd = [ "scotty" "--host" "0.0.0.0" "--port" "7687" "--no-open" ];
          };
        };

      in
      {
        packages = {
          inherit bead-me-up-scotty pi-web scotty-image pi-web-runtime-env pi pi-bare pi-extensions belayd-pi belayd-skills belayd-harness;
        };

        # Default runnable: `nix run ~/git/belayd-agent-harness` (no `#pi`
        # fragment needed) launches the configured pi. This also makes the
        # `npi` shell abbreviation trivial and avoids `#` quoting issues.
        apps.default = {
          type = "app";
          program = "${pi}/bin/pi";
        };

        devShells.default = pkgs.mkShell {
          packages = devShellTools ++ [
            # Host-only orchestration: arion + docker tooling drive the
            # container stack from outside; the pi-web image doesn't need them.
            pkgs.arion
            pkgs.docker-compose
            pkgs.docker-client
          ];

          shellHook = ''
            export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            # Local pi wrapper (bin/pi): spawned belayd agents resolve their pi
            # binary via this var (src/spawn.ts) and would otherwise pick the
            # global /run/current-system/sw/bin/pi and dual-load extensions.
            export PI_BINARY_PATH="''${PWD}/bin/pi"
          '';
        };
      }
    );
}
