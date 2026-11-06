import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseProofReceipt, readProofReceipt, writeProofReceipt } from "../proof-receipt.js";
import {
  openRepoStateStore,
  REPO_STATE_FILE_ENV,
  type RepoStateStore,
  resetRepoStatePaths,
  resetSharedRepoStateStore,
} from "../repo-state-store.js";
import { GIT_CONTEXT_ENV_KEYS, gitContextFreeEnv } from "../worktree-list.js";

/**
 * Cross-component parity for the proof receipt (bd-303).
 *
 * The pi-web plugin is plain JS and cannot import TypeScript, so it reads the
 * receipt row from the shared store itself and re-implements the shape rules in
 * `discovery.js`. The retired `.belayd/proof-receipt.json` made that mirror
 * cheap to get wrong silently; this test writes a receipt through the
 * TypeScript contract, reads it through the plugin's reader, and drives both
 * shape validators over the same cases, so a drifted mirror fails here instead
 * of shipping a panel that hides a receipt the gate accepts.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const pluginDir = join(repoRoot, "pi-web-plugins", "proof-of-work");

const VALID_URL = "https://proof.example.com/uploads/bd-303";
const VALID_ID = "upload-42";

interface MirrorStore {
  readonly readOnly: true;
  readonly path: string;
  readBoundTaskId(worktreePath: string): string | null;
  readReceipt(taskId: string): { payload: string; updatedAt: number } | null;
  close(): void;
}

interface MirrorStoreModule {
  openProofReceiptReader(options: { path: string }): {
    ok: boolean;
    error?: string;
    store?: MirrorStore;
  };
}

type MirrorReceiptResult =
  | { kind: "none" }
  | { kind: "invalid"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "receipt"; receipt: unknown };

interface MirrorDiscoveryModule {
  resolveProofReceipt(peer: unknown): Promise<MirrorReceiptResult>;
}

interface MirrorServerModule {
  GIT_CONTEXT_ENV_KEYS: readonly string[];
  createProofOfWorkPeer(
    context: unknown,
    overrides: unknown,
  ): { request(input: unknown): Promise<MirrorReceiptResult> };
}

/** A plugin server peer whose git probe reports `commonDir` for any workspace. */
async function serverPeerFor(
  commonDir: string,
): Promise<{ request(input: unknown): Promise<MirrorReceiptResult> }> {
  const server = await importMirror<MirrorServerModule>("server-plugin.js");
  return server.createProofOfWorkPeer(
    {
      execFile: async () => ({
        exitCode: 0,
        signal: null,
        stdout: `${commonDir}\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    },
    { env: {} },
  );
}

function workspaceRequest(workspacePath: string): unknown {
  return {
    operation: "receipt",
    scope: {
      kind: "workspace",
      project: { id: "project-1" },
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        path: workspacePath,
        label: "ws",
        isMain: true,
      },
    },
    input: {},
    signal: new AbortController().signal,
  };
}

/**
 * Import a plain-JS mirror. The file URL keeps Vite from bundling it, and the
 * native-require fallback covers runners whose dynamic import refuses a variable
 * file URL (Node >= 22.12 loads ESM through require()).
 */
async function importMirror<T>(fileName: string): Promise<T> {
  const absolute = join(pluginDir, fileName);
  try {
    return (await import(/* @vite-ignore */ pathToFileURL(absolute).href)) as T;
  } catch {
    return createRequire(import.meta.url)(absolute) as T;
  }
}

/** A plugin peer that answers the receipt operation with one stored payload. */
function peerReturning(payload: string): unknown {
  return {
    request: async (operation: string) => {
      expect(operation).toBe("receipt");
      return { kind: "receipt", payload, updatedAt: 20 };
    },
  };
}

const dirs: string[] = [];
const stores: RepoStateStore[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-proof-parity-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const opened of stores.splice(0)) {
    try {
      opened.close();
    } catch {
      // Already closed by the test.
    }
  }
  resetSharedRepoStateStore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("proof receipt parity: stored row", () => {
  it("reads a receipt written by writeProofReceipt through the plugin reader", async () => {
    const dir = makeDir();
    const storePath = join(dir, "state.sqlite");
    const opened = openRepoStateStore({ path: storePath });
    if (!opened.ok) throw new Error(opened.error);
    stores.push(opened.store);
    const worktreePath = "/ws/bd-303";
    const receipt = { version: 1 as const, taskId: "bd-303", id: VALID_ID, url: VALID_URL };

    opened.store.writeWorkflow({
      state: {
        taskId: "bd-303",
        workflowType: "refactor",
        branch: "feat/bd-303",
        originalCwd: worktreePath,
        phaseOrder: ["scout", "plan"],
        completedPhaseNames: [],
        startedAt: 1_000,
        updatedAt: 1_000,
      },
      worktreePath,
    });
    expect(writeProofReceipt({ cwd: dir, store: opened.store, receipt })).toStrictEqual({
      ok: true,
      taskId: "bd-303",
    });

    const mirrorModule = await importMirror<MirrorStoreModule>("store-reader.js");
    const mirrorOpened = mirrorModule.openProofReceiptReader({ path: storePath });
    expect(mirrorOpened.ok).toBe(true);
    if (!mirrorOpened.ok || mirrorOpened.store === undefined) {
      throw new Error(mirrorOpened.error ?? "plugin reader did not open");
    }
    const mirror = mirrorOpened.store;
    expect(mirror.readOnly).toBe(true);

    // The worktree -> task id locator is what lets the panel answer without
    // being told the bead.
    expect(mirror.readBoundTaskId(worktreePath)).toBe("bd-303");
    const row = mirror.readReceipt("bd-303");
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(JSON.parse(row.payload)).toStrictEqual(parseProofReceipt(receipt));
    expect(row.updatedAt).toBeGreaterThan(0);
    expect(mirror.readReceipt("bd-missing")).toBeNull();
    mirror.close();
  });
});

describe("proof receipt parity: shape rules", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["an https url", { version: 1, taskId: "bd-303", url: VALID_URL }],
    ["an id", { version: 1, taskId: "bd-303", id: VALID_ID }],
    ["both references", { version: 1, taskId: "bd-303", id: VALID_ID, url: VALID_URL }],
    ["a padded task id", { version: 1, taskId: "  bd-303  ", url: VALID_URL }],
    [
      "an upload timestamp and artifact count",
      { version: 1, taskId: "bd-303", url: VALID_URL, uploadedAt: "2026-11-06", artifactCount: 3 },
    ],
    ["a plain-http url", { version: 1, taskId: "bd-303", url: "http://proof.example.com/x" }],
    ["a short id", { version: 1, taskId: "bd-303", id: "u-1" }],
    ["a prose id", { version: 1, taskId: "bd-303", id: "done" }],
    ["no reference", { version: 1, taskId: "bd-303" }],
    ["an unknown key", { version: 1, taskId: "bd-303", url: VALID_URL, proof: "x" }],
    ["a wrong version", { version: 2, taskId: "bd-303", url: VALID_URL }],
    ["an empty task id", { version: 1, taskId: "  ", url: VALID_URL }],
    [
      "a negative artifact count",
      { version: 1, taskId: "bd-303", url: VALID_URL, artifactCount: -1 },
    ],
    ["a null document", null],
    ["an array document", []],
  ];

  it("accepts and rejects exactly what the zod schema does", async () => {
    const discovery = await importMirror<MirrorDiscoveryModule>("discovery.js");

    for (const [name, raw] of cases) {
      const typed = parseProofReceipt(raw);
      const mirrored = await discovery.resolveProofReceipt(peerReturning(JSON.stringify(raw)));

      expect(mirrored.kind === "receipt", `${name} (accept)`).toBe(typed !== undefined);
      if (typed === undefined) {
        expect(mirrored.kind, `${name} (rejection kind)`).toBe("invalid");
      } else if (mirrored.kind === "receipt") {
        expect(mirrored.receipt, `${name} (value)`).toStrictEqual(typed);
      }
    }
  });

  it("treats an unparseable stored payload as invalid", async () => {
    const discovery = await importMirror<MirrorDiscoveryModule>("discovery.js");

    expect(await discovery.resolveProofReceipt(peerReturning("{not json"))).toStrictEqual({
      kind: "invalid",
      detail: "proof receipt is not valid JSON",
    });
  });
});

describe("proof receipt parity: failure modes", () => {
  it("reads a repository whose store file was never created as no receipt on both sides", async () => {
    const dir = makeDir();
    const commonDir = join(dir, ".git");
    execFileSync("git", ["init", "-q"], { cwd: dir, env: gitContextFreeEnv(), stdio: "pipe" });
    const storePath = join(commonDir, "belayd", "state.sqlite");
    expect(existsSync(storePath)).toBe(false);

    // Plugin side: the store is absent, and reading the absence must not create
    // the file (the reader has no write path).
    const peer = await serverPeerFor(commonDir);
    expect(await peer.request(workspaceRequest(dir))).toStrictEqual({ kind: "none" });
    expect(existsSync(storePath)).toBe(false);

    // Harness side: resolved from `cwd` alone, with no path override and no
    // injected store, so `receiptStoreFor` probes git and the shared store's own
    // open (which creates the dir and schema) is what runs here.
    const savedOverride = process.env[REPO_STATE_FILE_ENV];
    delete process.env[REPO_STATE_FILE_ENV];
    resetRepoStatePaths();
    resetSharedRepoStateStore();
    try {
      expect(readProofReceipt({ cwd: dir, taskId: "bd-303" })).toStrictEqual({
        ok: true,
        receipt: undefined,
      });
    } finally {
      if (savedOverride === undefined) delete process.env[REPO_STATE_FILE_ENV];
      else process.env[REPO_STATE_FILE_ENV] = savedOverride;
      resetSharedRepoStateStore();
      resetRepoStatePaths();
    }

    // The absence was resolved to the identical file both sides use, and only
    // the harness's open created it.
    expect(existsSync(storePath)).toBe(true);
  });

  it("unsets exactly the git-context keys the harness strips", async () => {
    const server = await importMirror<MirrorServerModule>("server-plugin.js");

    // Both probes must ignore the same inherited GIT_* variables, or the plugin
    // could read another repository's store.
    expect(server.GIT_CONTEXT_ENV_KEYS).toStrictEqual(GIT_CONTEXT_ENV_KEYS);
  });
});

describe("proof receipt parity: SYNC WARNING markers", () => {
  it("keeps both sides of every mirrored contract marked", () => {
    const pairs = [
      ["src/proof-receipt.ts", "pi-web-plugins/proof-of-work/discovery.js"],
      ["src/repo-state-store.ts", "pi-web-plugins/proof-of-work/store-reader.js"],
      ["src/repo-state-store.ts", "pi-web-plugins/proof-of-work/server-plugin.js"],
      ["src/worktree-list.ts", "pi-web-plugins/proof-of-work/server-plugin.js"],
    ] as const;
    for (const [typescriptSide, pluginSide] of pairs) {
      const tsSource = readFileSync(join(repoRoot, typescriptSide), "utf8");
      const pluginSource = readFileSync(join(repoRoot, pluginSide), "utf8");
      expect(tsSource, typescriptSide).toContain("SYNC WARNING");
      expect(pluginSource, pluginSide).toContain("SYNC WARNING");
    }
  });
});
