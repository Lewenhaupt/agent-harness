import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * Regression guard for bd-88: the pi-web host rejects browser plugins whose
 * apiVersion it does not accept. The accepted versions are read from the
 * installed host contract rather than hardcoded, so a future host bump (e.g.
 * dropping legacy v4) fails this test until the plugin is migrated too.
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
const { default: serverPlugin } = await import("./server-plugin.js");

// Resolve from this test file so the test is invariant to the vitest cwd.
const testDir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(testDir, "package.json"), "utf8"));
const hostDist = join(testDir, "..", "..", "node_modules", "@jmfederico", "pi-web", "dist");
const hostPluginApiTypes = join(hostDist, "plugin-api.d.ts");

/**
 * Body of an `export interface <name> {` block, brace-counted so nested type
 * literals cannot truncate it. Returns null when the interface is absent.
 */
function interfaceBody(source, interfaceName) {
  const declaration = new RegExp(`export interface ${interfaceName}\\s*\\{`);
  const start = source.search(declaration);
  if (start === -1) {
    return null;
  }
  const openBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, index + 1);
      }
    }
  }
  return null;
}

/**
 * Browser plugin apiVersions the installed host accepts, parsed from the host's
 * public `PiWebPlugin` contract. pi-web 1.202610.5 made that a union of the
 * current interface and a deprecated legacy one, so membership — not equality —
 * is what a plugin must satisfy. Throws (rather than skipping) when the
 * artifact is missing or its shape changes, so the test cannot silently pass.
 */
/**
 * apiVersions of the members of an `export type <union> = A | B;` host
 * contract. The browser contract is a union, so membership — not equality — is
 * what a plugin must satisfy; the same reader serves the server contract.
 */
function acceptedApiVersions(declarationFile, unionName) {
  const path = join(hostDist, declarationFile);
  const source = readFileSync(path, "utf8");
  const union = source.match(new RegExp(`export type ${unionName}\\s*=\\s*([^;]+);`));
  if (union === null || union[1] === undefined) {
    throw new Error(`could not find the ${unionName} union in ${path}`);
  }
  const memberNames = union[1]
    .split("|")
    .map((member) => member.trim())
    .filter((member) => member !== "");
  if (memberNames.length === 0) {
    throw new Error(`${unionName} union has no members in ${path}`);
  }
  return memberNames.map((memberName) => {
    const body = interfaceBody(source, memberName);
    if (body === null) {
      throw new Error(`could not find ${unionName} member ${memberName} in ${path}`);
    }
    const version = body.match(/apiVersion:\s*(\d+)/);
    if (version === null || version[1] === undefined) {
      throw new Error(`could not find apiVersion in ${memberName} (${path})`);
    }
    return Number(version[1]);
  });
}

function installedBrowserApiVersions() {
  return acceptedApiVersions("plugin-api.d.ts", "PiWebPlugin");
}

describe("proof-of-work pi-web plugin manifest", () => {
  it("declares a browser plugin apiVersion the installed host accepts", () => {
    expect(installedBrowserApiVersions()).toContain(plugin.apiVersion);
  });

  it("declares a server plugin apiVersion the installed host accepts", () => {
    expect(acceptedApiVersions("server-plugin-api.d.ts", "PiWebServerPlugin")).toContain(
      serverPlugin.apiVersion,
    );
  });

  it("is registered as a machine-specific plugin with a server entry", () => {
    const entry = manifest.piWeb.plugins.find((candidate) => candidate.id === "proof-of-work");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      browserRoot: ".",
      module: "pi-web-plugin.js",
      serverModule: "server-plugin.js",
      machineSpecific: true,
    });
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
