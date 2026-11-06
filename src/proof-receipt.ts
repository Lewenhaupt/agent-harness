/**
 * Proof receipt contract (bd-181) — proof artifacts leave the repository.
 *
 * Proof used to be committed under `docs/proof/<slug>/`. It now uploads to the
 * proof-of-work reviewing platform, and the workflow keeps a receipt (an id
 * and/or URL) instead of files in the worktree.
 *
 * bd-281 moved the receipt out of the worktree: it is a row in the shared
 * per-repository store (`<git-common-dir>/belayd/state.sqlite`, table
 * `proof_receipt`, keyed by task id), like every other piece of execution state.
 * The pi-web proof panel reads that row through its own server module — see the
 * SYNC WARNING below for the contract the two sides share.
 *
 * Everything except the two documented store helpers is pure: parsing,
 * serialization, formatting and output scanning take data in and return data
 * out, so the gate and the publish guard stay deterministic.
 */

import { z } from "zod";
import {
  classifyStoreFailure,
  type RepoStateStore,
  resolveRepoStatePath,
  type StoreFailureClass,
  sharedRepoStateStore,
} from "./repo-state-store.js";
import type { SqliteDatabaseLike } from "./sqlite-store-open.js";

/** Receipt schema version. A shape change is a version bump, not a guess. */
export const PROOF_RECEIPT_VERSION = 1;

// SYNC WARNING: The receipt JSON shape and reference rules below are a
// cross-component contract duplicated in
// `pi-web-plugins/proof-of-work/discovery.js` (`normalizeProofReceipt`, sent
// through `resolveProofReceipt`), and the row it reads is the one this module
// writes.
//
// The landed contract (bd-303, closing bd-281's one outward break): the receipt
// is a row in the shared per-repository store,
// `<git-common-dir>/belayd/state.sqlite`, table `proof_receipt` (task_id,
// payload, updated_at), keyed by task id and holding this document as the
// `payload` JSON. The pi-web plugin reaches it without the browser file API:
// `pi-web-plugins/proof-of-work/server-plugin.js` resolves
// `${BELAYD_REPO_STATE_FILE}` or `<git-common-dir>/belayd/state.sqlite`, maps the
// requested worktree to a task id through `workflow_binding`, and returns the
// row's payload text; `discovery.js` then validates it in the browser. The
// retired `.belayd/proof-receipt.json` file must not come back: a mirrored copy
// is exactly the bd-165 copied-state bug bd-281 removed.
//
// The facts that stay mirrored in both directions (the parity test
// `src/__tests__/proof-receipt-parity.test.ts` fails on drift): the store file
// name `state.sqlite` inside the git common dir's `belayd` directory, the
// `BELAYD_REPO_STATE_FILE` override, the git-context variables both git probes
// ignore, the two table names and columns (`workflow_binding` =
// worktree_path/task_id/bound_at, `proof_receipt` =
// task_id/payload/updated_at), their failure modes (a missing store file is "no
// receipt", an unreadable one is a failure), and the document shape and
// validation rules below.
//
// The document is one JSON object:
// `{ version: 1, taskId: string, id?: string, url?: string, uploadedAt?: string,
// artifactCount?: number }` with at least one of `id`/`url`. An `id` is a UUID
// or >= 8 chars of `[A-Za-z0-9]` containing `-`/`_`; a `url` is an absolute
// `https:` URL (plain `http:` is rejected — there is no localhost exception)
// with a non-empty host and a non-root path. That id shape is a deliberate
// contract decision, not a formatting preference: accepting a short, unpadded
// platform id later is a `PROOF_RECEIPT_VERSION` bump (mirrored in
// `pi-web-plugins/proof-of-work/discovery.js`), never a local tweak.
//
// The TypeScript side validates with {@link ProofReceiptSchema} (zod) on the way
// in and on the way out, so a stored row and an agent-authored output line are
// judged by one implementation. The browser plugin cannot import zod or this
// module, so its hand-rolled reader is the deliberate mirror: every change here —
// the strict key set, the `version: 1` literal, the https-only url rule, the id
// shape, and the at-least-one-reference rule — must be mirrored there, and vice
// versa.

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
 * Validate and normalize a receipt read from the store or from an upload response.
 * Returns undefined for any data that does not match the contract exactly:
 * a wrongly shaped receipt must never be accepted as proof of an upload.
 */
export function parseProofReceipt(raw: unknown): ProofReceipt | undefined {
  const result = ProofReceiptSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** Serialize a receipt as the JSON the store row holds, newline-terminated. */
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
 * Store seam for the two receipt helpers. Tests inject an opened store so no
 * database file is created; production resolves the worktree's shared store.
 */
export interface ProofReceiptIoOptions {
  /** Worktree whose git common dir locates the shared store. */
  cwd: string;
  /**
   * Identity of the receipt: the bead, never the worktree path. Omitted, no row
   * can be located, which reads as "no receipt".
   */
  taskId?: string;
  /** Opened store instead of the module's shared one (tests). */
  store?: RepoStateStore;
  /**
   * Engine seam handed to the shared open (tests drive a failing open with it).
   * Production never sets it, so the real file is opened.
   */
  database?: SqliteDatabaseLike;
}

/**
 * Read a task's receipt. The result union is named so the gate can take an
 * injected reader (GateOptions.readProofReceipt) with the same contract.
 */
export type ProofReceiptReadResult =
  | { ok: true; receipt: ProofReceipt | undefined }
  | { ok: false; error: string };

/** Injected reader seam: production is {@link readProofReceipt}. */
export type ProofReceiptReader = (options: ProofReceiptIoOptions) => ProofReceiptReadResult;

/**
 * What resolving the receipt's store found.
 *
 * `absent` and `failed` are genuinely different states and the gate treats them
 * differently: git observed that this directory is not a repository, so no row can
 * exist, while a repository whose store will not open — or whose repository state
 * cannot be determined — means the row cannot be checked right now.
 */
type ReceiptStoreLookup =
  | { kind: "store"; store: RepoStateStore }
  | { kind: "absent" }
  | { kind: "failed"; error: string };

/** One error line naming the store, its failure class and the underlying error. */
function storeFailureError(options: {
  path: string;
  failureClass: StoreFailureClass;
  error?: string;
}): string {
  const detail = options.error ?? "the open failed earlier in this session";
  return `repo state store ${options.path} is unavailable (${options.failureClass}): ${detail}`;
}

/** The `failed` lookup, preferring the retry's error over the first open's. */
function failedReceiptStore(options: {
  path: string;
  failureClass: StoreFailureClass;
  firstError?: string;
  retriedError?: string;
}): ReceiptStoreLookup {
  const error = options.retriedError ?? options.firstError;
  return {
    kind: "failed",
    error: storeFailureError({
      path: options.path,
      failureClass: options.failureClass,
      ...(error === undefined ? {} : { error }),
    }),
  };
}

/**
 * Resolve the store that holds this task's receipt.
 *
 * Three outcomes, deliberately not collapsed:
 *
 * - **store** — the row can be read.
 * - **absent** — git ran and reported that this directory is not inside a
 *   repository, and no repository marker exists above it. No receipt row can
 *   exist for that environment, so a test directory or a fleet member outside
 *   git still gets the artifact branch instead of a permanent gate failure.
 * - **failed** — a repository *was* resolved but its store could not be opened,
 *   or the git probe could not determine whether this is a repository at all
 *   (spawn failure, timeout, empty output, broken metadata). **The gate must
 *   never read this as "no receipt".** A broken store would then be
 *   indistinguishable from a bead that never uploaded anything, and the
 *   agent's own `receipt: <https URL>` line would become the proof — exactly the
 *   unverified claim the store-backed receipt exists to outrank. The caller gets
 *   an error so the gate's `Invalid proof receipt` branch fails closed.
 *
 * A transient open failure (a busy WAL writer, a schema migration in flight) gets
 * exactly one immediate retry: the failure gate is bypassed for that attempt
 * rather than waiting for a later gate call, because a gate that fails closed on
 * a momentary lock is a false negative on a bead whose receipt is present. The
 * retry is bounded (two opens, the second only on a `transient` classification),
 * has no sleep and no recursion, and **never passes a clock**: the store it opens
 * may become the process's shared store, so a test-only `now` seam there would
 * freeze every defaulted timestamp for the whole session. A permanent failure (no
 * engine, a bad path, corruption) is surfaced immediately: retrying it would only
 * delay the diagnosis.
 */
function receiptStoreFor(options: ProofReceiptIoOptions): ReceiptStoreLookup {
  if (options.store !== undefined) return { kind: "store", store: options.store };
  const resolved = resolveRepoStatePath({ cwd: options.cwd });
  if (!resolved.ok) {
    // Only an observed absence is absence. "I could not ask git" (a spawn
    // failure, a timeout, empty output) or a broken repository (a `.git` marker
    // that git cannot use) is indeterminate and fails closed; treating it as
    // absence would let an agent-authored receipt stand in for the stored one.
    return resolved.reason === "not-a-repository"
      ? { kind: "absent" }
      : { kind: "failed", error: resolved.error };
  }
  const path = resolved.value;
  const database = options.database;
  const opened = sharedRepoStateStore({
    path,
    ...(database === undefined ? {} : { database }),
  });
  if (opened.store !== null) return { kind: "store", store: opened.store };
  const failureClass = opened.failureClass ?? classifyStoreFailure(opened.error ?? "");
  if (failureClass !== "transient") {
    return failedReceiptStore({
      path,
      failureClass,
      ...(opened.error === undefined ? {} : { firstError: opened.error }),
    });
  }
  // Bypass the gate, not the clock: no `now` is passed, so the store installed
  // for this repository keeps stamping real timestamps.
  const retried = sharedRepoStateStore({
    path,
    bypassFailureGate: true,
    ...(database === undefined ? {} : { database }),
  });
  if (retried.store !== null) return { kind: "store", store: retried.store };
  return failedReceiptStore({
    path,
    failureClass,
    ...(opened.error === undefined ? {} : { firstError: opened.error }),
    ...(retried.error === undefined ? {} : { retriedError: retried.error }),
  });
}

/**
 * Read the stored receipt for a task.
 *
 * A missing row is normal (`receipt: undefined`), not an error: the overwhelming
 * majority of beads have no upload platform available yet. A row that exists but
 * does not match the contract is an error, because silently ignoring a malformed
 * receipt would let an unverified claim look like a verified one. A repository
 * whose store cannot be opened — or whose repository state cannot be determined —
 * is an error too, never an absence, for the reason recorded in
 * {@link receiptStoreFor}.
 */
export function readProofReceipt(options: ProofReceiptIoOptions): ProofReceiptReadResult {
  if (options.taskId === undefined) return { ok: true, receipt: undefined };
  const lookup = receiptStoreFor(options);
  if (lookup.kind === "absent") return { ok: true, receipt: undefined };
  if (lookup.kind === "failed") return { ok: false, error: lookup.error };
  const row = lookup.store.readProofReceipt({ taskId: options.taskId });
  if (!row.ok) return { ok: false, error: row.error };
  if (row.value === undefined) return { ok: true, receipt: undefined };
  const receipt = parseProofReceipt(row.value);
  if (receipt === undefined) {
    return {
      ok: false,
      error: `stored proof receipt for ${options.taskId} does not match the proof receipt contract`,
    };
  }
  return { ok: true, receipt };
}

/**
 * Write a task's receipt row.
 *
 * The receipt carries its own task id, so an explicit `taskId` naming another bead
 * is refused: the row key is the authority the gate compares against, and storing
 * a receipt under the wrong key would make that comparison miss.
 */
export function writeProofReceipt(
  options: ProofReceiptIoOptions & { receipt: ProofReceipt },
): { ok: true; taskId: string } | { ok: false; error: string } {
  const validated = parseProofReceipt(options.receipt);
  if (validated === undefined) {
    return {
      ok: false,
      error: "refusing to write a receipt that does not match the proof receipt contract",
    };
  }
  const taskId = options.taskId ?? validated.taskId;
  if (taskId !== validated.taskId) {
    return {
      ok: false,
      error: `refusing to store a receipt for ${validated.taskId} under ${taskId}`,
    };
  }
  const store = receiptStoreFor(options);
  if (store.kind === "failed") return { ok: false, error: store.error };
  if (store.kind === "absent") {
    return {
      ok: false,
      error: `no repository state store for ${options.cwd}: this directory is not a git repository`,
    };
  }
  const written = store.store.writeProofReceipt({ taskId, receipt: validated });
  return written.ok ? { ok: true, taskId } : { ok: false, error: written.error };
}
