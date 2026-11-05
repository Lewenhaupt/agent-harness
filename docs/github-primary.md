# GitHub-primary repos (bd-180)

For a repo that opts into GitHub-primary, **GitHub Issues is the source of truth**
for what work exists and what blocks what. bd stays a projection plus the gates a
relationship graph cannot express. This document is the design record: the
experiment that decided the projection's shape, then the authority, map, drift,
readiness, and append-only rules, and finally what other beads own.

## 1. The experiment: bd 1.3.0 carries no dependency edges

The first acceptance criterion was an experiment, not a design. It ran against
the installed `bd` 1.3.0 in a throwaway repository with two beads (`B` blocked by
`A`). Evidence is captured verbatim in:

- [`docs/proof/bd-180-experiment/experiment.log`](proof/bd-180-experiment/experiment.log)
- re-runnable driver: [`docs/proof/bd-180-experiment/scripts/bd180-experiment.sh`](proof/bd-180-experiment/scripts/bd180-experiment.sh)
- local GitHub REST stand-in: [`docs/proof/bd-180-experiment/scripts/mock-github.mjs`](proof/bd-180-experiment/scripts/mock-github.mjs)

A real GitHub token is not available to the harness, so the driver points bd at
the local stand-in via `GITHUB_API_URL` and reads the exact HTTP requests. That is
stricter evidence than the dry-run summary, which cannot show what a create
payload carries.

Findings:

**(a) Dependency edges are not carried to GitHub.** Every issue-create request
body is `{"body":…,"labels":[…],"title":…}`. No request carries a blocked-by
edge, and no dependency endpoint is called after the creates. `bd dep add` exists
only in local bd state.

**(b) A blocked-by dependency whose blocker has no issue is silently dropped.**
Pushing only the blocked bead succeeds (`✓ Pushed 1 issues`) with no warning, and
the blocker is never named in the request log. The local edge survives, but
GitHub's graph does not know about it, and nothing reports the loss.

Consequence for the design: **the projection must carry edges itself.** bd exposes
no GitHub side to sync, so the harness resolves local dependencies against the
bead ↔ issue map and records every edge it cannot project in
`unmappedDependencies` instead of dropping it.

## 2. One authority per repo

Authority lives next to the publish contract in `<repoRoot>/.belayd/config.json`:

```json
{ "authority": "bd" }
```

```json
{ "authority": "github", "github": { "owner": "acme", "repo": "widgets" } }
```

- `authority` defaults to `"bd"`. Local mode is unchanged: no GitHub read, no
  projection, no gh gate path.
- `authority: "github"` requires `github.owner` and `github.repo`.
- The reader is the same one the publish contract uses (`readRepoConfigObject`
  in `src/fleet-publish.ts`), so both readers see the same bytes and the same
  warnings. Publish behaviour is unchanged.
- An absent, unreadable, or invalid-JSON *file* is a warning plus the `bd`
  default — it never selects GitHub.
- A file that parses but says something **ambiguous is refused**, never narrowed:
  - `authority: "github"` without a valid `owner`/`repo`;
  - both authority markers at once (`authority: "bd"` with a `github` block, a
    `github` block with no `authority`, or an `authority` collection);
  - an unknown authority string;
  - `owner`/`repo` with a leading `-` or a control character (same ref-string
    hardening as the publish remote/base fields).

The reader returns `{ok:true, value, warnings} | {ok:false, error}` and never
throws. A refused config is not coerced to either side; the `bd` tool refuses
phase writes while the authority is ambiguous rather than guessing.

Resolution is against the **session's repo root**, not the raw tool-call cwd:
`.belayd/config.json` is repo-scoped and the cwd may be a subdirectory or a
linked worktree. The root is the parent of git's shared common dir (the same
identity the publish reader uses). If that root cannot be resolved, a phase
session gets `authority unresolved: …` and the write is refused — an unresolvable
root never falls back to local mode.

Config warnings are emitted **once per session** (the key is the warning text on
the session state), so one operator typo in `config.json` does not spam every
phase `bd` call. Only the log line is deduped; every call still re-reads the
config and resolves (or refuses) identically.

## 3. The bead ↔ issue map

`<repoRoot>/.belayd/github-map.json`:

```json
{
  "version": 1,
  "repo": { "owner": "acme", "name": "widgets" },
  "issues": {
    "bd-180": { "number": 42, "nodeId": "I_kwDO…", "title": "…", "updatedAt": "…" }
  },
  "unmappedDependencies": [
    { "beadId": "bd-182", "dependsOnBeadId": "bd-181", "reason": "blocker has no issue" }
  ]
}
```

Both `number` and `nodeId` are stored because the REST API addresses issues by
number while GraphQL relationships use node ids. Parsing, serializing, upsert,
and lookup are pure. Reads and writes take an injected fs seam and never throw:

- absent file → empty map, no warning;
- unreadable or corrupt file → empty map **plus a warning** (the projection can
  still run), and drift reports one `map-unreadable` finding instead of deriving
  `issue-missing` for every bead (a filesystem failure must not look like a sync
  failure);
- a different `version` is **refused** with a typed reason — no throw and no
  silent downgrade, because a future v2 shape must not be read as v1;
- a write **refuses to overwrite** a file it cannot parse (including a future
  version), so an operator can still recover what was there instead of the
  recovery path erasing it.

## 4. Drift classification

Drift reuses the classification pattern from `src/bead-gates.ts`: a typed record
`{ id, kind, message }` plus a one-line renderer, computed purely from injected
facts (map, bead list, issue observations, open gates). No model judgement.

| Kind | Meaning |
|---|---|
| `issue-missing` | an open bead has no map entry, or its mapped issue no longer resolves |
| `issue-closed-bead-open` | GitHub says the issue is closed but the local bead is still open |
| `bead-missing` | the map names an issue for a bead that no longer exists |
| `unmapped-dependency` | a local blocked-by edge has no GitHub issue to project onto; keyed by the edge (`blocked->blocker`) so two blockers out of one bead produce two findings |
| `authority-mismatch` | a GitHub projection was requested for a `bd`-authority repo |
| `map-unreadable` | `github-map.json` could not be read/parsed; replaces all map-derived findings |

`in-sync` is the explicit status when the drift list is empty. Ordering is
deterministic: bead list, then orphaned map entries, then unmapped dependencies.

## 5. Ready = GitHub blockedBy edges + open gates

```
ready(bead) =
    every GitHub blockedBy edge is closed
  ∧ every open local gate is still genuinely waiting
```

- A `human` gate stays open: GitHub cannot answer a person's question.
- A `gh:pr:<n>` gate accepts only bd's strict decimal id grammar: `^\d+$`, a
  positive safe integer, with no sign, whitespace, exponent, hex, or underscore.
  `42` is a PR number; `0x10`, `1e3`, ` 42 `, `+7`, `4_2`, `0`, and `42.0` are
  malformed and degrade to `unknown` instead of retargeting the gate. Numeric run
  ids use the same validator; non-numeric run identities stay workflow names.
- A `gh:run:<name>` gate is checked against injected check-run evidence by name
  or run/check id: `success` → `satisfied-externally`, failure-like conclusions →
  `expired`, running/queued → `open`, absent or unrecognised conclusion →
  `unknown`. A run older than the gate's own `createdAt` is ignored, so a
  re-armed gate cannot read a stale success from an earlier run of the same name.
  Freshness **fails closed**: if either timestamp is missing or unparseable the
  run cannot satisfy the gate and the verdict is `unknown` (the wait stays).
- A `gh:pr`/`gh:run` gate whose `await_id` cannot be parsed is a **malformed
  gate**, not a missing one: it is carried as an `unknown` gate naming the bad
  `await_id` and keeps the wait. Dropping it would report `unblocked` while a
  real wait is open.

**Stale-gate expiry** is the point of the rule. A local gate whose GitHub
condition was already satisfied months ago must not block forever: it is cleared
and reported (`clearedGates`) rather than silently believed. A gate whose
external condition can never be met is also cleared (`expired`) so the projection
does not stall; it is reported distinctly so a caller can re-arm it if needed.

**`unknown` never frees the wait.** A missing PR or run in the evidence is an
evidence gap, not a green light; the bead stays blocked. The same applies to an
unknown `blockedBy` edge. This is the bd-182 rule (degrade, do not guess) applied
to readiness.

Local mode (`authority: "bd"`) computes readiness from local blocked-by edges
only and never classifies a gate or reads GitHub evidence; it does not gain any gh
path.

## 6. Append-only policy for phase agents

In a GitHub-primary repo a phase sub-agent writes **comments and artifacts,
never the work graph**. `classifyBdWrite(argv)` returns:

- `append-only-allowed` for reads and append verbs: `comment`, `note`, `create`,
  `remember`, `tag`, label add/list, `heartbeat`, `update` without graph flags;
- `refused` with a typed reason for status (`update -s/--status`, `--defer`,
  `set-state`, `defer`/`undefer`), assignee (`assign`, `update -a/--assignee`,
  `--owner`), priority (`priority`, `update -p/--priority`), dependency
  (`dep add|remove|relate`, `link`, `update --parent`), closure (`close`), reopen
  (`reopen`), and label mutation (every `bd label` write, including
  `remove`/`rename`/`propagate`, plus `update --remove-label`/`--set-labels`).

Short and attached spellings are the same flag: `-s closed`, `-s=closed`,
`-sclosed`, and `--status=closed` all refuse. The flag forms live once in
`src/bd-command.ts` and are shared with the tool's option validation, so a new
spelling cannot silently escape either layer.

The `bd` tool applies the policy only when the session is a phase sub-agent and
the repo authority is `github`. The human-facing orchestrator is deliberately
exempt: it is the actor that applies GitHub's decisions locally. Under
`authority: "bd"` the policy never refuses, so local mode is byte-for-byte
unchanged.

## 7. Reading a person's answer from issue comments (bd-182)

Under `authority: "github"` the question lands on the **issue**, never the PR, and
the answer is read from there. The shape is unchanged from bd-152: the bd
`human` gate is the durable wait (nothing on GitHub has to represent "waiting"),
the question is an authored comment, the first qualifying comment at/after the
gate's `createdAt` is the answer, delivery is a real user turn, and the gate is
resolved only after a successful send.

Only the read half and the question's channel change:

- **read** — `gh api --paginate --slurp
  repos/{owner}/{repo}/issues/{n}/comments?since=<gateCreatedAt>`. `since` is a
  query parameter (not a `gh` flag), and `--slurp` keeps every page inside one
  JSON document.
- **cursor** — the gate's `createdAt`, not a persisted comment id. bd/GitHub
  timestamps have second granularity, hence `>=`: an answer posted before a
  harness restart is still delivered, because the cursor comes from the gate.
- **channel** — the wait records where the question was actually posted
  (`bd` comment or mapped issue) and the poll reads that recorded channel. A
  later authority/map failure never overrides it; only a wait that predates the
  field resolves once and records the result.
- **identity** — the primary guarantee is the posted question's own comment id:
  `gh api` returns it from the POST and it is excluded from the answer read even
  when `gh` authenticates as a human account. Bot identity is defence in depth:
  an answer is a comment whose author is **not** a bot (`user.type == "Bot"`, a
  case-insensitive `[bot]` suffix, a login in `BELAYD_GITHUB_BOT_LOGINS`) and not
  the authenticated `gh api user` login. If neither the posted id nor that login
  can be determined, the read fails closed (`unknown`) instead of risking a
  self-answered wait.
- **degradation** — `gh` absent, unauthenticated, non-zero exit, or non-JSON
  output is `unknown`, never "no answer yet": the wait stays armed and the gate
  is not resolved.
- **ask** — a GitHub-primary bead with no entry in `.belayd/github-map.json` is
  refused (`exit 1`, naming the bead and the map) and **no gate is opened**, so
  an unanswerable wait cannot block the bead. A failed post compensates through
  the existing gate-resolve path.

Local mode (`authority: "bd"`) keeps the bd-152 path byte for byte: the same bd
comment write, the same `bd comments` read, the same `isHumanComment` filter.

User guide: [`docs/bd-182-userguide.md`](bd-182-userguide.md).

## 8. Not here

This bead owns the authority, map, drift, readiness/expiry, append-only policy,
and the GitHub-primary answer read (§7, bd-182). These are owned elsewhere and
must not be duplicated here:

| Concern | Owner |
|---|---|
| Close-on-merge and `mergedAt` acceptance (the human label's replacement in PR mode) | bd-174.4 / bd-174.10 / bd-174.12 |
| PR body | bd-184 (unbuilt) |
| Token and credential boundary for GitHub access | bd-7 |

The projection does not close beads itself. In PR mode the merge event is the
human's acceptance; the local-mode "never close, the human closes with
`wt merge`" rule stays a local-mode rule.

## 9. Modules

| File | Purpose |
|---|---|
| `src/github-authority.ts` | Authority config (shared repo-config reader) and drift classification |
| `src/github-issue-map.ts` | Bead ↔ issue map: pure parse/serialize/upsert plus never-throw fs seams |
| `src/github-ready.ts` | GitHub-primary readiness and stale-gate expiry |
| `src/github-append-policy.ts` | Append-only bd policy for phase agents |
| `src/github-answer-target.ts` | Resolve the answer channel for one bead (local bd thread vs mapped issue) |
| `src/github-comments.ts` | Issue-comment read/post: guarded argv, tolerant `--slurp` parse, dropped-record count, posted-id + bot identity filter |

Tests: `src/__tests__/github-authority.test.ts`,
`src/__tests__/github-issue-map.test.ts`, `src/__tests__/github-ready.test.ts`,
`src/__tests__/github-append-policy.test.ts`,
`src/__tests__/github-comments.test.ts`, plus the GitHub-primary suite in
`src/__tests__/extension-human-answer.test.ts`.
