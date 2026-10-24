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
      nixosModules.pi-web =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.belayd-pi-web;

          # belayd builds pi-web and its runtime env against nixpkgs-unstable;
          # pull the matching gcc lib and CA bundle from that same package set.
          system = pkgs.stdenv.hostPlatform.system;
          belaydPkgs = self.inputs.nixpkgs.legacyPackages.${system};
          archify = self.packages.${system}.archify;
          pi-web = self.packages.${system}.pi-web;
          pi-web-runtime-env = self.packages.${system}.pi-web-runtime-env;
          belayd-shell = self.packages.${system}.belayd-shell;
          belayd-harness = self.packages.${system}.belayd-harness;
          pi-extensions = self.packages.${system}.pi-extensions;
          gccLib = belaydPkgs.stdenv.cc.cc.lib;
          cacert = belaydPkgs.cacert.out;

          userHome = config.users.users.${cfg.user}.home or "/home/${cfg.user}";
          # Declaration is not the same thing as an explicit uid:
          # `isNormalUser = true` leaves `uid = null` until NixOS assigns one at
          # build time, so a null uid does NOT mean the account is undeclared.
          # Check the attribute explicitly so a normal user never trips the
          # "not declared" warning.
          userDeclared = builtins.hasAttr cfg.user config.users.users;
          # `or null`: the operator may also point `user` at a pre-existing
          # system account that is not declared under `users.users` (a service
          # user owned by another module, for example), and even a declared
          # normal user has no explicit uid here. A raw `.uid` selection throws
          # at evaluation time and takes the whole rebuild down with it; the only
          # consumer is XDG_RUNTIME_DIR, and the AWS broker deliberately no
          # longer depends on that path (it uses RuntimeDirectory +
          # BELAYD_AWS_RUNTIME_BASE_DIR, both uid-independent).
          userUid = config.users.users.${cfg.user}.uid or null;
          # systemd-created runtime base for the broker. Unlike /run/user/<uid>,
          # it exists for a session-less system-service user and survives the
          # crash-restarts of Restart=on-failure.
          awsRuntimeBaseDir = "/run/belayd/aws";
          dataDir = if cfg.dataDir != null then cfg.dataDir else "${userHome}/.pi-web";

          environment = [
            "HOME=${userHome}"
            # Route terminals, plugin runCommand, and workspace removal through
            # the cwd-aware devShell wrapper instead of a bare bash.
            "SHELL=${belayd-shell}/bin/belayd-shell"
            "XDG_CONFIG_HOME=${userHome}/.config"
            "XDG_CACHE_HOME=${userHome}/.cache"
            "PI_WEB_HOST=${cfg.host}"
            "PI_WEB_PORT=${toString cfg.port}"
            "PI_WEB_DATA_DIR=${dataDir}"
            "PI_WEB_SESSIOND_SOCKET=${dataDir}/sessiond.sock"
            "PI_CODING_AGENT_DIR=${userHome}/.pi/agent"
            "PATH=${pi-web-runtime-env}/bin:/run/current-system/sw/bin:${userHome}/.nix-profile/bin"
            # The AWS broker (and the sandbox plans it serves) keep their unix
            # sockets under a runtime base the broker unit owns via systemd
            # `RuntimeDirectory`. Both units must agree on it; it is set here so
            # a sandboxed session and the broker resolve the same sockets
            # without depending on logind creating /run/user/<uid>.
            "BELAYD_AWS_RUNTIME_BASE_DIR=${awsRuntimeBaseDir}"
            # The generated credential_process shim execs this wrapper instead
            # of a hardcoded node path, so the sandbox never depends on how the
            # harness happens to be built. BELAYD_AWS_BIN is the CLI the plan
            # resolver calls to start a scope socket on demand.
            "BELAYD_AWS_CREDENTIAL_PROCESS_BIN=${belayd-harness}/bin/belayd-aws-credential-process"
            "BELAYD_AWS_BIN=${belayd-harness}/bin/belayd-aws"
            "LD_LIBRARY_PATH=${gccLib}/lib"
            "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
            "NIX_SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
            "PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}"
            "PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1"
            # Spawned agent sessions see this; the archify wrapper exports it
            # too, but the runtime env is what reaches the agent's shell.
            "ARCHIFY_HOME=${archify}/libexec/archify"
            # Node_modules tree for the third-party pi extensions. bin/pi builds
            # its -e list from ./package.json pi.extensions plus the
            # nix/pi-extensions manifest, resolved against this directory, so
            # the dev loop loads the same extension set as the baked binary
            # without a runtime `npm install`.
            "BELAYD_PI_EXTENSIONS_DIR=${pi-extensions}/lib/node_modules/pi-extensions/node_modules"
          ]
          # XDG_RUNTIME_DIR is still useful for tools inside sessions (dbus,
          # ssh-agent), but it is only set when the uid is explicit at eval time:
          # systemd only sets it for *user* units, a normal `isNormalUser`
          # account has `uid = null` here, and a service user may not be
          # declared in users.users at all.
          ++ lib.optional (userUid != null) "XDG_RUNTIME_DIR=/run/user/${toString userUid}";

          # Runs before the session daemon: provision the direnv whitelist and
          # merge the global settings.json shellPath. Both helpers are
          # non-strict by default, so a corrupt direnv.toml/settings.json warns
          # and exits 0 — a broken user config must not block the unit.
          #
          # It also pre-creates the two AWS mask destinations (bd-125) and the
          # pi-web data directory, so the sandbox starts even when the operator
          # has never run `aws sso login` or the web server has not created its
          # state directory yet.
          piWebSessiondSetup = pkgs.writeShellScriptBin "pi-web-sessiond-setup" ''
            set -euo pipefail
            install -d -m 0700 ${lib.escapeShellArg "${userHome}/.aws"}
            install -d -m 0700 ${lib.escapeShellArg "${userHome}/.config/aws"}
            # The session daemon writes its ownership marker and unix socket
            # here before the web server may have created the directory; the
            # writable bind below needs the destination to exist.
            install -d -m 0700 ${lib.escapeShellArg dataDir}
            ${belayd-shell}/bin/belayd-direnv-setup \
              --toml ${lib.escapeShellArg "${userHome}/.config/direnv/direnv.toml"} \
              ${lib.concatMapStringsSep " " (
                p: "--prefix ${lib.escapeShellArg p}"
              ) cfg.devShellWhitelistPrefixes}
            ${belayd-shell}/bin/belayd-shell-path-setup
          '';
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
            devShellWhitelistPrefixes = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ "${userHome}/git" ];
              description = ''
                Prefixes ensured in ~/.config/direnv/direnv.toml [whitelist]
                prefix. A whitelisted prefix makes direnv trust every .envrc
                beneath it *content-independently* — i.e. an arbitrary-code-
                execution grant for anything a collaborator with VCS write
                access can commit. Keep the list as narrow as possible; direnv
                `deny` entries still override it.
              '';
            };
          };

          config = lib.mkIf cfg.enable {
            # Only reachable when `user` is not declared under users.users, so
            # the service account cannot be resolved and XDG_RUNTIME_DIR cannot
            # be derived. The AWS broker is unaffected (RuntimeDirectory +
            # BELAYD_AWS_RUNTIME_BASE_DIR are uid-free); this warns instead of
            # failing the rebuild. A declared normal user has `uid = null` at
            # eval time too, but is not warned about: that is the expected
            # `isNormalUser` shape, not a missing account.
            warnings = lib.optional (!userDeclared) ''
              services.belayd-pi-web: user "${cfg.user}" is not declared in users.users, so the service account cannot be resolved and XDG_RUNTIME_DIR is not set for pi-web-sessiond/pi-web-aws-broker. The AWS broker still works (it uses RuntimeDirectory + BELAYD_AWS_RUNTIME_BASE_DIR); tools inside sessions that rely on XDG_RUNTIME_DIR (dbus, ssh-agent) may not find it.
            '';

            # The session daemon runs inside a bubblewrap *mask* (bd-125): every
            # agent session it spawns inherits a mount namespace where the
            # operator's AWS credential material does not exist. Only the user
            # namespace is unshared on purpose — bd's dolt liveness check shells
            # out to `ps -axo`, and terminals plus `nix build` need the host
            # /tmp and host network, so pid/ipc/net stay shared. `--tmpfs` is
            # used (not `--ro-bind /dev/null`) because the SSO cache is a
            # directory; both mount points are pre-created by ExecStartPre.
            #
            # The base is `--bind / /`, NOT `--ro-bind / /`: the daemon writes
            # its ownership marker and unix socket into PI_WEB_DATA_DIR, and
            # every session it spawns must write its worktree, `/tmp`, `~/.pi`,
            # and Nix caches. The security boundary is the AWS mask, not a
            # read-only root; a read-only base makes the daemon crash with
            # `EROFS ... sessiond-owner.json` before it can bind the socket.
            #
            # Rollback is one line: replace ExecStart with the plain
            # `${pi-web}/bin/pi-web-sessiond`, `nixos-rebuild switch`, then
            # restart pi-web-sessiond and pi-web-aws-broker.
            #
            # This sandbox deliberately does NOT set BELAYD_SANDBOX_ACTIVE: an
            # agent spawned inside it must still resolve its own per-repo scope
            # (a nested, stricter sandbox). See docs/aws-credential-isolation.md.
            systemd.services.pi-web-sessiond = {
              description = "PI WEB session daemon";
              after = [
                "network-online.target"
                "pi-web-aws-broker.service"
              ];
              wants = [
                "network-online.target"
                "pi-web-aws-broker.service"
              ];
              wantedBy = [ "multi-user.target" ];
              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Environment = environment;
                ExecStartPre = "${piWebSessiondSetup}/bin/pi-web-sessiond-setup";
                ExecStart = lib.concatStringsSep " " [
                  "${pkgs.bubblewrap}/bin/bwrap"
                  "--unshare-user"
                  "--die-with-parent"
                  "--bind"
                  "/"
                  "/"
                  "--dev-bind"
                  "/dev"
                  "/dev"
                  "--proc"
                  "/proc"
                  "--tmpfs"
                  "${userHome}/.aws"
                  "--tmpfs"
                  "${userHome}/.config/aws"
                  "--"
                  "${pi-web}/bin/pi-web-sessiond"
                ];
                Restart = "on-failure";
                RestartSec = 2;
              };
            };

            # The AWS credential broker (bd-125). Deliberately NOT sandboxed:
            # it is the one process that must read the operator's ~/.aws (via
            # the AWS CLI) to resolve scoped credentials for the repos the
            # allowlist covers. It serves one 0600 unix socket per repo scope.
            #
            # RuntimeDirectory gives the daemon a systemd-owned runtime base
            # (/run/belayd/aws, 0700, owned by `user`) before ExecStart, so the
            # broker does not crash-loop on a missing /run/user/<uid> — a system
            # service user has no logind session, and XDG_RUNTIME_DIR is only a
            # convenience for tools inside sessions. Preserve=restart keeps the
            # directory across the Restart=on-failure crash-restarts, which is
            # what lets the scope sockets come back on their own.
            systemd.services.pi-web-aws-broker = {
              description = "belayd AWS credential broker";
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];
              wantedBy = [ "multi-user.target" ];
              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Environment = environment;
                RuntimeDirectory = "belayd/aws";
                RuntimeDirectoryMode = "0700";
                RuntimeDirectoryPreserve = "restart";
                # Non-fatal (`-`): the audit writer creates this lazily and
                # reports a failure through the daemon's stderr (journal), so a
                # read-only home must not crash-loop the broker before it can
                # serve a single scope. `install` still logs its own error here.
                ExecStartPre = "-${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg "${userHome}/.local/state/belayd"}";
                ExecStart = "${belayd-harness}/bin/belayd-aws-broker";
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
                # Intentionally NOT sandboxed (bd-125): the browser UI and its
                # plugin `runCommand` path are the operator's own session, not
                # an agent. Only the session daemon gets the AWS mask.
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
        # `postPatch` owns app/layout.tsx (see below) so `next build` never reaches
        # next/font/google, which would need network access in the sandbox.
        bead-me-up-scotty = pkgs.buildNpmPackage {
          pname = "bead-me-up-scotty";
          version = "0.3.2";
          src = pkgs.fetchFromGitHub {
            owner = "brendan-appstart";
            repo = "bead-me-up-scotty";
            rev = "6a64785270449caf86fa01798d7a9599e0d384ee";
            hash = "sha256-hXzGUr7Qhdkj6AqO9WW7Pi93b71Kc2GdYaxBB4cUfVs=";
          };
          npmDepsHash = "sha256-Wx18/6mhKGhCAjRzAPKpyVIBNE1uR/P/LiNaZkeN9cY=";
          npmFlags = [
            "--no-audit"
            "--no-fund"
          ];
          NEXT_TELEMETRY_DISABLED = "1";

          # Drop next/font/google so the build works in the Nix sandbox (no
          # network to download Geist during `next build`). The replacement keeps
          # the two Geist CSS variables app/globals.css derives --font-sans and
          # --font-mono from, pointing them at the system stacks — without them
          # every font-family declaration is invalid and pages render in serif.
          postPatch = ''
            cat > app/layout.tsx <<'LAYOUT'
            import type { Metadata } from "next";
            import "./globals.css";
            import { Providers } from "@/components/providers";
            import { APP_TITLE } from "@/lib/app-title";

            const fontVariables = {
              "--font-geist-sans":
                'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
              "--font-geist-mono":
                'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
            } as React.CSSProperties;

            export const metadata: Metadata = {
              title: APP_TITLE,
              description: "A local web UI for the beads (bd) issue tracker",
            };

            export default function RootLayout({
              children,
            }: Readonly<{ children: React.ReactNode }>) {
              return (
                <html
                  lang="en"
                  suppressHydrationWarning
                  className="h-full antialiased"
                  style={fontVariables}
                >
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
            cp next.config.ts proxy.ts package.json instrumentation.ts instrumentation-node.ts "$outDir/" 2>/dev/null || true
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
          version = "1.202610.6";
          src = pkgs.fetchFromGitHub {
            owner = "jmfederico";
            repo = "pi-web";
            # Upstream tag v1.202610.6. Its package-lock.json resolves
            # @earendil-works/pi-coding-agent to 1.3.0 (with pi-agent-core/pi-ai
            # at 1.3.0), which satisfies pi-agent-browser-native's declared Pi
            # >= 1.0.0 floor so its defaultActive/namespace/outputSchema
            # features are supported (should work) in pi-web orchestrator
            # sessions; runtime behavior is not yet verified (bd-83).
            # The nested @earendil-works entries that needed integrity values
            # patched in at 1.202610.1 no longer exist, so
            # nix/pi-web-integrity.patch is no longer applied.
            rev = "5b30d2ede183cfee4fd66ae9d22dab318b066c09";
            hash = "sha256-WWjsirNju/9phxkeiQZTL/ERZl3ARANqCTCdwKvof/U=";
          };
          npmDepsHash = "sha256-3QkqOGTwQgY/byenRG5eXTTdrn6Uq3GSXkTTVp16mFw=";
          npmFlags = [
            "--no-audit"
            "--no-fund"
          ];
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
        playwright-cli = pkgs.stdenv.mkDerivation rec {
          pname = "playwright-cli";
          version = "0.1.14";

          src = pkgs.fetchurl {
            url = "https://registry.npmjs.org/@playwright/cli/-/cli-${version}.tgz";
            sha256 = "12iy66wbq19n99qpkkkqfgvs2dcikyg5iiyywh86d9hhys8ynlrv";
          };

          # @playwright/cli always pins a playwright-core alpha, whose
          # browsers.json expects browser revisions that drift from the
          # nixpkgs browser set wired into PLAYWRIGHT_BROWSERS_PATH. Build the
          # CLI against nixpkgs' own playwright-core (exposed as
          # pkgs.playwright-driver) so its expected revisions stay in lockstep
          # with pkgs.playwright-driver.browsers and no revision guard fails.
          # Re-check this binding whenever nixpkgs bumps playwright-core.
          playwrightCore = pkgs.playwright-driver;

          phases = [ "installPhase" ];

          installPhase = ''
            mkdir -p $out/lib/node_modules/@playwright/cli
            tar -xzf $src -C $out/lib/node_modules/@playwright/cli --strip-components=1

            mkdir -p $out/lib/node_modules/playwright-core
            cp -r ${playwrightCore}/. $out/lib/node_modules/playwright-core/

            mkdir -p $out/bin
            cat > $out/bin/playwright-cli <<WRAPPER
            #!${pkgs.bash}/bin/bash
            export NODE_PATH="$out/lib/node_modules"
            exec "${pkgs.nodejs_24}/bin/node" "$out/lib/node_modules/@playwright/cli/playwright-cli.js" "\$@"
            WRAPPER
            chmod +x $out/bin/playwright-cli
          '';
        };

        # Archify — typed JSON-IR diagram renderer (architecture / workflow /
        # sequence / dataflow / lifecycle) used by the belayd_archify tool.
        # Distributed only as a GitHub release zip (the npm name `archify` is
        # an unrelated 2016 package), so it is unpacked and wrapped here. The
        # wrapper disables the update checker, whose fixed-manifest network
        # GET would otherwise run in every spawned agent session.
        #
        # The zip's single top-level directory is `archify/`, so extracting
        # into libexec yields $out/libexec/archify/bin/archify.mjs (unchanged
        # in 3.x). Re-pin the version + hash deliberately; do not track
        # `releases/latest` at build time. 2.17.0-dev.1 was only ever a dev
        # identity on main, never a tagged release; 3.0.0/3.0.1 are immutable
        # tagged releases and the 3.x line is the current stable one.
        archify = pkgs.stdenv.mkDerivation rec {
          pname = "archify";
          version = "3.0.1";

          src = pkgs.fetchurl {
            url = "https://github.com/tt-a1i/archify/releases/download/v${version}/archify.zip";
            sha256 = "sha256-sLI70o2zFPBMqKuWIP4g+MGsZHSjVGvY/kZ5UIqht/U=";
          };

          nativeBuildInputs = [ pkgs.unzip ];
          phases = [ "installPhase" ];

          installPhase = ''
            mkdir -p $out/libexec
            unzip -q "$src" -d $out/libexec

            mkdir -p $out/bin
            cat > $out/bin/archify <<WRAPPER
            #!${pkgs.bash}/bin/bash
            export ARCHIFY_UPDATE_CHECK_DISABLED=1
            # Exported here so a bare `archify` invocation is self-describing:
            # the upstream SKILL.md, schemas/, examples/, and references/ all
            # live beside bin/archify.mjs under the same $out. devShell and
            # pi-web-runtime-env export the same value for agent shells that
            # never go through this wrapper.
            export ARCHIFY_HOME="$out/libexec/archify"
            exec "${pkgs.nodejs_24}/bin/node" "$out/libexec/archify/bin/archify.mjs" "\$@"
            WRAPPER
            chmod +x $out/bin/archify
          '';
        };

        devShellTools = [
          pkgs.bash
          # nodejs_24 here is 24.18.0; pi-agent-browser-native declares
          # engines.node >= 24.21.0. It still loads/registers fine — the
          # divergence is tracked in bd-82.
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
          # Native browser driver for the agent_browser tool
          # (pi-agent-browser-native). The llm-agents wrapper points
          # AGENT_BROWSER_EXECUTABLE_PATH at its bundled chromium.
          llm-agents.packages.${system}.agent-browser
          pkgs.stdenv.cc.cc.lib # runtime lib for native node modules (shellHook)
          pkgs.procps # bd's dolt-server liveness check runs `ps -axo`
          pkgs.asciinema
          # Query engine for the harness metrics log (bd-140): the harness writes
          # append-only JSONL under ~/.local/state/belayd/metrics and DuckDB reads
          # it with read_json_auto. Never a write path — fleet members run
          # concurrently under one uid and DuckDB is single-writer.
          pkgs.duckdb
          playwright-cli
          archify
          # belayd_outline extraction backends: universal-ctags is the
          # multi-language symbol extractor (`ctags --output-format=json`, one
          # process per file set) and ast-grep supplies the structured
          # `pi.registerTool` / `pi.on` registrations ctags cannot express.
          # Binaries only — the extension spawns them from PATH, never from
          # npm, so `fetchPnpmDeps` must not move for this.
          pkgs.universal-ctags
          pkgs.ast-grep
          pkgs.playwright-test # `playwright` test runner + show-trace viewer
          pkgs.playwright-driver.browsers
          # bd-125: the agent AWS sandbox (bwrap) and the credential broker's
          # resolver (aws configure export-credentials). Both also flow into
          # pi-web-runtime-env through this list, so the broker unit and the
          # sandboxed session daemon see them without a separate PATH entry.
          # bubblewrap comes from nixpkgs-unstable (0.11.x/0.12.x line) and has
          # no setuid mode, so `--unshare-user` is the only privilege path — no
          # setuid-root helper to attack. Do not switch this to a setuid build.
          pkgs.bubblewrap
          pkgs.awscli2
          # aws_signing_helper: needed by the *broker* (never the sandbox) when
          # an allowlisted profile is an IAM RolesAnywhere `credential_process`
          # profile — `aws configure export-credentials` shells out to it, so
          # without this the profile resolves to "command not found".
          pkgs.aws-signing-helper
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
            pkgs.jq
            belayd-shell
            pkgs.gitMinimal
            pkgs.openssh # ssh-keygen for git SSH signing
          ];
          pathsToLink = [ "/bin" ];
        };

        # belayd-shell — one cwd-aware shell wrapper that resolves the project
        # devShell from $PWD. Both pi-web units set SHELL to this, and the
        # global settings.json shellPath points at it, so terminals, plugin
        # runCommand, workspace removal, the agent bash tool, and spawned
        # sub-agents all route through the same wrapper.
        #
        # The scripts are checked in under scripts/ and substituted here rather
        # than templated inline, so the in-repo unit tests can render them with
        # the exact same @placeholder@ substitution (keep flake.nix and the
        # test helper in sync). @realShell@ is ${pkgs.bash}/bin/bash — the same
        # bash derivation and version that pi-web-runtime-env links as
        # /bin/bash (and that the units previously used as SHELL), so it is
        # behaviorally identical. The indirect path through the env cannot be
        # referenced here: pi-web-runtime-env's paths include this derivation,
        # so depending on it would be recursive. The build writes its own store
        # shebang; the repo scripts keep a portable `#!/usr/bin/env bash`.
        belayd-shell = pkgs.runCommand "belayd-shell" { } ''
          mkdir -p "$out/bin"
          for script in belayd-shell belayd-shell-path-setup belayd-direnv-setup; do
            sed \
              -e 's|^#!/usr/bin/env bash$|#!${pkgs.bash}/bin/bash|' \
              -e 's|@realShell@|${pkgs.bash}/bin/bash|g' \
              -e 's|@jq@|${pkgs.jq}/bin/jq|g' \
              -e 's|@awsSandbox@|${belayd-harness}/bin/belayd-aws|g' \
              "${./scripts}/$script.sh" > "$out/bin/$script"
            chmod +x "$out/bin/$script"
          done
        '';

        # pi — the pi coding agent CLI, unconfigured (bare). Kept as the base
        # binary for the configured wrapper below and as an escape hatch.
        #
        # llm-agents was bumped e222bd1e -> 372f0337 (flake.lock) because
        # pi-agent-browser-native needs agent-browser >= 0.35 and Pi 1.0.0:
        # the old rev shipped agent-browser 0.33.1 + pi 0.83.0, the new one
        # ships agent-browser 0.38.2 + pi 1.0.2. This moved the pi base
        # 0.83.0 -> 1.0.2 and refreshed llm-agents' transitive pins
        # (nixpkgs, bun2nix, flake-parts).
        #
        # The lockfile's @earendil-works/pi-coding-agent@1.0.2 supplies the
        # dev/test types, so bump it in the same commit as any llm-agents/pi-bare
        # rev bump; otherwise the dev types and runtime drift apart.
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
        #
        # node_modules/ is built from this repo's own package.json + pnpm-lock.yaml,
        # so every `dependencies` entry is bundled automatically — no separate
        # npm manifest to keep in sync. peerDependencies are stripped before
        # install (pi bundles those itself) and devDependencies are skipped with
        # --prod. `hash` below is the only thing to refresh after changing
        # dependencies (the failed build prints the new value).
        belayd-harness = pkgs.stdenv.mkDerivation {
          pname = "belayd-harness";
          version = "0.0.1";
          src = ./.;
          nativeBuildInputs = [
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.jq
            pkgs.yq-go
            pkgs.sqlite
            pkgs.zstd
          ];
          # Fetch the pnpm content-addressable store for the full lockfile
          # (fixed-output, so it's reproducible and network runs in the fetch
          # phase only).
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "belayd-harness";
            version = "0.0.1";
            src = ./.;
            pnpm = pkgs.pnpm;
            fetcherVersion = 4;
            hash = "sha256-gxdGqSNzSWzWFFGW9jI7/x/zZit0oi9m3sL85DLDx7k=";
          };
          dontBuild = true;
          installPhase = ''
            runHook preInstall

            # stdenv sets HOME=/homeless-shelter (read-only); pnpm writes its
            # config/cache there, so give it a writable home first.
            export HOME="$(mktemp -d)"

            # Reconstruct the pnpm store shipped by fetchPnpmDeps (fetcherVersion 4
            # stores it as a zstd tarball plus a SQL dump of its index.db) so the
            # install below can run offline.
            store_path="$(mktemp -d)"
            tar --zstd -xf "$pnpmDeps/pnpm-store.tar.zst" -C "$store_path"
            chmod -R +w "$store_path"
            if [ -f "$store_path/v11/index.db.sql" ]; then
              sqlite3 "$store_path/v11/index.db" < "$store_path/v11/index.db.sql"
              rm "$store_path/v11/index.db.sql"
            fi
            pnpm config set store-dir "$store_path"
            pnpm config set package-import-method clone-or-copy
            # Same flags pnpmConfigHook sets: don't block on pnpm's own version
            # manager and skip the lockfile supply-chain-policy check, which would
            # otherwise try to fetch npm attestations from the network at build
            # time (the build phase is offline).
            export pnpm_config_pm_on_fail=ignore
            export pnpm_config_trust_lockfile=true

            # Install only `dependencies`. peerDependencies are bundled by the pi
            # runtime and devDependencies are never imported by the loaded
            # extension, so strip both from package.json AND from the lockfile's
            # importer (pnpm merges the root's peers into `dependencies` there),
            # keeping the two in sync so --frozen-lockfile still passes. Frozen
            # means no re-resolution, so the install works offline against the
            # store. Hoisted node-linker keeps node_modules flat (no symlinks).
            for p in $(jq -r '.peerDependencies // {} | keys[]' package.json); do
              yq -i "del(.importers[\".\"].dependencies[\"$p\"])" pnpm-lock.yaml
            done
            yq -i 'del(.importers["."].devDependencies)' pnpm-lock.yaml
            jq 'del(.peerDependencies, .devDependencies)' package.json > package.json.stripped
            mv package.json.stripped package.json
            pnpm install --offline --ignore-scripts --prod --frozen-lockfile --config.node-linker=hoisted

            # The manifest makes $out loadable as a pi *package*: consumers can
            # point a project/global settings entry or an extensions/ symlink at
            # this directory and pi reads pi.extensions from it, instead of every
            # consumer hand-listing extension files. Note that pi.skills points at
            # .agents/skills, which is deliberately NOT installed here — skills
            # stay owned by belayd-skills (~/.agents/skills), so a packages entry
            # should pass "skills": [] to avoid loading them twice.
            mkdir -p "$out/extensions" "$out/src" "$out/templates" "$out/node_modules" "$out/bin"
            install -m 0644 package.json "$out/package.json"
            # Metric queries live beside the extension and are read at runtime by
            # belayd_metrics, so the package output must carry them.
            mkdir -p "$out/metrics"
            cp -r metrics/. "$out/metrics/"
            cp -r extensions/. "$out/extensions/"
            cp -r src/. "$out/src/"
            # templates/ must stay a sibling of extensions/ so the bootstrap
            # extension resolves ../templates/bootstrap from the Nix store.
            cp -r templates/. "$out/templates/"
            cp -r node_modules/. "$out/node_modules/"
            # Drop pnpm's own metadata; pi only needs the flat package dirs
            # for module resolution.
            rm -rf "$out/node_modules/.pnpm" "$out/node_modules/.bin"
            rm -f "$out/node_modules/.modules.yaml" \
                  "$out/node_modules/.package-map.json" \
                  "$out/node_modules/.pnpm-workspace-state-v1.json"

            # AWS credential broker entry points (bd-125). Node 24 strips the
            # TypeScript types at load time, so these run straight from src/ and
            # the derivation needs no tsc step (dist/ stays a library-consumer
            # artifact only). `belayd-aws` is the CLI the shell wrapper and the
            # systemd broker unit call; `belayd-aws-credential-process` is the
            # shim botocore execs, generated into each scope dir.
            for entry in "belayd-aws:src/aws-broker/main.ts" \
                         "belayd-aws-broker:src/aws-broker/main.ts" \
                         "belayd-aws-credential-process:src/aws-broker/main.ts"; do
              name="''${entry%%:*}"
              file="''${entry#*:}"
              subcommand=""
              case "$name" in
                belayd-aws-broker) subcommand="daemon" ;;
                belayd-aws-credential-process) subcommand="credential-process" ;;
              esac
              {
                printf '#!%s\n' "${pkgs.bash}/bin/bash"
                if [ -n "$subcommand" ]; then
                  printf 'exec %s %s %s "$@"\n' "${pkgs.nodejs_24}/bin/node" "$out/$file" "$subcommand"
                else
                  printf 'exec %s %s "$@"\n' "${pkgs.nodejs_24}/bin/node" "$out/$file"
                fi
              } > "$out/bin/$name"
              chmod +x "$out/bin/$name"
            done

            runHook postInstall
          '';
        };

        # Third-party pi npm extensions (exa web search, ast-grep, vision,
        # plannotator, OpenRouter provider, agent-browser). Packaged as a Nix
        # node_modules tree so pi never needs a runtime `npm install` into
        # ~/.pi/agent/npm. Each package's `pi.extensions` entry is passed via
        # --extension below.
        pi-extensions = pkgs.buildNpmPackage {
          pname = "pi-extensions";
          version = "0.1.0";
          src = ./nix/pi-extensions;
          npmDepsHash = "sha256-BKydHW7WAmVfDt7sqX7NkUCN1jh2OJW7GgNBEM5iehU=";
          npmDepsFetcherVersion = 2;
          npmFlags = [ "--legacy-peer-deps" ];
          dontNpmBuild = true;
        };

        # Single source of truth for which pi extensions this repo loads, for
        # both consumers (this flake's `pi` wrapper and bin/pi). The lists used
        # to be hand-maintained in four places, which is how the repo dev loop
        # ended up with a different tool set than the baked binary.
        #
        # - harness entry points come from package.json `pi.extensions`;
        # - third-party entry points come from nix/pi-extensions/package.json
        #   `piExtensions` (package name -> entry path inside that package).
        piExtensionManifest = pkgs.lib.importJSON ./nix/pi-extensions/package.json;
        harnessPiManifest = pkgs.lib.importJSON ./package.json;
        thirdPartyExtensionsDir =
          "${pi-extensions}/lib/node_modules/pi-extensions/node_modules";
        harnessExtensionPaths = map (
          entry: "${belayd-harness}/${pkgs.lib.removePrefix "./" entry}"
        ) (harnessPiManifest.pi.extensions or [ ]);
        thirdPartyExtensionPaths = pkgs.lib.mapAttrsToList (
          name: entryPath: "${thirdPartyExtensionsDir}/${name}/${entryPath}"
        ) (piExtensionManifest.piExtensions or { });

        # Directory artifact for the pi-web orchestrator, which discovers
        # extensions from ~/.pi/agent/extensions/ instead of taking explicit
        # --extension flags. pi's discovery reads package.json `pi.extensions`
        # at the directory root, so this exposes the whole
        # pi-agent-browser-native package: the entry
        # (dist/extensions/agent-browser/index.js) has relative imports into
        # dist/scripts and its own lib/, and resolves its runtime deps
        # (cross-spawn, which, …) from the sibling node_modules tree. NixOS
        # symlinks ~/.pi/agent/extensions/pi-agent-browser at this store path.
        pi-agent-browser-extension = pkgs.runCommand "pi-agent-browser-extension" { } ''
          pkg="${pi-extensions}/lib/node_modules/pi-extensions/node_modules/pi-agent-browser-native"
          mkdir -p "$out"
          # Fail loudly if a future version drops an expected path, instead of
          # leaving a dangling symlink in the store.
          test -f "$pkg/package.json" || { echo "pi-agent-browser-extension: missing file $pkg/package.json" >&2; exit 1; }
          test -d "$pkg/dist" || { echo "pi-agent-browser-extension: missing dir $pkg/dist" >&2; exit 1; }
          test -d "$pkg/scripts" || { echo "pi-agent-browser-extension: missing dir $pkg/scripts" >&2; exit 1; }
          ln -s "$pkg/package.json" "$out/package.json"
          ln -s "$pkg/dist" "$out/dist"
          ln -s "$pkg/scripts" "$out/scripts"
          # Preserve dependency resolution if a loader follows the symlink
          # (preserveSymlinks) rather than the realpath into pi-extensions.
          ln -s "${pi-extensions}/lib/node_modules/pi-extensions/node_modules" "$out/node_modules"
        '';

        # pi configured via pi.nix's mkCodingAgent: harness + npm extensions,
        # skills, and the LLM Gateway models all baked into one binary. The only
        # global pi state left is ~/.pi/agent/auth.json (credentials), plus
        # sessions and the wrapper-managed models.json/settings.json.
        belayd-pi = pi-nix.lib.mkCodingAgent {
          inherit pkgs;
          modules = [
            {
              pi.coding-agent = {
                # Keep the llm-agents pi build as the base binary; pi.nix only
                # supplies the wrapper-generation logic here (no pi.cachix.org).
                package = pi-bare;
                extensions =
                  harnessExtensionPaths
                  ++ thirdPartyExtensionPaths;
                skills = [ belayd-skills ];
                models = ./models.json;
                settings = {
                  defaultProvider = "llmgateway";
                  defaultModel = "deepseek-v4.1-flash";
                  defaultThinkingLevel = "high";
                  theme = "dark";
                };
                # -ne disables extension auto-discovery (global dirs, the
                # settings `extensions`/`packages` arrays, and project
                # .pi/settings.json) and pi's built-in extensions (explicit -e
                # paths still work), so the only extensions that load are the
                # explicit --extension flags above. This is the same trick as
                # bin/pi: it makes the binary self-contained and immune to
                # leftover global config double-loading the same tools.
                extraArgs = [ "-ne" ];
              };
            }
          ];
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
          # Fold bd-47: point the agent bash tool (and every spawned sub-agent
          # that reads global settings) at the devShell wrapper. Idempotent and
          # non-clobbering; a corrupt settings.json must not block interactive
          # pi, so ignore the helper's exit status here.
          ${belayd-shell}/bin/belayd-shell-path-setup \
            --shell ${belayd-shell}/bin/belayd-shell || true
          exec ${belayd-pi.package}/bin/pi "$@"
        '';

        # dockerTools.buildLayeredImage inherits `isExe = true` from its inner
        # streamLayeredImage even though its output is a plain tarball. Arion
        # keys off that flag to decide between executing the image and
        # `docker load`-ing it, so reset it to keep the tarball semantics.
        tarballImage =
          args:
          (pkgs.dockerTools.buildLayeredImage args).overrideAttrs (
            final: prev: {
              passthru = (prev.passthru or { }) // {
                isExe = false;
              };
            }
          );

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
              # Node and git inside an image with no /etc/ssl setup need an explicit
              # trust store; without it scotty's release check fails with
              # "unable to get local issuer certificate".
              "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
              # Reached under an arbitrary LAN/host hostname (host networking);
              # scotty 0.3.1+ otherwise refuses those Host headers. `*` relaxes
              # the hostname check only — cross-site writes stay refused.
              "SCOTTY_ALLOWED_HOSTS=*"
              # Empty token = upstream's operator-level opt-out of PostHog
              # `app_active` reporting (see arion-compose.nix).
              "POSTHOG_KEY="
            ];
            Cmd = [
              "scotty"
              "--host"
              "0.0.0.0"
              "--port"
              "7687"
              "--no-open"
            ];
          };
        };

      in
      {
        # Curated dev-tool set, exposed so sibling repos can splice it into
        # their own devShells:
        #
        #   packages = [ ... ] ++ agent-harness.devShellTools.${system};
        #
        # It is a plain list rather than a buildEnv so consumers keep control of
        # PATH order, and can filter entries whose versions they pin themselves.
        # Note that this list carries nodejs_24 and pnpm, which will shadow a
        # repo that pins nodejs_22 unless the consumer filters them out.
        inherit devShellTools;

        packages = {
          inherit
            bead-me-up-scotty
            pi-web
            scotty-image
            pi-web-runtime-env
            pi
            pi-bare
            pi-extensions
            pi-agent-browser-extension
            belayd-pi
            belayd-skills
            belayd-harness
            belayd-shell
            archify
            ;
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
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS="1"
            # Stable path to the upstream agent skill, schemas, examples, and
            # references bundled with the pinned archify release.
            export ARCHIFY_HOME="${archify}/libexec/archify"
            # Local pi wrapper (bin/pi): spawned belayd agents resolve their pi
            # binary via this var (src/spawn.ts) and would otherwise pick the
            # global /run/current-system/sw/bin/pi and dual-load extensions.
            export PI_BINARY_PATH="''${PWD}/bin/pi"
            # Third-party pi extensions resolve from the Nix-built tree, so
            # bin/pi never fetches from the npm registry at startup.
            export BELAYD_PI_EXTENSIONS_DIR="${thirdPartyExtensionsDir}"
          '';
        };
      }
    );
}
