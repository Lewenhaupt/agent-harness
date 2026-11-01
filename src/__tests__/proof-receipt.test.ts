/**
 * Unit tests for the proof receipt contract (bd-181).
 *
 * Parsing, serialization, formatting and output scanning are pure, so they are
 * tested data-in/assert-return-value. The two I/O helpers take an injected
 * filesystem seam, so no test touches the real disk.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findProofReceiptRefs,
  formatProofReceipt,
  isProofReceiptUrl,
  PROOF_RECEIPT_RELATIVE_PATH,
  PROOF_RECEIPT_VERSION,
  type ProofReceipt,
  type ProofReceiptFs,
  parseProofReceipt,
  readProofReceipt,
  serializeProofReceipt,
  writeProofReceipt,
} from "../proof-receipt.js";

const VALID_URL = "https://proof.example.com/uploads/bd-181";
const HTTP_URL = "http://proof.example.com/uploads/bd-181";

/** In-memory filesystem seam: a path map, never real disk. */
function memoryFs(initial: Record<string, string> = {}): ProofReceiptFs & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readText: (path) =>
      files.has(path)
        ? { ok: true, content: files.get(path) ?? "" }
        : { ok: true, content: undefined },
    writeText: (path, content) => {
      files.set(path, content);
      return { ok: true };
    },
  };
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

describe("readProofReceipt / writeProofReceipt", () => {
  const cwd = "/workspace";
  const receiptPath = join(cwd, PROOF_RECEIPT_RELATIVE_PATH);

  it("treats a missing receipt as a normal absence, not an error", () => {
    const result = readProofReceipt({ cwd, fs: memoryFs() });
    expect(result).toStrictEqual({ ok: true, receipt: undefined });
  });

  it("reads a valid receipt from the gitignored .belayd path", () => {
    const fs = memoryFs({
      [receiptPath]: JSON.stringify({ version: 1, taskId: "bd-181", url: VALID_URL }),
    });
    expect(readProofReceipt({ cwd, fs })).toStrictEqual({
      ok: true,
      receipt: { version: 1, taskId: "bd-181", url: VALID_URL },
    });
  });

  it("reports malformed JSON as an error", () => {
    const result = readProofReceipt({ cwd, fs: memoryFs({ [receiptPath]: "{not json" }) });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("not valid JSON");
  });

  it("reports a contract mismatch as an error", () => {
    const fs = memoryFs({ [receiptPath]: JSON.stringify({ version: 1, taskId: "bd-181" }) });
    const result = readProofReceipt({ cwd, fs });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("does not match the proof receipt contract");
  });

  it("rejects a stored receipt whose url is plain http", () => {
    const fs = memoryFs({
      [receiptPath]: JSON.stringify({ version: 1, taskId: "bd-181", url: HTTP_URL }),
    });
    const result = readProofReceipt({ cwd, fs });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("does not match the proof receipt contract");
  });

  it("reports an unreadable file as an error", () => {
    const fs: ProofReceiptFs = {
      readText: () => ({ ok: false, error: "EACCES" }),
      writeText: () => ({ ok: true }),
    };
    const result = readProofReceipt({ cwd, fs });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("EACCES");
  });

  it("writes then reads the same receipt", () => {
    const fs = memoryFs();
    const written = writeProofReceipt({
      cwd,
      receipt: { version: 1, taskId: "bd-181", id: "upload-42" },
      fs,
    });
    expect(written).toStrictEqual({ ok: true, path: receiptPath });
    expect(readProofReceipt({ cwd, fs })).toStrictEqual({
      ok: true,
      receipt: { version: 1, taskId: "bd-181", id: "upload-42" },
    });
  });

  it("surfaces a write failure", () => {
    const fs: ProofReceiptFs = {
      readText: () => ({ ok: true, content: undefined }),
      writeText: () => ({ ok: false, error: "EROFS" }),
    };
    const result = writeProofReceipt({
      cwd,
      receipt: { version: 1, taskId: "bd-181", url: VALID_URL },
      fs,
    });
    expect(result).toStrictEqual({ ok: false, error: "EROFS" });
  });

  it("keeps the receipt inside .belayd so it can never enter a diff", () => {
    expect(PROOF_RECEIPT_RELATIVE_PATH.startsWith(".belayd/")).toBe(true);
  });
});
