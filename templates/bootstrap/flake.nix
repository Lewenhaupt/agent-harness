{
  description = "__PROJECT_NAME__ — pnpm + turbo monorepo devShell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";
  inputs.systems.url = "github:nix-systems/default";
  # Make flake-utils honour this flake's systems list instead of carrying a
  # second, unused copy of it.
  inputs.flake-utils.inputs.systems.follows = "systems";
  inputs.beads.url = "github:gastownhall/beads";
  # agent-harness's own inputs (llm-agents, pi-nix, …) are left to follow their
  # upstream pins rather than being overridden here: this flake only consumes
  # `agent-harness.packages.<sys>.pi`, and forcing llm-agents to follow would
  # couple the scaffold to harness internals that may change.
  inputs.agent-harness.url = "github:Lewenhaupt/agent-harness";

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      beads,
      agent-harness,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            # Node.js and package manager
            pkgs.nodejs_22
            pkgs.pnpm

            # TypeScript
            pkgs.typescript

            # Linting and formatting
            pkgs.biome

            # Task management — bd plus the Dolt server it talks to
            beads.packages.${system}.default
            pkgs.dolt
            # bd's Dolt-server liveness check runs `ps -axo`
            pkgs.procps

            # Worktree manager the harness shells out to
            pkgs.worktrunk

            # Configured pi coding agent with the harness baked in
            agent-harness.packages.${system}.pi

            # libstdc++ shared library for native node modules
            pkgs.stdenv.cc.cc.lib
          ];

          shellHook = ''
            # Make libstdc++ available to native node modules (file watchers, etc.)
            export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

            # Turborepo's local cache lives at <repo-root>/.turbo/cache, so every
            # git worktree — and every agent working in one — starts cold even
            # though the inputs are identical. One content-addressed directory
            # outside the tree makes them share artifacts instead.
            #
            # This is deliberately not Vercel Remote Cache: a hash is derived from
            # the inputs, so a shared directory is safe to write concurrently, and
            # it needs no token, no network and no secret on disk. `turbo login`
            # cannot even complete on a headless host — it waits for an OAuth
            # redirect on a local callback server. Set TURBO_CACHE_DIR yourself to
            # override the location; CI has no worktrees and keeps its own cache.
            export TURBO_CACHE_DIR="''${TURBO_CACHE_DIR:-''${XDG_CACHE_HOME:-$HOME/.cache}/turbo/__PROJECT_NAME__}"
          '';
        };
      }
    );
}
