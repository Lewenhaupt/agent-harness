/**
 * Proof receipt contract (bd-181) — proof artifacts leave the repository.
 *
 * Proof used to be committed under `docs/proof/<slug>/`. It now uploads to the
 * proof-of-work reviewing platform, and the workflow keeps a receipt (an id
 * and/or URL) instead of files in the worktree. The receipt lives under
 * `.belayd/`, which is gitignored, so a receipt can never enter a diff.
 *
 * Everything except the two documented I/O helpers is pure: parsing,
 * serialization, formatting and output scanning take data in and return data
 * out, so the gate and the publish guard stay deterministic.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Receipt schema version. A shape change is a version bump, not a guess. */
export const PROOF_RECEIPT_VERSION = 1;

/**
 * Workspace-relative path of the proof receipt.
 *
 * `.belayd/` is gitignored alongside the `proof-of-work` symlink and the
 * `proof-dir` marker, which is what makes "a receipt never enters a diff" a
 * property of the location rather than of a gate.
 */
// SYNC WARNING: The receipt path, JSON shape and reference shape below are a
// cross-component contract duplicated in
// `pi-web-plugins/proof-of-work/discovery.js` (`PROOF_RECEIPT_PATH` and
// `resolveProofReceipt`). The receipt lives at ".belayd/proof-receipt.json" and
// holds one JSON object:
// `{ version: 1, taskId: string, id?: string, url?: string, uploadedAt?: string,
// artifactCount?: number }` with at least one of `id`/`url`. An `id` is a UUID
// or >= 8 chars of `[A-Za-z0-9]` containing `-`/`_`; a `url` is an absolute
// `https:` URL (plain `http:` is rejected — there is no localhost exception)
// with a non-empty host and a non-root path. That id shape is a deliberate
// contract decision, not a formatting preference: accepting a short, unpadded
// platform id later is a `PROOF_RECEIPT_VERSION` bump (mirrored in
// `pi-web-plugins/proof-of-work/discovery.js`), never a local tweak.
//
// The TypeScript side validates with {@link ProofReceiptSchema} (zod). The
// browser plugin cannot import zod or this module, so its hand-rolled reader in
// `pi-web-plugins/proof-of-work/discovery.js` is the daggered mirror: every
// change here — the strict key set, the `version: 1` literal, the https-only
// url rule, the id shape, and the at-least-one-reference rule — must be mirrored
// there, and vice versa.
export const PROOF_RECEIPT_RELATIVE_PATH = ".belayd/proof-receipt.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for an absolute `https:` receipt URL: non-empty host, non-root path.
 *
 * Plain `http:` is rejected on purpose: the published contract (the proof
 * prompt and `docs/proof-verifier.md`) tells the agent that only an https URL
 * is accepted, so accepting http here would let an output line pass a gate the
 * documentation says it cannot. A localhost/dev exception is deliberately not
 * carved out — an unaudited upload URL is the weakest evidence the gate accepts,
 * so it must be the form the contract names.
 *
 * `new URL` is parsed without a base on purpose: a relative or protocol-less
 * string throws, which is exactly the rejection the contract wants. The path
 * requirement is what separates an upload URL from a bare host or a prose token.
 */
export function isProofReceiptUrl(value: string): boolean {
  const parsed = parseUploadUrl(value);
  return parsed !== undefined && parsed.protocol === "https:";
}

/** A URL with a non-empty host and a non-root path, or undefined. */
function parseUploadUrl(value: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.hostname === "") return undefined;
  if (parsed.pathname === "" || parsed.pathname === "/") return undefined;
  return parsed;
}

/**
 * Minimum length of a bare receipt id. Short tokens ("done", "1", "yes",
 * "ok") are prose, not platform ids, and must never satisfy the proof gate.
 */
const MIN_RECEIPT_ID_LENGTH = 8;

const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RECEIPT_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * True for a bare receipt id: a UUID, or at least 8 id characters containing a
 * separator. Requiring a separator and length keeps ordinary words out.
 */
export function isProofReceiptId(value: string): boolean {
  if (RECEIPT_UUID_PATTERN.test(value)) return true;
  if (!RECEIPT_ID_PATTERN.test(value)) return false;
  if (value.length < MIN_RECEIPT_ID_LENGTH) return false;
  return value.includes("-") || value.includes("_");
}

/**
 * True for a receipt reference *token*: an absolute http(s) URL with a host and
 * a path, or a strict id.
 *
 * Plain `http:` is recognized here on purpose even though acceptance is
 * https-only ({@link isProofReceiptUrl}). The scanner is what turns an output
 * line into either an acceptance or a named refusal; classifying an `http:` URL
 * as prose would silently drop it and fall through to the artifact branch,
 * reporting missing artifacts instead of naming the URL that is not acceptable.
 */
export function isProofReceiptReference(value: string): boolean {
  if (isProofReceiptId(value)) return true;
  const parsed = parseUploadUrl(value);
  return parsed !== undefined && (parsed.protocol === "https:" || parsed.protocol === "http:");
}

/** A trimmed, non-empty string; absence is `.optional()`'s job, not this one. */
const receiptTextField = z.string().trim().min(1);

/**
 * The receipt contract, validated at the boundary (receipt-file JSON or an
 * upload response). Strict on purpose: an unknown key is a shape the contract
 * does not describe, and accepting it would let a later field silently change
 * meaning.
 *
 * The `id`/`url` refinements reuse {@link isProofReceiptId} and
 * {@link isProofReceiptUrl} instead of restating their rules, so a stored
 * receipt and an agent-authored output line are judged by one implementation.
 * The at-least-one-reference rule lives here too, because a receipt with no
 * reference identifies nothing.
 */
export const ProofReceiptSchema = z
  .object({
    version: z.literal(PROOF_RECEIPT_VERSION),
    taskId: receiptTextField,
    id: receiptTextField
      .refine(isProofReceiptId, {
        message: "id must be a UUID or >= 8 id characters containing '-' or '_'",
      })
      .optional(),
    url: receiptTextField
      .refine(isProofReceiptUrl, {
        message: "url must be an absolute https URL with a non-root path",
      })
      .optional(),
    uploadedAt: receiptTextField.optional(),
    artifactCount: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((receipt) => receipt.id !== undefined || receipt.url !== undefined, {
    message: "a receipt must carry at least one of id/url",
  });

/** A proof upload receipt. At least one of `id`/`url` identifies the upload. */
export type ProofReceipt = z.infer<typeof ProofReceiptSchema>;

/**
 * Validate and normalize a receipt read from disk or from an upload response.
 * Returns undefined for any data that does not match the contract exactly:
 * a wrongly shaped receipt must never be accepted as proof of an upload.
 */
export function parseProofReceipt(raw: unknown): ProofReceipt | undefined {
  const result = ProofReceiptSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** Serialize a receipt as the JSON the receipt file holds, newline-terminated. */
export function serializeProofReceipt(receipt: ProofReceipt): string {
  return `${JSON.stringify({
    version: receipt.version,
    taskId: receipt.taskId,
    ...(receipt.id === undefined ? {} : { id: receipt.id }),
    ...(receipt.url === undefined ? {} : { url: receipt.url }),
    ...(receipt.uploadedAt === undefined ? {} : { uploadedAt: receipt.uploadedAt }),
    ...(receipt.artifactCount === undefined ? {} : { artifactCount: receipt.artifactCount }),
  })}\n`;
}

/** One deterministic line naming the receipt reference (URL preferred). */
export function formatProofReceipt(receipt: ProofReceipt): string {
  const reference = receipt.url ?? receipt.id;
  // A receipt built outside the parser can still be empty; say so rather than
  // printing a trailing space that reads like a valid reference.
  return reference === undefined ? "proof-receipt: (missing)" : `proof-receipt: ${reference}`;
}

/** Line anywhere in the output that names a receipt, emphasis tolerated. */
const RECEIPT_LINE_PATTERN =
  /^(?:[-*]\s*)?(?:\*\*|__)?(?:proof-)?receipt(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/i;

/** Heading that opens an explicit receipt section (`## Receipt`). */
const RECEIPT_HEADING_PATTERN = /^#{1,6}\s+receipt\s*:?\s*$/i;

const ANY_HEADING_PATTERN = /^#{1,6}\s+\S/;

/** Strip list markers, emphasis, backticks and trailing punctuation from a candidate. */
function cleanReceiptToken(candidate: string): string {
  const stripped = candidate
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/[`"']/g, "")
    .trim()
    .replace(/[.,;:]+$/, "");
  return stripped;
}

/**
 * Extract receipt references from phase-agent output.
 *
 * Accepted forms only: a `receipt: <id|url>` / `proof-receipt: <id|url>` line,
 * or a single-token line inside an explicit `## Receipt` section. A reference
 * token is one strict token (an absolute http(s) URL with a path, or an
 * id-shaped value); whitespace makes it prose and short words ("done", "1",
 * "yes") are rejected here rather than left to the gate. A plain-`http` URL is
 * surfaced as a token on purpose so the gate can refuse it by name; acceptance
 * itself is https-only ({@link isProofReceiptUrl}). Results are deduped in
 * assertion order, so two identical receipts are reported once and the first
 * occurrence keeps its position.
 */
export function findProofReceiptRefs(output: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  let inReceiptSection = false;

  for (const line of output.split("\n")) {
    if (RECEIPT_HEADING_PATTERN.test(line)) {
      inReceiptSection = true;
      continue;
    }
    if (ANY_HEADING_PATTERN.test(line)) {
      inReceiptSection = false;
      continue;
    }

    const match = line.match(RECEIPT_LINE_PATTERN);
    const candidate = match?.[1] ?? (inReceiptSection ? line : undefined);
    if (candidate === undefined) continue;

    const token = cleanReceiptToken(candidate);
    if (token === "" || !isProofReceiptReference(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    refs.push(token);
  }
  return refs;
}

/**
 * Filesystem seam for the two receipt I/O helpers. Tests inject an in-memory
 * implementation; production uses {@link nodeProofReceiptFs}.
 */
export interface ProofReceiptFs {
  /** Read a text file; `content: undefined` means the file does not exist. */
  readText(path: string): { ok: true; content: string | undefined } | { ok: false; error: string };
  /** Write a text file, creating parent directories as needed. */
  writeText(path: string, content: string): { ok: true } | { ok: false; error: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Production seam: node's synchronous fs, with a missing file treated as empty. */
export const nodeProofReceiptFs: ProofReceiptFs = {
  readText(path) {
    try {
      return { ok: true, content: readFileSync(path, "utf-8") };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return { ok: true, content: undefined };
      return { ok: false, error: errorMessage(error) };
    }
  },
  writeText(path, content) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  },
};

export interface ProofReceiptIoOptions {
  /** Workspace root the receipt is resolved against. */
  cwd: string;
  fs?: ProofReceiptFs;
}

/**
 * Read a workspace receipt. The result union is named so the gate can take an
 * injected reader (GateOptions.readProofReceipt) with the same contract.
 */
export type ProofReceiptReadResult =
  | { ok: true; receipt: ProofReceipt | undefined }
  | { ok: false; error: string };

/** Injected reader seam: production is {@link readProofReceipt}. */
export type ProofReceiptReader = (options: ProofReceiptIoOptions) => ProofReceiptReadResult;

/**
 * Read the workspace receipt.
 *
 * A missing file is normal (`receipt: undefined`), not an error: the overwhelming
 * majority of beads have no upload platform available yet. A file that exists
 * but does not match the contract is an error, because silently ignoring a
 * malformed receipt would let an unverified claim look like a verified one.
 */
export function readProofReceipt(options: ProofReceiptIoOptions): ProofReceiptReadResult {
  const fs = options.fs ?? nodeProofReceiptFs;
  const path = join(options.cwd, PROOF_RECEIPT_RELATIVE_PATH);
  const read = fs.readText(path);
  if (!read.ok) return { ok: false, error: `could not read ${path}: ${read.error}` };
  if (read.content === undefined) return { ok: true, receipt: undefined };

  let raw: unknown;
  try {
    raw = JSON.parse(read.content);
  } catch (error) {
    return { ok: false, error: `${path} is not valid JSON: ${errorMessage(error)}` };
  }
  const receipt = parseProofReceipt(raw);
  if (receipt === undefined) {
    return { ok: false, error: `${path} does not match the proof receipt contract` };
  }
  return { ok: true, receipt };
}

/** Write the workspace receipt (`.belayd/proof-receipt.json`). */
export function writeProofReceipt(
  options: ProofReceiptIoOptions & { receipt: ProofReceipt },
): { ok: true; path: string } | { ok: false; error: string } {
  const fs = options.fs ?? nodeProofReceiptFs;
  const path = join(options.cwd, PROOF_RECEIPT_RELATIVE_PATH);
  const written = fs.writeText(path, serializeProofReceipt(options.receipt));
  return written.ok ? { ok: true, path } : { ok: false, error: written.error };
}
