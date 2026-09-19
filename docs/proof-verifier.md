# Proof Verifier (`belayd_proof_verifier`)

bd-48 adds a standalone, optional `belayd_proof_verifier` tool to the
belayd-agent-harness pi extension. It separates proof checking into two stages:

1. **Deterministic form gate** — `gateProofContent` in `src/quality-gates.ts`
   remains the **only blocking** proof check (zero AI tokens). It validates
   that artifacts are referenced, exist on disk, and that `.cast` recordings
   are well-formed — it never judges relevance.
2. **LLM reasonableness verdict** — `belayd_proof_verifier` runs a read-only
   judge over the proof output and change context, returning an **advisory,
   non-blocking** `{ reasonable: true|false, reason }` verdict. It never gates a
   proof retry.

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

- `src/__tests__/proof-verification.test.ts` — artifact ref scanning,
  path-traversal guards, `.cast` extraction, `How to Verify` section
  extraction, and `buildVerifierPrompt` fencing.
- `src/__tests__/extension-proof-verifier.test.ts` — tool registration, the
  zero-token skip path, and non-blocking verdict behavior.
- `src/__tests__/cast-utils.test.ts` — ANSI/OSC stripping and asciicast parsing.

Run the focused suites directly:

```bash
pnpm vitest run src/__tests__/proof-verification.test.ts src/__tests__/extension-proof-verifier.test.ts src/__tests__/cast-utils.test.ts
```

### 2. Confirm the tool registration (no phase tool)

In any pi session with the harness extension loaded, the verifier tool must
exist **outside** the phase-tool registration loop (it is deliberately not in
`DEFAULT_AGENTS`). From a gated session:

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
`buildProofVerifierPrompt` in `extensions/index.ts` — no artifact refs and no
git change context). You should see no `belayd-proof-verifier-<runId>` session.

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

After `belayd_commit` with a `taskId`, the verifier verdict is appended to the
bead as a note (`appendTaskNotes` in `extensions/index.ts`). Run:

```bash
bd show <task-id>
```

and confirm the note contains the `## Verdict` / `reasonable:` / `reason:` /
`evidence:` block alongside the userguide `How to Verify` / `How to Use` note.

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

Read the verdict, then record it in the task's Final Summary and bead notes. A
`reasonable: false` verdict means "investigate the proof" — it never requires
re-running the proof phase and never blocks commit.

### Tool parameters

`belayd_proof_verifier` accepts three **optional** string parameters
(`extensions/index.ts`):

| Param   | Purpose                                                        |
|---------|----------------------------------------------------------------|
| `task`  | Override the task text (defaults to the active task ID)        |
| `proof` | Override the captured proof output (defaults to the last proof phase output) |
| `cwd`   | Working directory (defaults to the session cwd)               |

```text
belayd_proof_verifier with task "bd-48", proof "proof-of-work/bd-48/demo.cast", cwd "/repo"
```

### What the judge sees

The verifier assembles a prompt (`buildProofVerifierPrompt` →
`buildVerifierPrompt` in `src/proof-verification.ts`) from:

- **Task text** — `task` override or the active task ID.
- **Change context** — `git diff --stat HEAD`, `git status --short`, and the
  userguide's `## How to Verify` section (`collectChangeContext`).
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
