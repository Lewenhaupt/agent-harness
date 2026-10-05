import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * Regression guard for bd-88: the pi-web host hard-rejects browser plugins
 * whose apiVersion does not match the host's. The expected version is read
 * from the installed host contract rather than hardcoded, so a future host
 * bump (e.g. 4 -> 5) fails this test until the plugin is migrated too.
 *
 * pi-web-plugin.js imports panel.js, whose class body reads HTMLElement while
 * the module is evaluated, so the browser globals are stubbed before the
 * dynamic import. Import order matters: the static vitest imports above must
 * not pull in the plugin entry.
 */
vi.stubGlobal("HTMLElement", class {});
vi.stubGlobal("customElements", {
  get: () => undefined,
  define: () => {},
});

const { default: plugin } = await import("./pi-web-plugin.js");

// Resolve from this test file so the test is invariant to the vitest cwd.
const testDir = dirname(fileURLToPath(import.meta.url));
const hostPluginApiTypes = join(
  testDir,
  "..",
  "..",
  "node_modules",
  "@jmfederico",
  "pi-web",
  "dist",
  "plugin-api.d.ts",
);

/**
 * Browser plugin apiVersion the installed host accepts, parsed from the host's
 * public `PiWebPlugin` contract. Throws (rather than skipping) when the
 * artifact is missing or its shape changes, so the test cannot silently pass.
 */
function installedBrowserApiVersion() {
  const source = readFileSync(hostPluginApiTypes, "utf8");
  const match = source.match(/interface PiWebPlugin\s*\{[^}]*?apiVersion:\s*(\d+)/);
  if (match === null || match[1] === undefined) {
    throw new Error(`could not find PiWebPlugin.apiVersion in ${hostPluginApiTypes}`);
  }
  return Number(match[1]);
}

describe("proof-of-work pi-web plugin manifest", () => {
  it("declares the browser plugin apiVersion the installed host accepts", () => {
    expect(plugin.apiVersion).toBe(installedBrowserApiVersion());
  });

  it("registers the proof-of-work workspace panel and action", () => {
    const result = plugin.activate({
      runtimePluginId: "proof-of-work",
      html: () => undefined,
      svg: () => undefined,
    });

    expect(result.contributions.actions.map((action) => action.id)).toEqual([
      "workspace.open-proof-of-work",
    ]);
    expect(result.contributions.workspacePanels.map((panel) => panel.id)).toEqual([
      "workspace.proof-of-work",
    ]);
  });
});
