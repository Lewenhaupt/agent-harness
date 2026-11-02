import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * Manifest and entry-point guard for the durable-member pi-web plugin.
 *
 * The accepted browser and server apiVersions are parsed from the installed host
 * contracts rather than hardcoded, so a pi-web bump that drops a version fails
 * this test until the plugin is migrated (the same guard shape proof-of-work
 * uses for the browser contract).
 *
 * panel.js defines a custom element extending HTMLElement at module scope, so
 * the browser globals are stubbed before the dynamic import.
 */
vi.stubGlobal("HTMLElement", class {});
vi.stubGlobal("customElements", {
  get: () => undefined,
  define: () => {},
});

const { default: plugin } = await import("./pi-web-plugin.js");
const { default: serverPlugin } = await import("./server-plugin.js");
const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"));

const testDir = dirname(fileURLToPath(import.meta.url));
const hostDist = join(testDir, "..", "..", "node_modules", "@jmfederico", "pi-web", "dist");

/** Body of an `export interface <name> {` block, brace-counted. */
function interfaceBody(source, interfaceName) {
  const declaration = new RegExp(`export interface ${interfaceName}\\s*\\{`);
  const start = source.search(declaration);
  if (start === -1) return null;
  const openBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace, index + 1);
    }
  }
  return null;
}

/** apiVersions in an `export type <union> = A | B;` contract. */
function acceptedApiVersions(declarationFile, unionName) {
  const source = readFileSync(join(hostDist, declarationFile), "utf8");
  const union = source.match(new RegExp(`export type ${unionName}\\s*=\\s*([^;]+);`));
  if (union === null || union[1] === undefined) {
    throw new Error(`could not find the ${unionName} union in ${declarationFile}`);
  }
  const members = union[1]
    .split("|")
    .map((member) => member.trim())
    .filter((member) => member !== "");
  if (members.length === 0) throw new Error(`${unionName} union has no members`);
  return members.map((memberName) => {
    const body = interfaceBody(source, memberName);
    if (body === null) throw new Error(`could not find ${unionName} member ${memberName}`);
    const version = body.match(/apiVersion:\s*(\d+)/);
    if (version === null || version[1] === undefined) {
      throw new Error(`could not find apiVersion in ${memberName}`);
    }
    return Number(version[1]);
  });
}

describe("durable-member pi-web plugin manifest", () => {
  it("declares a browser apiVersion the installed host accepts", () => {
    expect(acceptedApiVersions("plugin-api.d.ts", "PiWebPlugin")).toContain(plugin.apiVersion);
  });

  it("declares a server apiVersion the installed host accepts", () => {
    expect(acceptedApiVersions("server-plugin-api.d.ts", "PiWebServerPlugin")).toContain(
      serverPlugin.apiVersion,
    );
  });

  it("is registered as a machine-specific plugin with both entries", () => {
    const entry = manifest.piWeb.plugins.find((candidate) => candidate.id === "durable-member");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      browserRoot: ".",
      module: "pi-web-plugin.js",
      serverModule: "server-plugin.js",
      machineSpecific: true,
    });
  });

  it("registers the durable-member workspace panel and action", () => {
    const result = plugin.activate({
      runtimePluginId: "durable-member",
      html: () => undefined,
      svg: () => undefined,
    });

    expect(result.contributions.actions.map((action) => action.id)).toEqual([
      "workspace.open-durable-member",
    ]);
    expect(result.contributions.workspacePanels.map((panel) => panel.id)).toEqual([
      "workspace.durable-member",
    ]);
  });

  it("activates a server peer with read requests and a watch channel", () => {
    const activation = serverPlugin.activate({
      apiVersion: 5,
      pluginId: "durable-member",
      packageRoot: testDir,
      dataDirectory: join(testDir, ".tmp-data-directory"),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      settings: {},
      execFile: () => Promise.reject(new Error("not used")),
      signal: new AbortController().signal,
      lifetimeSignal: new AbortController().signal,
    });

    expect(activation.peer).toBeDefined();
    expect(typeof activation.peer.request).toBe("function");
    expect(typeof activation.peer.openChannel).toBe("function");
  });
});
