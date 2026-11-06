# Proof receipts replace in-tree proof artifacts (bd-181)

> **Superseded location (bd-281).** The receipt is no longer
> `.belayd/proof-receipt.json`. It is a `proof_receipt` row in the shared store,
> `<git-common-dir>/belayd/state.sqlite`, keyed by task id. The file-path steps
> below are the bd-181 record and no longer reproduce; use
> `readProofReceipt`/`writeProofReceipt` (which take a `taskId`) instead of
> writing that file. `pi-web-plugins/proof-of-work/discovery.js` still reads the
> retired file and reports no receipt until **bd-303** makes it read the SQLite
> row.

Proof-of-work used to be committed under `docs/proof/<slug>/`. bd-181 moves the
artifact out of the repository and keeps a **receipt** instead — an id and/or an
upload URL in `.belayd/proof-receipt.json`, a path that is gitignored, so a
receipt can never appear in a diff.

Four pieces ship together:

| Piece | Where | What it does |
| --- | --- | --- |
| Receipt contract | `src/proof-receipt.ts` | `ProofReceiptSchema` (zod, strict), `parseProofReceipt`, `readProofReceipt` / `writeProofReceipt`, `findProofReceiptRefs` |
| Proof gate, receipt-first | `gateProofContent` in `src/quality-gates.ts` | stored receipt → agent `## Receipt` line → external proof-root artifacts, in that order |
| Publish guard | `src/publish-gate.ts`, called by `checkPublishPayload` in `src/fleet-merge.ts` | refuses a merge payload that carries proof or out-of-scope paths |
| Panel | `pi-web-plugins/proof-of-work/{discovery.js,panel.js}` | reads the receipt and renders it above the external proof-root listing — **broken since bd-281** (it still opens the retired file; bd-303 moves it to the SQLite row) |

Two things bd-181 deliberately does **not** do: it has no upload executor (that
is bd-174.3, which owns the `gh`/`git push` argv), and it does not migrate
`docs/proof/**` directories already in git history — it only stops *new* proof
from being carried, and lets you delete the old proof.

## How to Verify

Run everything from the repository root of this checkout. Steps 3–5 use `dist/`,
so build once first.

### 1. Gates and the suites that pin this behaviour

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test && pnpm test:integration
```

Real output in this worktree:

```text
 Test Files  132 passed (132)
      Tests  3582 passed (3582)

 Test Files  14 passed (14)
      Tests  108 passed (108)
```

The bd-181-specific suites on their own:

```bash
node_modules/.bin/vitest run src/__tests__/proof-receipt.test.ts src/__tests__/publish-gate.test.ts
```

```text
 ✓ src/__tests__/proof-receipt.test.ts (54 tests) 18ms
 ✓ src/__tests__/publish-gate.test.ts (63 tests) 12ms

 Test Files  2 passed (2)
      Tests  117 passed (117)
```

### 2. A receipt can never enter a diff

In this repository `.belayd/` is gitignored, which is what makes "a receipt can
never be carried by a publish" a property of the location rather than of a gate:

```bash
git check-ignore -v .belayd/proof-receipt.json
```

```text
.gitignore:15:.belayd/	.belayd/proof-receipt.json
```

### 3. A receipt-published bead passes the gate and merges with no proof files in the diff

The end-to-end test (real member worktree, real `drainFleetMerge`, `.belayd/`
gitignored exactly as here): a source-only commit plus a valid
`.belayd/proof-receipt.json` passes `gateProofContent` on the receipt alone and
merges, and the merged tree contains no receipt.

```bash
node_modules/.bin/vitest run src/__tests__/fleet-merge.test.ts -t "receipt-published bead"
```

```text
 ✓ src/__tests__/fleet-merge.test.ts (63 tests | 62 skipped) 167ms
 Test Files  1 passed (1)
      Tests  1 passed | 62 skipped (63)
```

The same resolution by hand, against real files (`dist/` build from step 1):

```bash
D=/tmp/bd181-receipt
rm -rf "$D" && mkdir -p "$D/.belayd"
cd "$D" && git init -q -b main
printf '%s' '{"version":1,"taskId":"bd-181","id":"up-8f2a91c4","url":"https://proof.example.invalid/up/8f2a91c4","artifactCount":3}' > .belayd/proof-receipt.json
node --input-type=module -e '
import { gateProofContent } from "/home/hugo/git/feat-bd-181/dist/src/quality-gates.js";
const options = { cwd: "/tmp/bd181-receipt", proofDir: "/tmp/bd181-receipt/proofdir/bd-181" };
const run = async (label, output) => console.log(label, "->", JSON.stringify(await gateProofContent(output, {}, options)));
await run("receipt line ", "Done.\n\n## Receipt\nreceipt: https://proof.example.invalid/up/8f2a91c4\n");
await run("no receipt line", "Done.\n");
await run("http line    ", "Done.\n\n## Receipt\nreceipt: http://proof.example.invalid/up/8f2a91c4\n");
await run("mismatched   ", "Done.\n\nreceipt: up-deadbeef\n");
'
```

Real output:

```text
receipt line  -> {"passed":true,"feedback":"Proof receipt accepted: https://proof.example.invalid/up/8f2a91c4"}
no receipt line -> {"passed":true,"feedback":"Proof receipt accepted: https://proof.example.invalid/up/8f2a91c4"}
http line     -> {"passed":false,"feedback":"Proof receipt line does not match the stored receipt (https://proof.example.invalid/up/8f2a91c4): http://proof.example.invalid/up/8f2a91c4"}
mismatched    -> {"passed":false,"feedback":"Proof receipt line does not match the stored receipt (https://proof.example.invalid/up/8f2a91c4): up-deadbeef"}
```

With **no** stored receipt the gate falls back to the agent's `## Receipt` line,
and only an absolute `https` URL is accepted there — never an id, never `http`.
A malformed, unreadable or wrong-`taskId` stored receipt fails closed instead of
falling back:

```bash
cd /tmp/bd181-receipt
node --input-type=module -e '
import { gateProofContent } from "/home/hugo/git/feat-bd-181/dist/src/quality-gates.js";
import { writeFileSync, rmSync } from "node:fs";
const options = { cwd: "/tmp/bd181-receipt", proofDir: "/tmp/bd181-receipt/proofdir/bd-181" };
const receipt = "/tmp/bd181-receipt/.belayd/proof-receipt.json";
const run = async (label, output) => console.log(label, "->", JSON.stringify(await gateProofContent(output, {}, options)));
rmSync(receipt);
await run("no stored, https line", "Done.\n\n## Receipt\nreceipt: https://proof.example.invalid/up/8f2a91c4\n");
await run("no stored, http line ", "Done.\n\n## Receipt\nreceipt: http://proof.example.invalid/up/8f2a91c4\n");
await run("no stored, no receipt", "Done.\n");
writeFileSync(receipt, "{\"version\":1,\"taskId\":\"bd-999\",\"url\":\"https://proof.example.invalid/up/8f2a91c4\"}");
await run("wrong taskId          ", "Done.\n");
writeFileSync(receipt, "{\"version\":2,\"taskId\":\"bd-181\",\"id\":\"up-8f2a91c4\"}");
await run("malformed contract    ", "Done.\n");
'
```

Real output:

```text
no stored, https line -> {"passed":true,"feedback":"Proof receipt accepted: https://proof.example.invalid/up/8f2a91c4"}
no stored, http line  -> {"passed":false,"feedback":"Proof receipt reference http://proof.example.invalid/up/8f2a91c4 is not an upload URL and no stored receipt (.belayd/proof-receipt.json) backs it; provide an https upload URL or artifact refs"}
no stored, no receipt -> {"passed":false,"feedback":"No proof artifacts produced or referenced"}
wrong taskId          -> {"passed":false,"feedback":"Proof receipt in .belayd/proof-receipt.json names bd-999, not bd-181; refusing a receipt for a different task"}
malformed contract    -> {"passed":false,"feedback":"Invalid proof receipt: /tmp/bd181-receipt/.belayd/proof-receipt.json does not match the proof receipt contract"}
```

### 4. A branch that carries a proof artifact is refused, with the named path list

A throwaway repository with four branches — proof added, source-only, proof
deleted, proof renamed out — read exactly the way `checkPublishPayload` reads it
(`--diff-filter=ACMRT`, NUL-delimited, `core.quotePath=false`):

```bash
D=/tmp/bd181-gate
rm -rf "$D" && mkdir -p "$D" && cd "$D"
git init -q -b main && git config user.email t@example.invalid && git config user.name Test
mkdir -p src && echo 'export const a = 1;' > src/a.ts && git add -A && git commit -qm base
git checkout -qb feat/proof
mkdir -p docs/proof/bd-1 && printf x > docs/proof/bd-1/screenshot.png && git add -A && git commit -qm proof
git checkout -q main && git checkout -qb feat/clean
echo 'export const b = 2;' >> src/a.ts && git add -A && git commit -qm source
git checkout -q feat/proof && git checkout -qb feat/delete
git rm -rq docs/proof && git commit -qm 'remove legacy proof'
git checkout -q feat/proof && git checkout -qb feat/rename
git mv docs/proof/bd-1/screenshot.png src/screenshot.png && git commit -qm rename
git checkout -q main

node --input-type=module -e '
import { evaluatePublishGate } from "/home/hugo/git/feat-bd-181/dist/src/publish-gate.js";
import { execFileSync } from "node:child_process";
const payload = (branch) => execFileSync("git", ["-c","core.quotePath=false","diff","--name-only","-z","--diff-filter=ACMRT",`main...${branch}`], { encoding: "utf8" }).split("\0").filter((path) => path !== "");
for (const branch of ["feat/proof", "feat/clean", "feat/delete", "feat/rename"]) {
  console.log(branch, "->", JSON.stringify(evaluatePublishGate({ changedPaths: payload(branch) })));
}
'
```

Real output:

```text
feat/proof -> {"ok":false,"reason":"proof-artifacts-in-diff","paths":["docs/proof/bd-1/screenshot.png"],"text":"publish gate refused: proof-artifacts-in-diff: docs/proof/bd-1/screenshot.png; proof artifacts must not be published — upload them and keep the receipt at .belayd/proof-receipt.json"}
feat/clean -> {"ok":true,"paths":["src/a.ts"]}
feat/delete -> {"ok":true,"paths":[]}
feat/rename -> {"ok":false,"reason":"proof-artifacts-in-diff","paths":["src/screenshot.png"],"text":"publish gate refused: proof-artifacts-in-diff: src/screenshot.png; proof artifacts must not be published — upload them and keep the receipt at .belayd/proof-receipt.json"}
```

`feat/rename` is refused because a rename is classified by its **destination**,
and `.png` is an accepted proof extension — moving evidence out of `docs/proof/`
into a source path does not launder it.

Inside the fleet, the drain returns `reason`/`text`/`paths`, the queue entry
stays `queued`, and `belayd_fleet_merge` renders the full sorted list via
`formatDrainResultText`:

```bash
cd /home/hugo/git/feat-bd-181 && node --input-type=module -e '
import { formatDrainResultText } from "./dist/src/fleet-merge.js";
console.log(formatDrainResultText({ ok: false, reason: "proof-artifacts-in-diff", parked: false,
  text: "publish gate refused: proof-artifacts-in-diff: docs/proof/bd-1/a.png, docs/proof/bd-1/b.cast; proof artifacts must not be published — upload them and keep the receipt at .belayd/proof-receipt.json",
  paths: ["docs/proof/bd-1/a.png", "docs/proof/bd-1/b.cast"] }));
'
```

```text
publish gate refused: proof-artifacts-in-diff: docs/proof/bd-1/a.png, docs/proof/bd-1/b.cast; proof artifacts must not be published — upload them and keep the receipt at .belayd/proof-receipt.json

Refused paths (2):
- docs/proof/bd-1/a.png
- docs/proof/bd-1/b.cast
```

The matching drain tests (refusal, harness-local paths, C-quoted paths, unreadable
diff, `paths` vs one-line `text`):

```bash
node_modules/.bin/vitest run src/__tests__/fleet-merge.test.ts -t "publish payload guard"
```

```text
 ✓ src/__tests__/fleet-merge.test.ts (63 tests | 50 skipped) 2390ms
 Test Files  1 passed (1)
      Tests  13 passed | 50 skipped (63)
```

### 5. Deleting legacy `docs/proof/**` merges cleanly

That is `feat/delete` above (`{"ok":true,"paths":[]}`): the payload is read with
`--diff-filter=ACMRT`, so a deletion never reaches the gate. The dedicated test
deletes a proof artifact and merges, while a branch that deletes one and adds
another is still refused:

```bash
node_modules/.bin/vitest run src/__tests__/fleet-merge.test.ts -t "legacy proof artifact"
```

```text
 ✓ src/__tests__/fleet-merge.test.ts (63 tests | 62 skipped) 211ms
 Test Files  1 passed (1)
      Tests  1 passed | 62 skipped (63)
```

### 6. The panel shows a receipt

Unit level (no browser): `resolveProofReceipt` in
`pi-web-plugins/proof-of-work/discovery.js` is the panel's reader.

```bash
cd /home/hugo/git/feat-bd-181 && node --input-type=module -e '
import { resolveProofReceipt } from "./pi-web-plugins/proof-of-work/discovery.js";
const context = (content) => ({ readFile: async () => { if (content === undefined) throw new Error("Path does not exist"); return { content }; } });
console.log("none     ->", JSON.stringify(await resolveProofReceipt(context(undefined))));
console.log("receipt  ->", JSON.stringify(await resolveProofReceipt(context(JSON.stringify({ version: 1, taskId: "bd-181", id: "up-8f2a91c4", url: "https://proof.example.invalid/up/8f2a91c4", artifactCount: 3 })))));
console.log("http url ->", JSON.stringify(await resolveProofReceipt(context(JSON.stringify({ version: 1, taskId: "bd-181", url: "http://proof.example.invalid/up/8f2a91c4" })))));
console.log("bad json ->", JSON.stringify(await resolveProofReceipt(context("{ nope"))));
'
```

Real output:

```text
none     -> {"kind":"none"}
receipt  -> {"kind":"receipt","receipt":{"version":1,"taskId":"bd-181","id":"up-8f2a91c4","url":"https://proof.example.invalid/up/8f2a91c4","artifactCount":3}}
http url -> {"kind":"invalid","detail":"proof receipt does not match the receipt contract"}
bad json -> {"kind":"invalid","detail":"proof receipt is not valid JSON"}
```

The rendering itself:

```bash
node_modules/.bin/vitest run pi-web-plugins/proof-of-work/panel.test.js pi-web-plugins/proof-of-work/discovery.test.js
```

```text
 ✓ pi-web-plugins/proof-of-work/discovery.test.js (57 tests) 30ms
 ✓ pi-web-plugins/proof-of-work/panel.test.js (15 tests) 162ms

 Test Files  2 passed (2)
      Tests  72 passed (72)
```

**Manual (browser).** Requires a running pi-web with the plugin linked
(`ln -sf "$PWD/pi-web-plugins/proof-of-work" ~/.pi-web/plugins/proof-of-work`,
see `pi-web-plugins/proof-of-work/README.md`):

1. Open a workspace that already lists artifacts, write
   `<workspace>/.belayd/proof-receipt.json` with
   `{"version":1,"taskId":"bd-181","id":"up-8f2a91c4","url":"https://proof.example.invalid/up/8f2a91c4"}`,
   and click ↻ **Refresh**.
   Expected: a **"Proof uploaded"** block above the task list with `Task`,
   `Receipt` and an external `Upload` link, and the artifact list still below it.
2. Replace the receipt with `{"version":1,"taskId":"bd-181","url":"http://x.test/u/1"}`
   and refresh. Expected: **"Proof receipt unreadable."** plus the contract
   detail; the panel keeps working and the artifact list still renders.
3. Delete `.belayd/proof-receipt.json` and refresh. Expected: the block is gone,
   the artifacts remain.

### 7. Cleanup

```bash
rm -rf /tmp/bd181-receipt /tmp/bd181-gate
```

## How to Use

### When to write a receipt

Write one only when the artifacts were actually uploaded to the proof-of-work
platform. Until that platform exists, most beads have **no** receipt and pass the
gate on the external proof root, exactly as before.

`.belayd/proof-receipt.json` (gitignored — never commit it, never copy it into a
published branch):

```json
{
  "version": 1,
  "taskId": "bd-181",
  "id": "up-8f2a91c4",
  "url": "https://proof.example.invalid/up/8f2a91c4",
  "uploadedAt": "2026-10-30T12:00:00Z",
  "artifactCount": 3
}
```

- `version` must be `1`; `taskId` a non-empty string matching the proof task dir.
- At least one of `id` / `url` is required.
- `url` must be an absolute **https** URL with a host and a non-root path. Plain
  `http`, localhost, protocol-relative (`//host/x`) and query-only (`?x=1`) URLs
  are all rejected.
- `id` is a UUID, or at least 8 characters of `[A-Za-z0-9]` containing `-`/`_`.
  Short prose (`done`, `1`, `yes`) is not an id.
- The key set is strict: an unknown key makes the receipt invalid.
- `uploadedAt` and `artifactCount` are optional; `artifactCount` must be a
  non-negative integer.

In code: `writeProofReceipt({ cwd, receipt })` from `src/proof-receipt.ts` (on
the barrel, `src/index.ts`) writes it with parent directories created. By hand:

```bash
mkdir -p .belayd
printf '%s\n' '{"version":1,"taskId":"bd-181","url":"https://proof.example.invalid/up/8f2a91c4"}' \
  > .belayd/proof-receipt.json
```

### What the proof gate does with it

`gateProofContent` resolves in three steps and stops at the first that applies:

1. **Stored receipt** (`.belayd/proof-receipt.json`) — authoritative. Accepted
   even with no `## Receipt` line and no artifact refs. Malformed, unreadable, a
   different `taskId`, or an `http` URL fails closed ("Invalid proof receipt …" /
   "names bd-999, not bd-181 …").
2. **Agent output** `## Receipt` / `receipt: <ref>` line — accepted only when it
   names the stored receipt's `id`/`url`, or, with no stored receipt, when it is
   an absolute **https** URL. An id-only line with no stored receipt fails.
3. **External proof-root artifact refs** — the pre-bd-181 path: refs must exist on
   disk and `.cast` recordings are content-validated.

The honest limitation: the gate asserts that an upload happened and binds it to a
task id; it cannot verify the upload (there is no upload executor yet — bd-174.3
owns `gh`/`git push`). The artifact branch therefore remains **stronger**
evidence, because its refs are existence-checked. A receipt is the cheapest thing
to fabricate; the stored file is what makes it task-bound.

Agent side: proof artifacts **and their helper scripts/logs** must never be
written inside the checkout. Artifacts go to `$BELAYD_PROOF_TASK_DIR/<task-id>`
(exposed as the `proof-of-work/` symlink). The phase output ends with a
level-2 *Receipt* section whose single line is
`receipt: https://proof.example.invalid/up/8f2a91c4` when the upload happened,
otherwise with the `## Artifacts` refs. A receipt section without an https URL is
a refusal, not a fallback.

### When the publish gate refuses

The guard runs in the fleet merge drain (`checkPublishPayload`, before the lock,
the stash and the rebase). A refusal leaves the queue entry `queued`, names the
reason, and keeps the branch untouched.

| Refusal | Meaning | What to do |
| --- | --- | --- |
| `proof-artifacts-in-diff` | the branch **adds, copies, modifies, renames into** or type-changes proof content — `docs/proof/`, `proof/`, `proof-of-work/`, or an accepted proof extension (`.trace.zip`, `.png`, `.jpg`, `.jpeg`, `.cast`) — including a rename whose destination is proof-shaped | upload the proof, write the receipt, `git rm -r` the files, commit |
| `paths-outside-scope` | harness-local (`.belayd`, `.belayd-task.json`, `proof-of-work`), absolute, drive/UNC, `..` traversal or backslash paths, a non-ASCII/lookalike path, or (when the caller declares a payload) a path outside the intended set | rename non-ASCII paths to ASCII; never commit `.belayd/`; keep the payload to intended files |
| `publish-payload-unreadable` | the diff could not be computed | fix the repo/git state; the drain fails closed rather than guessing |

Reading the refusal: `text` is one line, bounded to 10 paths and ending with
`(+N more — the full list is in \`paths\`)`; the complete, deterministically
sorted list is the `paths` field, rendered by `belayd_fleet_merge` as
`Refused paths (N):` with one `- <path>` line each. `reason` is the machine
name; use `paths` to script the fix:

```bash
git rm -r docs/proof/bd-181
```

**Deletions are allowed and are the migration path.** `proof-artifacts-in-diff`
wins over `paths-outside-scope` when a path is both, so fix the proof first.

### Migrating a bead that already has proof in the tree

Legacy committed `docs/proof/**` is not auto-migrated; only proof *carried in* is
stopped. For the task in flight:

```bash
# 1. upload the artifacts to the platform (manual today — no upload executor)
# 2. record the receipt
mkdir -p .belayd
printf '%s\n' '{"version":1,"taskId":"bd-181","url":"https://proof.example.invalid/up/8f2a91c4"}' \
  > .belayd/proof-receipt.json
# 3. remove the in-tree proof and commit
git rm -r docs/proof/bd-181
git rm -r proof-of-work          # only if it is tracked in this repo
git commit -m "chore(proof): move bd-181 proof to the upload platform"
```

`.belayd/proof-receipt.json` stays untracked (`.belayd/` is gitignored); the
drain then sees a payload with no proof in it and merges.

### Behaviour changes to know about

- The proof gate no longer consults a git diff; it never was a files-in-diff
  check, and in-tree content is not evidence either way.
- `http` receipt URLs are rejected everywhere (stored receipt, output line, panel).
  The tuple `(version: 1, id/url shape, strict keys)` is a contract: changing it
  is a `PROOF_RECEIPT_VERSION` bump, mirrored in
  `pi-web-plugins/proof-of-work/discovery.js` (see the SYNC WARNINGs on both sides).
- A receipt is per-checkout bookkeeping — it is not shared with reviewers and it
  is not part of the branch. The external proof root is what reviewers can open
  until the platform exists.

Related: `docs/proof-verifier.md` (receipt resolution and the advisory verifier),
`docs/fleet-merge.md` (drain order and the refusal table),
`pi-web-plugins/proof-of-work/README.md` (panel receipt section).
