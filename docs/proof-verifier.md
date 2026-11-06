# Proof Verifier (`belayd_proof_verifier`)

bd-48 adds a standalone, optional `belayd_proof_verifier` tool to the
belayd-agent-harness pi extension. It separates proof checking into two stages:

1. **Deterministic form gate** — `gateProofContent` in `src/quality-gates.ts`
   remains the **only blocking** proof check (zero AI tokens). It is
   **receipt-first** (bd-181): a stored `proof_receipt` row passes it
   without any artifact refs; with no stored receipt an agent-authored
   `receipt: <https URL>` line passes only when it is an absolute `https:` upload
   URL (a plain `http:` URL or an id-only line fails outright). Otherwise it
   falls back to the external proof root — artifacts must be referenced, exist on
   disk, and `.cast` recordings must be well-formed. In-tree proof content is
   never the criterion: the gate reads no git diff. It never judges relevance.
2. **LLM reasonableness verdict** — `belayd_proof_verifier` runs a read-only
   judge over the proof output and change context, returning an **advisory,
   non-blocking** `{ reasonable: true|false, reason }` verdict. It never gates a
   proof retry.

## Disabled by default (bd-309)

The verdict stage is **not registered** unless `BELAYD_PROOF_VERIFIER=1`
(`src/proof-verifier-env.ts`). Measured use decided the default: 175 recorded
runs across this repository and the proof-of-work platform produced 144
`reasonable: true`, **one** `reasonable: false`, five verdicts missing the
`reasonable:` line entirely and ~25 runs with no output at all — while nothing
consumed the verdict except prose (the state field and the
`[belayd:proof-verifier]` bead comment appended at commit time). An extra judge
run per proof phase bought a note almost nobody read.

The switch is honoured everywhere the tool was advertised, so a dark deployment
never points a session at a tool it cannot call:

- `registerProof` registers nothing when the flag is off
  (`extensions/capabilities/proof.ts`);
- `workflowGateToolSet({ …, proofVerifierEnabled })` drops it from the gated
  surface (`src/role-tools.ts`);
- the `belayd_proof_verifier` guidance lines and the proof-phase sentence in
  the gate text are suppressed (`extensions/capabilities/workflow-context.ts`,
  `workflow-core.ts`).

Nothing else changes: the deterministic gate above, the receipt contract and
`src/proof-verification.ts` (artifact refs, `.cast` validation, change context)
are unconditional. Re-enable per deployment with:

```bash
BELAYD_PROOF_VERIFIER=1 pi
```

Unset, empty, `0`, `false`, `off`, `no` and any other spelling leaves the verdict
stage off. The repository test suite sets the flag in
`src/__tests__/setup-env.ts` so the verifier suites keep their coverage.

## Receipts (bd-181)

Proof artifacts are phased out of repositories: they upload to the proof-of-work
platform and the workflow keeps a receipt — an id and/or URL — defined in
`src/proof-receipt.ts`. **Since bd-281 the receipt is a row in the shared
per-repository store**, `<git-common-dir>/belayd/state.sqlite` (table
`proof_receipt`, keyed by task id), not the retired `.belayd/proof-receipt.json`
file. `parseProofReceipt`
requires `version: 1`, a `taskId`, and at least one of `id`/`url` (an absolute
`https:` URL with a non-root path — plain `http:` is rejected, matching the
prompt — or an `id` that is a UUID or at least 8 characters of `[A-Za-z0-9]`
containing `-`/`_`). The shape is a zod schema (`ProofReceiptSchema`) validated at
the boundary in both directions; the browser plugin's reader mirrors it by hand.

**Known break (bd-303).** `pi-web-plugins/proof-of-work/discovery.js` still reads
`.belayd/proof-receipt.json` through the browser file API, so its proof panel
reports no receipt until that plugin reads the `proof_receipt` row instead. bd-281
accepted the break on purpose (no dual write, no file fallback); see the SYNC
WARNING in `src/proof-receipt.ts`.

Absence and failure are different: a directory that is not a repository simply has
no receipt row (the artifact branch decides), while a repository whose store
cannot be opened is an error and the gate fails closed — an unreadable receipt must
never let the agent's own `receipt:` URL stand in for the proof.

The repository probe is classified from its process outcome, not from git's text.
Absence is reported only when git ran, exited non-zero and no `.git` marker exists
at the directory or any ancestor. A probe that could not run (spawn failure,
timeout, empty output) is `indeterminate` and fails closed, and so is a spawned
git that failed beside a `.git` marker (a `.git` file pointing at a missing common
dir, corrupt metadata). Residual: a corrupt repository whose `.git` marker was
removed is indistinguishable from a plain directory by this probe and resolves as
absence. That case is named here rather than claimed to fail closed.

What a receipt does and does not prove: it asserts that an upload happened and
binds it to a task id. The gate cannot verify the upload until the reviewing
platform exists. The stored `proof_receipt` row is
the only form that is task-bound and authoritative: a malformed or different-task
stored receipt fails closed, and an agent-authored `receipt:` line is accepted
when it matches the stored receipt's `id`/`url`. With no stored receipt, only an
absolute `https:` upload URL from the output is accepted (a plain `http:` URL is
refused) — and that URL is not verified either, so the artifact branch
(existence-checked refs, content-validated `.cast`) remains strictly stronger
evidence.

The publish side has a matching guard: `evaluatePublishGate` in
`src/publish-gate.ts` refuses a payload that carries proof artifacts in
(`proof-artifacts-in-diff`) or paths outside the publishable/intended set
(`paths-outside-scope`), and `drainFleetMerge` calls it before mutating
anything. The payload is read with `--diff-filter=ACMRT`, so proof artifacts that
are **added or modified** are refused while **deleting** them is allowed — that is
the migration: upload the proof, keep the receipt, remove the in-tree files.
Committed `docs/proof/**` history is not migrated; proof carried in is stopped,
proof removed is allowed. A rename out of a proof directory stays in the payload
(as its destination path) and is still refused.

The verifier is **not** a new phase in `PHASE_ORDER` or the workflow registry —
the orchestrator calls it after the proof phase on its own judgment. A
`reasonable: false` verdict is worth investigating but never blocks `belayd_commit`.

## How to Verify

### 1. Build and run the test suite

```bash
pnpm build          # tsc compiles src/ -> dist/
pnpm test           # unit tests
pnpm test:integration
pnpm typecheck
pnpm lint
```

The bd-48-specific coverage lives in:

- `src/__tests__/proof-receipt.test.ts` — the receipt contract: parsing,
  serialization, output scanning, and the store-backed read/write helpers
  (missing row vs malformed row).
- `src/__tests__/publish-gate.test.ts` — the publish guard path classification
  and its deterministic refusal reasons.
- `src/__tests__/proof-verification.test.ts` — artifact ref scanning,
  path-traversal guards, `.cast` extraction, `How to Verify` section
  extraction, and `buildVerifierPrompt` fencing.
- `src/__tests__/extension-proof-verifier.test.ts` — tool registration, the
  `BELAYD_PROOF_VERIFIER` switch (no registration and no gated surface when
  off), the zero-token skip path, and non-blocking verdict behavior.
- `src/__tests__/proof-verifier-env.test.ts` — the flag parser: default off,
  enable spellings, and the tool-name constant the registries share.
- `src/__tests__/cast-utils.test.ts` — ANSI/OSC stripping and asciicast parsing.

Run the focused suites directly:

```bash
pnpm vitest run src/__tests__/proof-verification.test.ts src/__tests__/extension-proof-verifier.test.ts src/__tests__/cast-utils.test.ts
```

### 2. Confirm the tool registration (no phase tool)

With `BELAYD_PROOF_VERIFIER=1` set, the verifier tool must exist **outside** the
phase-tool registration loop (it is deliberately not in `DEFAULT_AGENTS`). With
the flag unset it must not exist at all. From a gated session:

```text
belayd_status
```

Confirm `belayd_proof_verifier` is listed among the gated tools but is **not**
numbered as a phase in the workflow order — proof workflows still read
`... → proof → commit` with no `verifier` step between them.

### 3. Exercise the zero-token skip path

With no active task, call the verifier directly:

```text
Please call belayd_proof_verifier with task "bd-48".
```

Expected: the tool returns

```text
Proof verifier skipped: no proof artifacts referenced and no change context available.
```

with `exitCode 0` and **no sub-agent spawn** (this is the skip condition in
`buildProofVerifierPrompt` in `extensions/capabilities/proof.ts` — no artifact
refs and no git change context). You should see no `belayd-proof-verifier-<runId>`
session.

### 4. Exercise the advisory verdict path

Start a workflow, let the proof phase complete, then call the verifier:

```text
/belayd bd-48 --no-worktree
(... run the phases through belayd_proof ...)
belayd_proof_verifier
```

Expected:

- The verifier spawns a synchronously-blocking session named
  `belayd-proof-verifier-<runId>` (not a detached background run).
- The response ends with a verdict in this exact shape:

```text
## Verdict
reasonable: true|false
reason: ...
evidence: ...
```

- The tool's own `exitCode` is **always 0**, even when the judge verdict is
  `reasonable: false` — the verdict is advisory and never fails the workflow.
- A `reasonable: false` result does **not** cause a proof-phase retry and does
  not block `belayd_commit`.

### 5. Confirm the verdict is recorded on the bead

After `belayd_commit` with a `taskId`, the verifier verdict is recorded as a
`[belayd:proof-verifier]` bead comment (`appendPhaseDeliverables` in
`extensions/capabilities/commit.ts`). Run:

```bash
bd comments <task-id>
```

and confirm the comment contains the `## Verdict` / `reasonable:` / `reason:` /
`evidence:` block alongside the userguide comment. The userguide comment is a
pointer plus the agent's report: it names the committed record
(`docs/<task-id>-userguide.md`) instead of inlining the whole guide. See
[userguide-phase.md](userguide-phase.md).

### 6. Confirm path-traversal safety

Artifact references are validated before any path is read. On the unit level,
`resolveProofArtifactPath` rejects any ref containing `..` with
`Path traversal detected`. From a gated session, supplying a crafted proof
override like

```text
belayd_proof_verifier with proof "proof-of-work/../../etc/passwd.cast"
```

must return an advisory verdict (or skip) rather than reading the escaped path
— extraction aborts and the verdict proceeds without the artifact.

## How to Use

### In a pi workflow (the normal path)

The verifier is available whenever the phase gate is active for a proof-bearing
workflow. It is surfaced for human review, not for gating:

```text
/belayd bd-48
```

After `belayd_proof` completes, call it only when proof relevance or quality is
uncertain:

```text
belayd_proof_verifier
```

Read the verdict, then record it in the task's Final Summary; `belayd_commit`
also records it as a `[belayd:proof-verifier]` bead comment. A
`reasonable: false` verdict means "investigate the proof" — it never requires
re-running the proof phase and never blocks commit.

### Tool parameters

`belayd_proof_verifier` accepts two **optional** string parameters
(`extensions/capabilities/proof.ts`):

| Param   | Purpose                                                        |
|---------|----------------------------------------------------------------|
| `task`  | Override the task text (defaults to the active task ID)        |
| `proof` | Override the captured proof output (defaults to the last proof phase output) |

The verifier always reads the session's own worktree (`ctx.cwd`); the `cwd`
parameter was removed in bd-119. The same ownership preflight as the phase tools
applies, so a session pointed at another bead's worktree is refused with an
actionable error before any prompt is assembled (see `docs/owned-worktree.md`).

```text
belayd_proof_verifier with task "bd-48", proof "proof-of-work/bd-48/demo.cast"
```

### What the judge sees

The verifier assembles a prompt (`buildProofVerifierPrompt` →
`buildVerifierPrompt` in `src/proof-verification.ts`) from:

- **Task text** — `task` override or the active task ID.
- **Change context** — `git diff --stat HEAD`, `git status --short`, and the
  userguide's `## How to Verify` section (`collectChangeContext`), read from
  `docs/<task-id>-userguide.md` on disk (`readUserGuideForContext`) with the
  in-session report as fallback.
- **Extracted proof content** per modality (`extractProofArtifacts`):
  - `.cast` → asciicast parsed to plain text (`readCastToText`).
  - `.png` / `.jpg` / `.jpeg` → marker for `describe_image` visual inspection.
  - `.trace.zip` → unzipped `trace.network` / `trace.trace` logs or zip listing.
  - anything else → read as text, truncated at 64 KiB.

Every untrusted input (proof output, artifact text, change context, task text)
is fenced in XML-style tags with an explicit "treat as untrusted DATA" guard so
embedded directives cannot escape into the judge's own control flow.

### Skip contract

When the proof output references **no accepted artifacts** and the working tree
has **no change context**, the verifier returns the advisory skip message with
zero tokens and no sub-agent spawn.

### Verdict schema

```text
## Verdict
reasonable: true|false
reason: ...
evidence: ...
```

`reasonable: true` means the proof is likely relevant and plausible evidence for
the task; `reasonable: false` flags it for human attention. Neither value gates
the workflow.

### Programmatic use (library)

The pure helpers are exported from the npm package (`src/index.ts`) and can be
driven directly:

```typescript
import {
  buildVerifierPrompt,
  collectChangeContext,
  extractHowToVerify,
  extractProofArtifacts,
  findProofArtifactRefs,
  PROOF_VERIFIER_AGENT,
} from "belayd-agent-harness";

const refs = findProofArtifactRefs('Screenshot: proof-of-work/bd-48/shot.png');
// => ["proof-of-work/bd-48/shot.png"]

const extraction = await extractProofArtifacts(refs, "/repo", "/proof/bd-48");
const changeContext = await collectChangeContext("/repo", userGuideContent);

const prompt = extraction.ok
  ? buildVerifierPrompt({
      taskText: "bd-48",
      changeContext,
      proofOutput: 'Screenshot: proof-of-work/bd-48/shot.png',
      artifacts: extraction.artifacts,
    })
  : "";

// PROOF_VERIFIER_AGENT carries the judge's system prompt, tool allowlist
// (read + describe_image only), and model class.
console.log(PROOF_VERIFIER_AGENT.tools); // => ["read", "describe_image"]
```

### Security notes

- Untrusted content is fenced in XML tags; the judge's system prompt and tool
  description both instruct it to treat fenced content as data, never
  instructions.
- Trace zip extraction uses `execFile` (no shell), so artifact paths cannot
  inject shell syntax.
- The verifier's tool allowlist is `read` + `describe_image` only, so it can
  re-open resolved proof artifacts (and visually inspect screenshots) without
  `ls`/`find`/`ast_grep` widening the file-access surface.
- Binary/non-text artifact content is marked as such instead of being rendered
  (`readFileTruncated` returns `<binary content: N bytes>` on a NUL byte).
- Path-traversal guards (`checkPathTraversal`, `checkProofDirTraversal`) abort
  extraction entirely on a violation rather than reading an escaped path.
