/**
 * Unit tests for the proof receipt contract (bd-181).
 *
 * Parsing, serialization, formatting and output scanning are pure, so they are
 * tested data-in/assert-return-value. The two store helpers take an opened
 * in-memory-path store (bd-281: the receipt is a `proof_receipt` row keyed by
 * task id), so no real repository is touched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findProofReceiptRefs,
  formatProofReceipt,
  isProofReceiptUrl,
  PROOF_RECEIPT_VERSION,
  type ProofReceipt,
  parseProofReceipt,
  readProofReceipt,
  serializeProofReceipt,
  writeProofReceipt,
} from "../proof-receipt.js";
import {
  openRepoStateStore,
  REPO_STATE_FILE_ENV,
  type RepoStateStore,
  resetRepoStatePaths,
  resetSharedRepoStateStore,
  resolveRepoStatePath,
  sharedRepoStateStore,
} from "../repo-state-store.js";
import type { SqliteDatabaseLike } from "../sqlite-store-open.js";
import { gitContextFreeEnv } from "../worktree.js";

const VALID_URL = "https://proof.example.com/uploads/bd-181";
const HTTP_URL = "http://proof.example.com/uploads/bd-181";

/** The first directory at or above `start` that carries a repository marker. */
function gitMarkerAtOrAbove(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * A scratch root with no `.git` anywhere above it, so a directory inside it
 * really is "not a repository". When the environment cannot provide one (a
 * TMPDIR inside a repository) the test fails loudly: skipping would silently
 * drop coverage of the absence branch.
 */
function createCleanScratchRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const marker = gitMarkerAtOrAbove(root);
  if (marker === undefined) return root;
  rmSync(root, { recursive: true, force: true });
  throw new Error(
    `cannot test repository absence: ${root} is inside a git repository ` +
      `(found ${join(marker, ".git")}). Point TMPDIR at a directory outside any repository.`,
  );
}

/** Run git in `cwd` with the ambient git-context variables stripped. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitContextFreeEnv(),
    timeout: 10_000,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

/** A real repository with one commit and a linked second worktree. */
function initRepoWithWorktree(root: string): { repo: string; second: string } {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const second = join(root, "second-worktree");
  git(repo, ["worktree", "add", "-q", second]);
  return { repo, second };
}

describe("isProofReceiptUrl", () => {
  it("accepts an absolute https upload URL", () => {
    expect(isProofReceiptUrl(VALID_URL)).toBe(true);
  });

  it("rejects a plain-http upload URL: the published contract is https-only", () => {
    expect(isProofReceiptUrl(HTTP_URL)).toBe(false);
    // No localhost/dev exception: the gate accepts the weakest evidence it can
    // name, and the contract names https.
    expect(isProofReceiptUrl("http://localhost:3000/uploads/bd-181")).toBe(false);
  });
});

describe("parseProofReceipt", () => {
  it("accepts a URL-only receipt and normalizes whitespace", () => {
    expect(parseProofReceipt({ version: 1, taskId: "  bd-181  ", url: VALID_URL })).toStrictEqual({
      version: 1,
      taskId: "bd-181",
      url: VALID_URL,
    });
  });

  it("accepts an id-only receipt", () => {
    expect(parseProofReceipt({ version: 1, taskId: "bd-181", id: "upload-42" })).toStrictEqual({
      version: 1,
      taskId: "bd-181",
      id: "upload-42",
    });
  });

  it("carries optional metadata through", () => {
    const receipt = {
      version: 1,
      taskId: "bd-181",
      id: "upload-42",
      url: VALID_URL,
      uploadedAt: "2026-11-01T09:00:00Z",
      artifactCount: 3,
    };
    expect(parseProofReceipt(receipt)).toStrictEqual(receipt);
  });

  it.each([
    ["a receipt with neither id nor url", { version: 1, taskId: "bd-181" }],
    ["a newer schema version", { version: 2, taskId: "bd-181", url: VALID_URL }],
    ["a missing task id", { version: 1, url: VALID_URL }],
    ["an empty task id", { version: 1, taskId: "   ", url: VALID_URL }],
    ["an empty id", { version: 1, taskId: "bd-181", id: "" }],
    ["a prose id", { version: 1, taskId: "bd-181", id: "done" }],
    ["a short id", { version: 1, taskId: "bd-181", id: "u-1" }],
    ["a relative url", { version: 1, taskId: "bd-181", url: "proof.example.com/x" }],
    ["a url without a path", { version: 1, taskId: "bd-181", url: "https://proof.example.com" }],
    ["a non-http url", { version: 1, taskId: "bd-181", url: "ftp://proof.example.com/x" }],
    // https only: the proof prompt and docs/proof-verifier.md both promise that a
    // plain-http URL is not accepted, so a stored receipt must reject it too.
    ["a plain-http url", { version: 1, taskId: "bd-181", url: HTTP_URL }],
    ["a non-string id", { version: 1, taskId: "bd-181", id: 42 }],
    [
      "a negative artifact count",
      { version: 1, taskId: "bd-181", url: VALID_URL, artifactCount: -1 },
    ],
    [
      "a fractional artifact count",
      { version: 1, taskId: "bd-181", url: VALID_URL, artifactCount: 1.5 },
    ],
    [
      "a string artifact count",
      { version: 1, taskId: "bd-181", url: VALID_URL, artifactCount: "3" },
    ],
    ["an unknown key", { version: 1, taskId: "bd-181", url: VALID_URL, proof: "x" }],
    ["an array", [{ version: 1, taskId: "bd-181", url: VALID_URL }]],
    ["null", null],
    ["a string", "receipt"],
  ])("rejects %s", (_label, raw) => {
    expect(parseProofReceipt(raw)).toBeUndefined();
  });

  it("rejects a version that is not a number", () => {
    expect(parseProofReceipt({ version: "1", taskId: "bd-181", url: VALID_URL })).toBeUndefined();
  });
});

describe("serializeProofReceipt", () => {
  it("round-trips through the parser", () => {
    const receipt: ProofReceipt = {
      version: PROOF_RECEIPT_VERSION,
      taskId: "bd-181",
      url: VALID_URL,
      artifactCount: 2,
    };
    const raw: unknown = JSON.parse(serializeProofReceipt(receipt));
    expect(parseProofReceipt(raw)).toStrictEqual(receipt);
  });

  it("omits absent optional fields", () => {
    const serialized = serializeProofReceipt({ version: 1, taskId: "bd-181", id: "upload-42" });
    expect(serialized).toBe(
      `${JSON.stringify({ version: 1, taskId: "bd-181", id: "upload-42" })}\n`,
    );
  });
});

describe("formatProofReceipt", () => {
  it("prefers the URL and falls back to the id", () => {
    expect(formatProofReceipt({ version: 1, taskId: "bd-181", id: "u-1", url: VALID_URL })).toBe(
      `proof-receipt: ${VALID_URL}`,
    );
    expect(formatProofReceipt({ version: 1, taskId: "bd-181", id: "u-1" })).toBe(
      "proof-receipt: u-1",
    );
  });

  it("says so when a hand-built receipt has neither reference", () => {
    expect(formatProofReceipt({ version: 1, taskId: "bd-181" })).toBe("proof-receipt: (missing)");
  });
});

describe("findProofReceiptRefs", () => {
  it("reads a receipt line in a ## Receipt section", () => {
    const output = ["Some summary.", "", "## Receipt", `receipt: ${VALID_URL}`, ""].join("\n");
    expect(findProofReceiptRefs(output)).toStrictEqual([VALID_URL]);
  });

  it("reads a bare single-token line inside a ## Receipt section", () => {
    const output = ["## Receipt", "  - upload-42  ", ""].join("\n");
    expect(findProofReceiptRefs(output)).toStrictEqual(["upload-42"]);
  });

  it("reads receipt and proof-receipt lines outside a section, case-insensitively", () => {
    const output = ["receipt: upload-1", "Proof-Receipt: upload-2", "**receipt:** upload-3"].join(
      "\n",
    );
    expect(findProofReceiptRefs(output)).toStrictEqual(["upload-1", "upload-2", "upload-3"]);
  });

  it("dedupes while preserving the first occurrence order", () => {
    const output = [
      "receipt: upload-b",
      "receipt: upload-a",
      "receipt: upload-b",
      "proof-receipt: upload-c",
    ].join("\n");
    expect(findProofReceiptRefs(output)).toStrictEqual(["upload-b", "upload-a", "upload-c"]);
  });

  it.each(["done", "1", "yes", "ok", "u-1", "notareceipt"])(
    "rejects the prose/short token %s",
    (token) => {
      expect(findProofReceiptRefs(`receipt: ${token}`)).toStrictEqual([]);
      expect(findProofReceiptRefs(["## Receipt", token].join("\n"))).toStrictEqual([]);
    },
  );

  it("rejects a URL without a path, host, or an https scheme", () => {
    for (const url of [
      "https://proof.example.com",
      "https://proof.example.com/",
      "ftp://proof.example.com/u/1",
      "proof.example.com/u/1",
    ]) {
      expect(findProofReceiptRefs(`receipt: ${url}`)).toStrictEqual([]);
    }
  });

  it("surfaces a plain-http URL so the gate can refuse it by name", () => {
    // The scanner accepts an http(s) URL as a reference *token*; acceptance is
    // https-only in the gate, which names the refused URL instead of silently
    // falling through to missing-artifact feedback.
    expect(findProofReceiptRefs(`receipt: ${HTTP_URL}`)).toStrictEqual([HTTP_URL]);
  });

  it("accepts UUID-shaped ids", () => {
    const uuid = "7f1c2b44-4b3e-4a5f-9d3a-0c2f8a1b6e75";
    expect(findProofReceiptRefs(`receipt: ${uuid}`)).toStrictEqual([uuid]);
  });

  it("does not treat prose as a receipt reference", () => {
    const output = [
      "The receipt: was uploaded by the proof agent.",
      "## Notes",
      "upload-42",
      "receipt: two words",
    ].join("\n");
    expect(findProofReceiptRefs(output)).toStrictEqual([]);
  });

  it("stops reading the section at the next heading", () => {
    const output = ["## Receipt", "upload-42", "## Artifacts", "proof-of-work/bd-181/x.png"].join(
      "\n",
    );
    expect(findProofReceiptRefs(output)).toStrictEqual(["upload-42"]);
  });

  it("returns nothing for output with no receipt at all", () => {
    expect(findProofReceiptRefs("## Artifacts\nproof-of-work/bd-181/x.png\n")).toStrictEqual([]);
  });
});

describe("readProofReceipt / writeProofReceipt (store rows)", () => {
  const cwd = "/workspace";
  let dir: string;
  let storePath: string;
  let store: RepoStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "belayd-proof-receipt-"));
    storePath = join(dir, "state.sqlite");
    const opened = openRepoStateStore({ path: storePath });
    if (!opened.ok) throw new Error(opened.error);
    store = opened.store;
  });

  afterEach(() => {
    store.close();
    resetSharedRepoStateStore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a missing row as a normal absence, not an error", () => {
    const result = readProofReceipt({ cwd, taskId: "bd-181", store });
    expect(result).toStrictEqual({ ok: true, receipt: undefined });
  });

  it("reads only the row its task id names", () => {
    const written = writeProofReceipt({
      cwd,
      store,
      receipt: { version: 1, taskId: "bd-181", url: VALID_URL },
    });
    expect(written).toStrictEqual({ ok: true, taskId: "bd-181" });

    expect(readProofReceipt({ cwd, taskId: "bd-181", store })).toStrictEqual({
      ok: true,
      receipt: { version: 1, taskId: "bd-181", url: VALID_URL },
    });
    // Identity is the task, never the worktree: another bead in the same
    // worktree has no receipt even though this one does.
    expect(readProofReceipt({ cwd, taskId: "bd-182", store })).toStrictEqual({
      ok: true,
      receipt: undefined,
    });
  });

  it("resolves the same row from two stores opened on one file (two worktrees)", () => {
    writeProofReceipt({
      cwd,
      store,
      receipt: { version: 1, taskId: "bd-181", id: "upload-42" },
    });
    const second = openRepoStateStore({ path: storePath });
    if (!second.ok) throw new Error(second.error);
    try {
      expect(
        readProofReceipt({ cwd: "/another/worktree", taskId: "bd-181", store: second.store }),
      ).toStrictEqual({
        ok: true,
        receipt: { version: 1, taskId: "bd-181", id: "upload-42" },
      });
    } finally {
      second.store.close();
    }
  });

  it("writes then reads the same receipt", () => {
    const receipt: ProofReceipt = { version: 1, taskId: "bd-181", id: "upload-42" };
    expect(writeProofReceipt({ cwd, store, receipt })).toStrictEqual({
      ok: true,
      taskId: "bd-181",
    });
    expect(readProofReceipt({ cwd, taskId: "bd-181", store })).toStrictEqual({
      ok: true,
      receipt,
    });
  });

  it("reports a contract mismatch as an error, not an absence", () => {
    // A row written past the helper (or by an older/newer writer) is still read
    // through the schema: an id-less receipt identifies nothing.
    const written = store.writeProofReceipt({
      taskId: "bd-181",
      receipt: { version: 1, taskId: "bd-181" },
    });
    expect(written).toStrictEqual({ ok: true, value: null });

    const result = readProofReceipt({ cwd, taskId: "bd-181", store });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("does not match the proof receipt contract");
  });

  it("rejects a stored receipt whose url is plain http", () => {
    store.writeProofReceipt({
      taskId: "bd-181",
      receipt: { version: 1, taskId: "bd-181", url: HTTP_URL },
    });
    const result = readProofReceipt({ cwd, taskId: "bd-181", store });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("does not match the proof receipt contract");
  });

  it("reports a corrupt row as an error", async () => {
    store.writeProofReceipt({
      taskId: "bd-181",
      receipt: { version: 1, taskId: "bd-181", id: "upload-42" },
    });
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(storePath);
    raw
      .prepare("UPDATE proof_receipt SET payload = ? WHERE task_id = ?")
      .run("{not json", "bd-181");
    raw.close();
    const reopened = openRepoStateStore({ path: storePath });
    if (!reopened.ok) throw new Error(reopened.error);
    store = reopened.store;

    const result = readProofReceipt({ cwd, taskId: "bd-181", store });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("not valid JSON");
  });

  it("refuses a receipt that does not match the contract", () => {
    expect(
      writeProofReceipt({
        cwd,
        store,
        // An id-less receipt never identifies an upload.
        receipt: { version: 1, taskId: "bd-181" },
      }),
    ).toStrictEqual({
      ok: false,
      error: "refusing to write a receipt that does not match the proof receipt contract",
    });
  });

  it("refuses to store a receipt under another task's key", () => {
    expect(
      writeProofReceipt({
        cwd,
        store,
        taskId: "bd-999",
        receipt: { version: 1, taskId: "bd-181", id: "upload-42" },
      }),
    ).toStrictEqual({
      ok: false,
      error: "refusing to store a receipt for bd-181 under bd-999",
    });
    expect(store.readProofReceipt({ taskId: "bd-999" })).toStrictEqual({
      ok: true,
      value: undefined,
    });
  });

  it("treats a directory that is not a repository as an absence, not an error", () => {
    // No store seam: path resolution finds no git common dir at all. That is a
    // different environment (no repository), not a broken store, so it must read
    // as "no receipt row can exist" rather than as a failure. The scratch root is
    // proven free of a `.git` ancestor so a TMPDIR inside a repository cannot
    // turn this into the indeterminate branch.
    const plain = createCleanScratchRoot("belayd-proof-receipt-absent-");
    delete process.env[REPO_STATE_FILE_ENV];
    resetRepoStatePaths();
    try {
      expect(readProofReceipt({ cwd: plain, taskId: "bd-181" })).toStrictEqual({
        ok: true,
        receipt: undefined,
      });
    } finally {
      resetRepoStatePaths();
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("fails closed when a repository's .git points at a missing common dir", () => {
    // git exits 128 here and outside any repository alike. A `.git` marker is
    // what says the repository exists but is broken, so this must be an error
    // rather than an absence that lets the agent's own receipt line win.
    const broken = join(dir, "broken-repo");
    mkdirSync(broken);
    writeFileSync(join(broken, ".git"), `gitdir: ${join(dir, "missing-common")}\n`);
    delete process.env[REPO_STATE_FILE_ENV];
    resetRepoStatePaths();
    try {
      const result = readProofReceipt({ cwd: broken, taskId: "bd-181" });
      expect(result).toHaveProperty("ok", false);
      if (result.ok) return;
      expect(result.error).toContain("needs a git common dir");
    } finally {
      resetRepoStatePaths();
    }
  });

  it("refuses to write a receipt when the directory is not a repository", () => {
    // The write path shares the three-state lookup; pin its `absent` branch so a
    // later refactor cannot turn "not a repository" into a silent success. Same
    // clean-root rule as the read test above.
    const plain = createCleanScratchRoot("belayd-proof-receipt-absent-");
    delete process.env[REPO_STATE_FILE_ENV];
    resetRepoStatePaths();
    try {
      expect(
        writeProofReceipt({
          cwd: plain,
          taskId: "bd-181",
          receipt: { version: 1, taskId: "bd-181", id: "upload-42" },
        }),
      ).toStrictEqual({
        ok: false,
        error: `no repository state store for ${plain}: this directory is not a git repository`,
      });
    } finally {
      resetRepoStatePaths();
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("reports an error when a repository's store cannot be opened (never an absence)", () => {
    // A resolved store path whose parent is a regular file: the open fails with
    // ENOTDIR, which the classifier calls permanent. Failing open here would let
    // an agent-authored URL be accepted as proof.
    const blockedParent = join(dir, "blocked");
    writeFileSync(blockedParent, "not a directory");
    process.env[REPO_STATE_FILE_ENV] = join(blockedParent, "state.sqlite");
    resetSharedRepoStateStore();
    try {
      const result = readProofReceipt({ cwd: dir, taskId: "bd-181" });
      expect(result).toHaveProperty("ok", false);
      if (result.ok) return;
      expect(result.error).toContain("repo state store");
      expect(result.error).toContain("permanent");
    } finally {
      delete process.env[REPO_STATE_FILE_ENV];
      resetSharedRepoStateStore();
    }
  });

  it("retries a transient open failure and then reads the row", async () => {
    const receipt: ProofReceipt = { version: 1, taskId: "bd-181", id: "upload-42" };
    expect(store.writeProofReceipt({ taskId: "bd-181", receipt })).toHaveProperty("ok", true);
    // Close the seed handle so the shared open starts from nothing.
    store.close();
    resetSharedRepoStateStore();
    process.env[REPO_STATE_FILE_ENV] = storePath;

    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(storePath);
    // Exhaust the schema step's own attempts (3) so the *open* fails transiently,
    // then let the receipt helper's bounded retry succeed.
    let remainingFailures = 3;
    const flaky: SqliteDatabaseLike = {
      exec(sql) {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          // node:sqlite reports lock contention as SQLITE_BUSY; the classifier
          // reads the message text for it.
          throw new Error("SQLITE_BUSY: database is locked");
        }
        raw.exec(sql);
      },
      prepare: (sql) => raw.prepare(sql),
      close: () => raw.close(),
    };
    try {
      expect(readProofReceipt({ cwd: dir, taskId: "bd-181", database: flaky })).toStrictEqual({
        ok: true,
        receipt,
      });
    } finally {
      raw.close();
      delete process.env[REPO_STATE_FILE_ENV];
      resetSharedRepoStateStore();
    }
  });

  it("does not freeze the shared store's clock on a transient retry (regression)", async () => {
    const receipt: ProofReceipt = { version: 1, taskId: "bd-181", id: "upload-42" };
    expect(store.writeProofReceipt({ taskId: "bd-181", receipt })).toHaveProperty("ok", true);
    store.close();
    resetSharedRepoStateStore();
    process.env[REPO_STATE_FILE_ENV] = storePath;

    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(storePath);
    let remainingFailures = 3;
    const flaky: SqliteDatabaseLike = {
      exec(sql) {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("SQLITE_BUSY: database is locked");
        }
        raw.exec(sql);
      },
      prepare: (sql) => raw.prepare(sql),
      close: () => raw.close(),
    };
    try {
      expect(readProofReceipt({ cwd: dir, taskId: "bd-181", database: flaky })).toStrictEqual({
        ok: true,
        receipt,
      });

      // The retry must not install a `now` override in the process's shared
      // store: that seam is test-only, and a frozen epoch here would poison every
      // later defaulted timestamp on this repository (fleet drain, leases, notes).
      const shared = sharedRepoStateStore({ path: storePath });
      if (shared.store === null) throw new Error(shared.error ?? "retried store did not open");
      const before = Date.now();
      const written = shared.store.writeRun({
        runId: "clock-check",
        payload: { runId: "clock-check" },
      });
      if (!written.ok) throw new Error(written.error);
      expect(Math.abs(written.value.updatedAt - before)).toBeLessThan(5_000);
    } finally {
      raw.close();
      delete process.env[REPO_STATE_FILE_ENV];
      resetSharedRepoStateStore();
    }
  });
});

describe("the absence scratch root (bd-281 round 14)", () => {
  it("hands back a root with no repository marker when TMPDIR is clean", () => {
    const root = createCleanScratchRoot("belayd-absent-control-");
    try {
      // Positive control for the guard below: the helper refuses only for a
      // repository-scoped TMPDIR, and what it returns really has no marker above it.
      expect(gitMarkerAtOrAbove(root)).toBeUndefined();
      expect(existsSync(join(root, ".git"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws loudly instead of skipping when TMPDIR sits inside a repository", () => {
    // A TMPDIR inside this checkout is a directory that provably has a `.git`
    // ancestor. The helper must refuse: skipping would drop the absence branch while
    // the suite still reported green, which is the failure mode the guard exists for.
    const inside = mkdtempSync(join(process.cwd(), ".belayd-scratch-probe-"));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = inside;
    try {
      expect(() => createCleanScratchRoot("belayd-absent-probe-")).toThrow(
        /cannot test repository absence: .* is inside a git repository \(found .*[/\\]\.git\)\. Point TMPDIR at a directory outside any repository\./,
      );
      // ...and it cleans up the scratch directory it made before refusing.
      expect(readdirSync(inside)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      rmSync(inside, { recursive: true, force: true });
    }
  });
});

describe("proof receipt in a real repository (composition)", () => {
  it("writes one row that a second worktree reads with no path seam", () => {
    // The pieces are tested separately (the git probe, the receipt IO on an
    // injected store). This composes them the way production does: real git init
    // -> resolve <git-common-dir>/belayd/state.sqlite with no override -> open ->
    // write -> read from the first and then from a linked second worktree.
    const scratch = mkdtempSync(join(tmpdir(), "belayd-proof-receipt-compose-"));
    delete process.env[REPO_STATE_FILE_ENV];
    resetRepoStatePaths();
    resetSharedRepoStateStore();
    try {
      const { repo, second } = initRepoWithWorktree(scratch);
      const receipt: ProofReceipt = { version: 1, taskId: "bd-181", id: "upload-42" };

      expect(writeProofReceipt({ cwd: repo, receipt })).toStrictEqual({
        ok: true,
        taskId: "bd-181",
      });

      // Both worktrees resolve the one per-repository store (never a worktree copy).
      const firstPath = resolveRepoStatePath({ cwd: repo, env: {} });
      const secondPath = resolveRepoStatePath({ cwd: second, env: {} });
      expect(firstPath).toStrictEqual(secondPath);
      if (!firstPath.ok) throw new Error(firstPath.error);
      expect(firstPath.value.endsWith(join(".git", "belayd", "state.sqlite"))).toBe(true);

      // One row, visible from either worktree: the copied-state bug cannot recur.
      expect(readProofReceipt({ cwd: repo, taskId: "bd-181" })).toStrictEqual({
        ok: true,
        receipt,
      });
      expect(readProofReceipt({ cwd: second, taskId: "bd-181" })).toStrictEqual({
        ok: true,
        receipt,
      });
    } finally {
      resetSharedRepoStateStore();
      resetRepoStatePaths();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
