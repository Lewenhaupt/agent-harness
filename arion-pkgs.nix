# Nixpkgs bootstrap for arion. Arion evaluates this file (or the `--pkgs`
# expression) first, to obtain the pkgs attrset used by its module system.
#
# Reuse the nixpkgs pinned in flake.lock so arion and the flake images are
# built against the same package set.
(builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.${builtins.currentSystem}
