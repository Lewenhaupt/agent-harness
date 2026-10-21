/**
 * Entry-point detection for the broker CLI files (bd-125).
 *
 * `main.ts` and `client.ts` are both executed directly by Node 24's native
 * type stripping (the Nix wrappers, and the generated per-scope shim), and both
 * are also imported as modules by other files. The guard has to survive Nix
 * wrappers and symlinked store paths, so it compares the resolved module path
 * rather than requiring byte equality.
 */

import { fileURLToPath } from "node:url";

/** True when `argvEntry` is the script Node is running for `moduleUrl`. */
export function isEntrypoint(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (argvEntry === undefined || argvEntry === "") return false;
  // `fileURLToPath`, not `new URL(...).pathname`: a percent-escaped or
  // non-ASCII path would otherwise never compare equal, silently disabling the
  // guard and turning the entry point into a no-op when executed directly.
  const modulePath = fileURLToPath(moduleUrl);
  return argvEntry === modulePath || argvEntry.endsWith(modulePath);
}
