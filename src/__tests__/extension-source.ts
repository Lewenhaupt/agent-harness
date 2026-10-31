import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repo root from this file's location (src/__tests__ -> repo root)
// so the guard is invariant to the Vitest working directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The harness extension source as one string: the composer plus every
 * capability module it registers (bd-179).
 *
 * Source-level assertions ("is this wired?") must cover the whole extension. A
 * capability that moved into `extensions/capabilities/` would otherwise stop
 * being guarded while every behavioral test stayed green, which is exactly the
 * failure mode those assertions exist to catch.
 */
export function readExtensionSource(): string {
  const entry = readFileSync(join(repoRoot, "extensions/index.ts"), "utf8");
  const capabilityDir = join(repoRoot, "extensions/capabilities");
  const capabilities = readdirSync(capabilityDir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => readFileSync(join(capabilityDir, name), "utf8"));
  return [entry, ...capabilities].join("\n");
}
