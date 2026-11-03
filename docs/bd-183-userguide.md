# Security-class review findings stay out of the PR body until a human says so (bd-183)

Publishing a deferred review finding is a disclosure decision. bd-183 carves out
one class of finding — **security-class** — and gives it a different route: the
orchestrator writes nothing about it to a pull request, the wait moves to the bead
(a bd `human` gate plus the `[belayd:review]` comment), and a human answers with
one of three choices. The raw finding reaches the deferred section bd-184 renders
only if a human chooses **publish as-is** for *that* finding in *that* round;
without a decision nothing about it is published at all, and any other decision
publishes at most a projection of it.

The weak link this bead designs out is *who classifies "sensitive"*. The model
that wrote the finding cannot decide: the verdict is a pure function of the
finding text and a rule table, not of a prompt.

| Piece | Where | What it does |
| --- | --- | --- |
| Classifier | `src/finding-sensitivity.ts` | `classifyFindingSensitivity` — security topics, credential-shaped strings, deny paths, unclassifiable text; text is NFKC-normalised first; borderline is sensitive. **Advisory**: it decides whether a human is asked, not whether text is safe to publish |
| Answer parsing | `src/finding-sensitivity.ts` | `parsePublicationAnswer` (withhold checked before the positive keywords), `redactFindingToOneLiner` |
| Safety surface | `src/finding-publication.ts` | `projectFindingText`, `findProjectionViolations`, `findReassemblyViolations`, `selectPublishableFindings`, `evaluateDeferredFindingsGate`, `renderDeferredFindingsSection` |
| Record | `src/review-findings.ts` | per-finding `sensitivity` / `publication`, `carryForwardSensitivity`, `recordPublicationAnswer`, `releasedPublicationIn` |
| Gate wiring | `extensions/capabilities/human-gate.ts` | `deliverReviewFindings` (gate title/reason say "sensitive findings"), the `AwaitingHuman.reviewFindings` marker, and `recordPublicationChoice` at the single answer choke point — for both the bd comment and the GitHub issue channel |
| Marker type | `src/workflow-phases.ts` | `AwaitingHuman.reviewFindings?: { round: number }` — set only by the review gate of a sensitive record, and only for its own round |

Two things bd-183 deliberately does **not** do: it has no PR writer (bd-184 owns
the `<!-- belayd:deferred -->` body section) and no `gh` invocation (bd-174.3 owns
the publish step). Its guarantee is scoped to what the classifier plus the
projection can actually judge: a classified-sensitive finding never reaches the
deferred section without a recorded human decision, and a **class-mixed** body is
not reassemblable from the published section, because the emitted line is re-read
with every character outside `[A-Za-z0-9+/=_-]` deleted — the string a reader
welds back together by eye — and a body that survives that deletion as a 16+
character token run is redacted wholesale. A body with **no class mixing** can
still survive; that residual is stated in [Honest limits](#honest-limits) rather
than hidden.

## How to Verify

Run everything from the repository root of this checkout. The probes below import
`dist/src/*.js` (the three bd-183 modules are internal — they are not re-exported
from the `src/index.ts` barrel), so build first:

```bash
pnpm build
```

### 1. Gates and the four suites

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test
```

The bd-183 suites on their own:

```bash
node_modules/.bin/vitest run \
  src/__tests__/finding-sensitivity.test.ts \
  src/__tests__/finding-publication.test.ts \
  src/__tests__/review-findings.test.ts \
  src/__tests__/extension-review-gate.test.ts
```

`finding-sensitivity.test.ts` is the classifier table: a *sensitive* group, a
*not sensitive* group, a *borderline* group that must come out sensitive with the
reason kind named, a *normalisation / refuse* group (fullwidth and zero-width
spellings classify through the rules, lookalikes are refused, ordinary typography
publishes), a *hidden joins* group (`pass·word`, `au—th`, `secrets·/prod.yaml`), an
*anchor* group (with the placeholder exemption), a *whitespace-deleted* group
(`ghp_ 16C7 42F2 …`, `passw ord = …`, `id_rs a`), and a *split-invariance*
property test that inserts every separator class at every position of seven
representative secrets.

`finding-publication.test.ts` pins the projection, the blocked/publish/redact/
withhold outcomes, the re-publish and round-reset rules, and the renderer
invariant over an adversarial corpus.

Narrow to one suite or one `it` while debugging:

```bash
pnpm test -t "sensitive deferrals block publication"
pnpm test -t "does not read bare `as is` or bare `include` as publish permission"
```

### 2. The classifier by hand: five evasions and the benign case

```bash
node --input-type=module -e '
const { classifyFindingSensitivity } = await import("./dist/src/finding-sensitivity.js");
const cases = {
  "auth-topic": "`src/a.ts:12` — the auth check is missing on the admin route",
  "credential-shaped": "`src/a.ts:12` — the fixture prints token ghp_16C7e42F292c6912E7710c838347Ae178B4a",
  "deny-path": "`src/a.ts:12` — ~/.ssh/id_rsa is committed to the repo",
  "fullwidth": "`src/a.ts:12` — ＡＵＴＨＯＲＩＺＡＴＩＯＮ never runs",
  "zero-width": "`src/a.ts:12` — pass\u200Bword=16C7e42F292c is logged",
  "homoglyph": "`src/a.ts:12` — src/pr\u043E\u043Ef/x.png is unreviewed",
  "benign typography": "\"src/a.ts:12\" — off-by-one in the loop bound",
  "clean": "`src/a.ts:12` — off-by-one in the loop bound",
};
for (const [label, finding] of Object.entries(cases)) {
  const verdict = classifyFindingSensitivity(finding);
  console.log(label.padEnd(19), String(verdict.sensitive).padEnd(5), JSON.stringify(verdict.reasons));
}'
```

Real output:

```text
auth-topic          true  [{"kind":"security-topic","match":"auth"}]
credential-shaped   true  [{"kind":"security-topic","match":"token"},{"kind":"credential-shaped","match":"ghp_16C7e42F292c6912E7710c838347Ae178B4a"}]
deny-path           true  [{"kind":"deny-path","match":"~/.ssh/id_rsa"},{"kind":"deny-path","match":".ssh"}]
fullwidth           true  [{"kind":"security-topic","match":"AUTHORIZATION"}]
zero-width          true  [{"kind":"credential-shaped","match":"password=16C7e42F292c"}]
homoglyph           true  [{"kind":"unclassifiable-text","match":"\\u{043E}"}]
benign typography   false []
clean               false []
```

Read the six verdicts as the design:

- **auth-topic** — the topic vocabulary, matched on a word boundary (`author` and
  `sessionless` stay out).
- **credential-shaped** — the full token is reported, so the human sees what
  fired, not just the prefix. `token` also fires the topic rule; a bare `token`
  name is a credential mention.
- **deny-path** — the path token *and* the bare `.ssh` directory. A deny
  directory also matches a token that ends at it.
- **fullwidth** — `ＡＵＴＨＯＲＩＺＡＴＩＯＮ` reaches the rules as `AUTHORIZATION`
  because the text is NFKC-normalised before matching, and the recorded `match`
  shows the folded form.
- **zero-width** — the zero-width space (`\u200B`) is a `Cf` format character and
  is removed before matching, so `pass\u200Bword=…` is the assignment
  `password=…` again.
- **homoglyph** — a Cyrillic `о` has no NFKC fold, so it is **refused**, not
  guessed: `unclassifiable-text` with the offending code point escaped
  (`\u{043E}`).
- **benign typography** and **clean** — straight quotes and an em dash around a
  path are punctuation, and `off-by-one in the loop bound` names no security topic,
  so both publish without a question.

### 3. A sensitive deferral with no decision: gate closed, section empty

```bash
node --input-type=module -e '
const rf = await import("./dist/src/review-findings.js");
const pub = await import("./dist/src/finding-publication.js");
const text = "## Critical (must fix)\n- `src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged";
const record = rf.buildReviewFindingsRecord({ taskId: "bd-183-demo", text });
console.log("sensitive:", record.findings[0].sensitivity.sensitive);
console.log("gate:     ", JSON.stringify(pub.evaluateDeferredFindingsGate(record)));
console.log("section:  ", JSON.stringify(pub.renderDeferredFindingsSection(record)));
console.log("decision: ", JSON.stringify(record.findings[0].publication));'
```

Real output:

```text
sensitive: true
gate:      {"ok":false,"reason":"sensitive-findings-awaiting-human","findings":["`src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged"]}
section:   ""
decision:  undefined
```

`buildReviewFindingsRecord` classifies every finding and deliberately records **no**
`publication` field, so a freshly built record is always in the withheld state for
a sensitive finding. That is the whole mechanism behind "nothing reaches the PR
body unasked": the gate refuses, the section is empty, and `bd-184` has nothing to
render. Pinned by `finding-publication.test.ts` › `sensitive deferrals block
publication` › `renders nothing and refuses the gate before a human answer`, and
end-to-end by `extension-review-gate.test.ts` › `opens one gate with the
disclosure wording and blocks publishing`.

A **mixed** record behaves differently on purpose: the non-sensitive deferrals stay
publishable while one sensitive finding waits, so an unrelated security finding
cannot hold the whole PR hostage. The gate still says `ok: false`, and the section
holds only the projected non-sensitive bullets:

```bash
node --input-type=module -e '
const rf = await import("./dist/src/review-findings.js");
const pub = await import("./dist/src/finding-publication.js");
const text = ["## Critical (must fix)",
  "- `src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged",
  "", "## Warnings (should fix)", "- `src/a.ts:12` — off-by-one in the loop bound"].join("\n");
const record = rf.buildReviewFindingsRecord({ taskId: "bd-183-demo", text });
console.log(JSON.stringify(pub.evaluateDeferredFindingsGate(record)));
console.log(JSON.stringify(pub.renderDeferredFindingsSection(record)));'
```

```text
{"ok":false,"reason":"sensitive-findings-awaiting-human","findings":["`src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged"]}
"### Deferred findings\n- [code] - off-by-one in the loop bound"
```

### 4. The three answers, and what each does to the section

```bash
node --input-type=module -e '
const rf = await import("./dist/src/review-findings.js");
const pub = await import("./dist/src/finding-publication.js");
const j = (v) => JSON.stringify(v);
const text = "## Critical (must fix)\n- `src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged";
const record = rf.buildReviewFindingsRecord({ taskId: "bd-183-demo", text });
for (const answer of ["publish as-is", "publish a redacted one-liner", "withhold", "publish after we rotate the key"]) {
  const answered = rf.applyPublicationAnswer(record, answer);
  console.log(answer.padEnd(33), j(pub.evaluateDeferredFindingsGate(answered)));
  console.log("".padEnd(33), j(pub.renderDeferredFindingsSection(answered)));
  console.log("".padEnd(33), j(answered.findings[0].publication));
}'
```

Real output:

```text
publish as-is                     {"ok":true,"publishable":[{"finding":"`src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged","text":"`src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged"}]}
                                  "### Deferred findings\n- `src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged"
                                  {"kind":"publish","source":"human","answer":"publish as-is"}
publish a redacted one-liner      {"ok":true,"publishable":[{"finding":"`src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged","text":"[redacted]"}]}
                                  "### Deferred findings\n- [redacted]"
                                  {"kind":"redact","source":"human","answer":"publish a redacted one-liner","oneLiner":"[redacted]"}
withhold                          {"ok":false,"reason":"sensitive-findings-withheld","findings":["`src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged"]}
                                  ""
                                  {"kind":"withhold","source":"human","reason":"the human withheld permission to publish this finding"}
publish after we rotate the key   {"ok":false,"reason":"sensitive-findings-withheld","findings":["`src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged"]}
                                  ""
                                  {"kind":"withhold","source":"default","reason":"the reply was conditional or not one of the three publication options; the finding stays withheld"}
```

- **publish as-is** is the one path that emits the raw finding (token, backticks and
  all), because the human read *that* finding and released it. The bullet is still
  forced onto one line and HTML comment delimiters and backtick/tilde fence runs
  are still neutralized, so a released finding cannot forge a bd-174.3 marker or
  swallow the rest of the body.
- **redact** renders the recorded `oneLiner`, itself re-projected on every render.
  For this finding the one-liner is the wholesale `[redacted]`, because a reading
  found an anchor (`ghp_`) whose secret no mask can reach. A finding whose only
  reason is a topic word keeps its prose:

  ```bash
  node --input-type=module -e '
  const rf = await import("./dist/src/review-findings.js");
  const pub = await import("./dist/src/finding-publication.js");
  const text = "## Warnings (should fix)\n- `src/a.ts:12` — the session cookie is never rotated";
  const record = rf.buildReviewFindingsRecord({ taskId: "bd-183-demo", text });
  const answered = rf.applyPublicationAnswer(record, "publish a redacted one-liner");
  console.log(JSON.stringify(answered.findings[0].publication.oneLiner));
  console.log(JSON.stringify(pub.renderDeferredFindingsSection(answered)));'
  ```

  ```text
  "[redacted] — the session cookie is never rotated"
  "### Deferred findings\n- [redacted] - the session cookie is never rotated"
  ```

  Note the em dash: the projection folds benign typography to ASCII, so the
  published bullet carries `-`, not `—`.
- **withhold** blocks that finding and reports `sensitive-findings-withheld`. An
  explicit withhold outranks an unanswered one, because "a human said no" is a
  final answer.
- **any other reply** — here the conditional "publish after we rotate the key" —
  becomes `withhold` with `source: "default"`, and the section stays empty.

### 5. A re-review resets the decision, and a stale decision cannot be reused

```bash
tmp=$(mktemp -d) && BD183_TMP=$tmp node --input-type=module -e '
const rf = await import("./dist/src/review-findings.js");
const pub = await import("./dist/src/finding-publication.js");
const j = (v) => JSON.stringify(v);
const cwd = process.env.BD183_TMP;
const text = "## Critical (must fix)\n- `src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged";
const save = (record) => rf.writeReviewFindingsRecord({ cwd, record });
const build = () => rf.carryForwardSensitivity({ record: rf.buildReviewFindingsRecord({ taskId: "bd-183-demo", text, round: rf.nextReviewRound({ cwd }) }), previous: rf.readReviewFindingsRecord({ cwd }) });
save(build());
console.log("round 1:  ", rf.readReviewFindingsRecord({ cwd }).round);
console.log("answer:   ", j(rf.recordPublicationAnswer({ cwd, answer: "publish as-is", round: 1 })));
console.log("released: ", rf.releasedPublicationIn(rf.readReviewFindingsRecord({ cwd })));
save(build());
const round2 = rf.readReviewFindingsRecord({ cwd });
console.log("round 2:  ", round2.round, "decision:", j(round2.findings[0].publication), "sensitive:", j(round2.findings[0].sensitivity.sensitive));
console.log("stale:    ", j(rf.recordPublicationAnswer({ cwd, answer: "publish as-is", round: 1 })));
console.log("gate:     ", j(pub.evaluateDeferredFindingsGate(round2)));
console.log("section:  ", j(pub.renderDeferredFindingsSection(round2)));
console.log("reason:   ", rf.reviewFindingsGateReason(round2, { previousDecisionsReset: true }));
console.log("title:    ", rf.reviewFindingsGateTitle({ taskId: "bd-183-demo", round: 2, sensitive: true, previousDecisionsReset: true }));'
rm -rf "$tmp"
```

Real output:

```text
round 1:   1
answer:    {"ok":true,"recorded":true}
released:  true
round 2:   2 decision: undefined sensitive: true
stale:     {"ok":true,"recorded":false,"cause":"round-mismatch"}
gate:      {"ok":false,"reason":"sensitive-findings-awaiting-human","findings":["`src/auth/session.ts:42` — token ghp_16C7e42F292c6912E7710c838347Ae178B4a is logged"]}
section:   ""
reason:    workflow is waiting for a review response — sensitive findings need a publication decision: publish as-is, publish a redacted one-liner, or withhold (default) — previous publication decisions were reset by this re-review; answer again if you still want them published
title:     belayd-review: bd-183-demo sensitive findings (round 2; previous decisions reset)
```

`applyPublicationAnswer` never carries a decision into a rebuilt record, and
`recordPublicationAnswer` refuses a round it does not own (`round-mismatch`), so a
round-1 "publish" can never release the round-2 text. What *is* carried across
rounds is the sensitivity verdict (`carryForwardSensitivity`), so a rule table that
weakens cannot turn an already-flagged finding publishable. Pinned by
`review-findings.test.ts` › `applyPublicationAnswer / recordPublicationAnswer` ›
`refuses a decision for a different round` and `drops a recorded decision when the
same findings are rebuilt for a new round`, and by
`extension-review-gate.test.ts` › `announces and drops publication decisions when
a re-review resets the round`.

### 6. The projection invariant, and two adversarial splits

```bash
node --input-type=module -e '
const pub = await import("./dist/src/finding-publication.js");
const j = (v) => JSON.stringify(v);
const rows = {
  "chunked token (space-split)":            "src/a.ts:12 — the header is abcd1234 efgh5678 ijkl9012 mnop3456 verify",
  "delimiter-split token (comma)":          "the header is abcd12,34efgh,56ijkl,90mnop,12qrst,34uvwx verify please",
  "class-mixed body behind a marker":       "gh.p_ 16C7 2E77 47Ae 178B — rotate it",
  "prose (must survive)":                   "src/a.ts:12 — the retry loop allocates 3 times on every iteration",
  "survivor: one case, digits at one end":  "src/a.ts:12 — dead,beef,dead,beef",
};
for (const [label, finding] of Object.entries(rows)) {
  const projected = pub.projectFindingText(finding);
  console.log(label);
  console.log("  projected: ", j(projected));
  console.log("  violations:", j(pub.findProjectionViolations(projected)));
  console.log("  reassembly:", j(pub.findReassemblyViolations(projected)));
}'
```

Real output:

```text
chunked token (space-split)
  projected:  "[redacted]"
  violations: []
  reassembly: []
delimiter-split token (comma)
  projected:  "[redacted]"
  violations: []
  reassembly: []
class-mixed body behind a marker
  projected:  "[redacted]"
  violations: []
  reassembly: []
prose (must survive)
  projected:  "[path] - the retry loop allocates 3 times on every iteration"
  violations: []
  reassembly: []
survivor: one case, digits at one end
  projected:  "[path] - dead,beef,dead,beef"
  violations: []
  reassembly: []
```

`findProjectionViolations` is the unit invariant — single line, printable ASCII,
no backtick, no 16+ opaque run, no path-like token, and nothing reassemblable — and
every projection satisfies it by construction. Three things to look at:

- **A split token is redacted.** In the first two rows each chunk is under 16
  characters, so neither the contiguous-run rule nor the classifier sees anything
  (the comma row classifies **clean**: `classifyFindingSensitivity` returns
  `sensitive: false`). The comma row is `[redacted]` anyway, because the canonical
  reading welds `abcd1234efgh56ijkl90…` into one 36-character run and the
  interleaved-digit arm fires (a digit with letters on both sides). The third row
  is the same weld with a punctuation-broken anchor (`gh.p_`) in front of it. This
  is the point of having the projection rather than trusting the classifier.
- **Prose survives, and the invariant still holds.** `the retry loop allocates 3
  times…` keeps its words; the path is replaced by `[path]`.
- **The last row is the documented residual.** `dead,beef,dead,beef` is one case
  with no interleaved digit, so it welds into `deadbeefdeadbeef` and is still not
  "reassemblable" by the guard's definition: it publishes as written and a human
  reading the bullet can put it back together. See [Honest limits](#honest-limits).

Pinned by `finding-publication.test.ts` › `renderer invariant — the projection
holds for every finding` and › `a whitespace-chunked body cannot be reassembled
from the section` (which includes the round-12 comma row, `redacts a comma-split
body (round-12 Critical)`), and by `finding-sensitivity.test.ts` ›
`classifyFindingSensitivity — split invariance (property)`.

### 7. The real gate, the answer, and cleanup

Run a workflow whose review reports a security-class finding. `deliverReviewFindings`
then writes the record, creates the gate, posts the `[belayd:review]` comment and
arms the wait. What the bead shows:

- gate title: `belayd-review: <bead> sensitive findings (round N)` (plus
  `; previous decisions reset` when a re-review dropped a release);
- gate reason: the shared review wait plus `— sensitive findings need a
  publication decision: publish as-is, publish a redacted one-liner, or withhold
  (default)`;
- comment: the bd-175 body, with `— **sensitive** (publication decision required)`
  appended to each sensitive finding, plus the
  `### Sensitive findings — publication decision required` section naming the
  three options verbatim.

Answer the gate (a comment on the bead, a comment on the mapped GitHub issue under
GitHub-primary, or `bd gate resolve <gate> --reason "publish as-is"`). The session
then gets one extra line after the usual `"<author> answered: …"` text — see
[The answer message](#the-answer-message) — and the choice appears in
`.belayd/review-findings.json` under `findings[].publication`.

The whole path is pinned by `extension-review-gate.test.ts` ›
`sensitive review findings (bd-183)`: `opens one gate with the disclosure wording
and blocks publishing`, `records the human's publication choice when the answer is
delivered`, `records a redact answer on the bd comment channel, never the raw
finding`, `records a publication choice answered on a GitHub issue`, `records
redact and withhold choices answered on a GitHub issue`, `ignores an unrelated
ask-human answer in the same worktree`, `withholds by default when the gate is
resolved without an answer`, and `says why a recording was refused, per cause`.

The temp directory from step 5 is removed by its own `rm -rf`; nothing else in the
worktree is written.

## How to Use

### What the operator sees

A sensitive finding does not change the existing review flow: the same human gate
opens, on the same bead (or mapped issue), and the same `[belayd:review]` comment is
posted. What is added:

- the marker `— **sensitive** (publication decision required)` after that finding
  in the comment, so you can see *which* finding needs a decision;
- the section that spells out the three options — `publish as-is`, `publish a
  redacted one-liner`, `withhold` (default) — and the sentence that nothing about
  the finding is published unless a human says so;
- `sensitive findings` in the gate title and the disclosure wording in the gate
  reason, so `bd`/needs-you shows the question instead of an ordinary review wait.

The comment quotes the findings verbatim, sensitive text included: that is the
surface where you read the finding in order to decide. bd-183 writes **no** PR
body at all; the PR surface belongs to bd-184, which reads only
`renderDeferredFindingsSection`.

### The three replies (exact spellings)

One answer covers every sensitive finding in that round's record. Replies are
lower-cased, whitespace-collapsed, stripped of surrounding quotes/backticks and of
trailing punctuation (`. ! ; , …`), and curly apostrophes are unified — then
matched **whole**, not by keyword:

| Choice | Accepted replies |
| --- | --- |
| **publish as-is** | `publish`, `publish it`, `publish this`, `publish that`, `publish as-is`, `publish as is`, `include it`, `ship it` — optionally wrapped in `please` (`please publish as-is`, `publish as-is please`) |
| **publish a redacted one-liner** | `publish a redacted one-liner`, `publish the redacted version`, `publish the redacted summary`, `publish redacted`, `redact`, `redacted`, `redact it`, `redact one-liner`, `one-liner`, `summarize` / `summarise this` |
| **withhold** (default) | `withhold`, `withhold it`, `withheld`, `no`, `skip`, `skip it`, `do not publish`, `don't publish it` |

Order is part of the contract: the withhold forms are checked first, so a negation
is never read as the positive keyword inside it; redaction is checked before
publication, so `publish a redacted one-liner` is not a publish; and any other
text is a **default withhold**.

Three things that look like permission and are not:

- a **conditional or temporal** reply ("publish after we rotate the key", "once CI
  clears", "not yet", "when it is fixed") is recorded as withhold with
  `source: "default"` and the reason *"the reply was conditional or not one of the
  three publication options; the finding stays withheld"*;
- **`as is`** on its own and **`include`** on its own are not permission — they are
  ordinary answers to the disposition question asked in the same comment. Only
  `publish as-is` (or `include it`) is; a human typing "as is, please" is why the
  bare forms are excluded;
- any other free text ("yes", "lgtm", "option b", "publish but only the redacted
  version") records a default withhold with *"no publication choice was
  recognized; the finding stays withheld"*.

Resolving the gate with no reason at all (`bd gate resolve <gate>`) is the same
default withhold, so nothing can be published by resolving.

### The answer message

The answer is delivered as a normal user turn, then one line is appended. When the
choice was recorded:

```text
Sensitive findings: publication choice "publish" is recorded in .belayd/review-findings.json; nothing about them may appear in a PR unless that choice is publish (it is re-read from the record on every publish).
```

When it was not, the line names one of three causes:

| Cause | Line | What to do |
| --- | --- | --- |
| `no-record` | no review record was found, so the publication choice was not recorded and they stay withheld | the record is missing or corrupt — re-run the review phase so a fresh gate (and record) is opened, then answer that one |
| `round-mismatch` | the review record is no longer round N, so the publication choice was not recorded and they stay withheld — answer the current review gate | the record moved on (a re-review landed); answer the current round's gate |
| `no-sensitive-findings` | the review record has no security-class finding any more, so there was no publication choice to record | nothing to do |
| write failure | the publication choice could not be recorded, so they stay withheld | a read-only worktree or a failed rename — every cause is fail-closed, so nothing publishes |

Only a review wait with sensitive findings records a decision. The wait carries an
`AwaitingHuman.reviewFindings = { round }` marker, set by `deliverReviewFindings` and
by nothing else, so an unrelated `belayd_ask_human` reply typed in the same
worktree (even `publish as-is`) can never release a withheld finding: the ask
wait has no marker, so no recording happens.

### What the deferred section will and will not contain

`renderDeferredFindingsSection(record)` is the only supported source of deferred
text for a PR body. It re-derives from `.belayd/review-findings.json` on every
call, so a re-publish cannot leak a finding whose decision was never recorded.

- **Candidates**: only `disposition.kind === "deferred"` findings. `fixed` was
  addressed and `rejected` was declined, so neither is rendered.
- **Caps**: at most 5 items (`maxItems`) and 200 code points per item
  (`maxFindingChars` — truncation ends in ASCII `...`). `""` when nothing may be
  published; bd-184 owns the `<!-- belayd:deferred -->` marker pair and should emit
  no markers for an empty string.
- **Shape**: `### Deferred findings` plus one `- …` bullet per finding. Every bullet
  is the **projection**, whatever the classifier said — no code span, no path token,
  no opaque run of 16+ characters, no non-ASCII, single line:

  | The projection replaces | With |
  | --- | --- |
  | HTML comment delimiters (`<!--`, `-->`) | `[code]`, so no bullet can forge a bd-174.3 marker pair |
  | fenced blocks, inline code spans, every backtick run of 2+, every tilde run of 2+, an orphan backtick | `[code]` |
  | path-like tokens (a slash, a leading `~`, a letter-led file extension) | `[path]` |
  | assignment values (`key[:=]value`) | `[value]` |
  | opaque runs of `[A-Za-z0-9+/=_-]{16,}` | `[value]` |
  | benign typography (`—`/`–`, curly quotes, `…`) | `-`, `'`, `"`, `...` |
  | whitespace runs and newlines | one space, one line |
  | every other character outside printable ASCII (accents, lookalikes) | `?` |
  | a canonical reading that welds a 16+ token run or a structural path | the whole bullet: `[redacted]` |

- **The one exception**: a finding with a recorded `publish` decision renders its
  raw text (capped, single-line, with comment delimiters and fence runs still
  neutralized, and its non-ASCII text kept as written — that is the text the human
  released). Everything else — including a `redact` decision's one-liner — goes
  through the projection again on every render.
- **Never**: the record's `findings[].finding` field. That is the raw text and is
  for diagnostics and for matching a rendered line back to the record only.

A mixed record is not an error: while one sensitive finding waits, the section
still renders the non-sensitive deferrals and `evaluateDeferredFindingsGate` reports
`{ ok: false, reason, findings }` naming what is being withheld. Publish the
rendered section; treat the gate verdict as "something in this round is not
publishable yet", not as "publish nothing".

### `unclassifiable-text`

The classifier met a character it will not guess at: a letter lookalike from
another script (Cyrillic/Greek `а е о р с у х`, math alphanumerics) or any other
non-ASCII that is not ordinary typography (`café.png`, `naïve`). The finding is
sensitive by rule, so publishing it raw is never automatic — and the reason's
`match` tells you which code point stopped it (`\u{043E}`).

The fix belongs in the finding, not in the gate: rewrite that word in ASCII
(`prоof` → `proof`, `café.png` → `cafe.png`), let the next round re-classify it,
and it publishes normally if nothing else fires. Ordinary typography is **not** a
problem and needs no rewrite: em/en dashes, curly quotes, ellipsis, `§`, `•`, `·`,
`°` and non-breaking/thin spaces are exempt (NFKC folds the last two to plain
spaces). You can still answer the gate: `publish as-is` accepts the raw text, and
`redact` gives you a one-liner with `?` in place of each refused character and the
typography intact — `[redacted] — caf? is not validated` for a finding whose code
span held a path (a one-liner never trusts a code span, so the span itself becomes
`[redacted]`).

### When the record has no decision, and when it is corrupt

- **No decision for this round** (a fresh review, or one whose round the answer
  missed): answer again — either on the gate/comment that is still open, or by
  re-running the review phase so a new round's gate opens. Nothing publishes in the
  meantime; that is the default, not a failure.
- **Answer recorded for round N, record now round N+1**: the reset is announced in
  the gate title, the gate reason and the comment (`previous publication decisions
  were reset by this re-review; answer again if you still want them published`), and
  only when the earlier round had actually released something (`publish` or
  `redact`). A previous round that only withheld announces nothing, because it never
  released anything to reset.
- **Corrupt record** (unparsable JSON, a wrong `schemaVersion`, or a `sensitivity`
  verdict that breaks "reasons empty iff not sensitive"): it reads as *no record*.
  Fail-closed in every direction — `recordPublicationAnswer` reports `no-record`,
  a publication gate has nothing to render, and the next review delivery rebuilds
  and overwrites the file. Re-run the review phase and answer the new gate.
- **Record written before bd-183** (`schemaVersion` still `1`, no `sensitivity`
  field): classified on read, and treated as having no decision, so it blocks. The
  version stays `1` on purpose — bumping it would make every in-flight round read as
  "no record" and drop the round count and the findings you are answering.

### From code (bd-184 and any body builder)

```ts
import { readReviewFindingsRecord } from "./review-findings.js";
import {
  evaluateDeferredFindingsGate,
  renderDeferredFindingsSection,
} from "./finding-publication.js";

const record = readReviewFindingsRecord({ cwd });
if (record === undefined) {
  // No record ⇒ no deferred section. Never fall back to the artifact text.
} else {
  const gate = evaluateDeferredFindingsGate(record);
  // gate.ok === false: some sensitive finding is awaiting a human or withheld.
  // The section still carries whatever IS publishable (a mixed record).
  const section = renderDeferredFindingsSection(record); // "" when nothing may publish
  // write `section` between the <!-- belayd:deferred --> markers (bd-174.3), or
  // omit the marker pair entirely when it is empty.
}
```

Rules for that caller:

- read the record through `readReviewFindingsRecord`, never by parsing the JSON
  yourself — it is the only place the pre-bd-183 and corrupt-record cases are
  handled;
- never read `findings[].finding`;
- do not "improve" the text: `renderDeferredFindingsSection` caps, projects and
  redacts; re-processing it can only re-introduce what the projection removed, and
  the keyed `publish` exception would be silently discarded;
- if you need the strings without the markdown scaffolding, use
  `selectPublishableFindings(record)` — same projected `text` values, no heading.

## Honest limits

The guarantee is scoped. Stating the edges is part of the design, and every claim
below is a property of the code in `src/finding-publication.ts` and
`src/finding-sensitivity.ts`, not an aspiration.

### The three no-class-mixing survivors

A body is redacted wholesale only when the canonical reading welds it into a 16+
character run that passes the guard: interleaved digits (`16C7e42F…`,
`8f14e45f…`, a UUID), or case flips on at least a third of its letter pairs
(base64). Three shapes have **no class mixing at all**, so they are
indistinguishable from welded prose and publish verbatim:

| Survivor | Example (as it publishes) |
| --- | --- |
| one case, digits only at one end (lowercase base36/base32-style) | `deadbeefdead beef`, `dead,beef,dead,beef`, `mfrggzdfmzt wq2lk`, `0123456789 abcdef` |
| all-uppercase letter runs | `ABCDEFGHIJ KLMNOP` |
| all-digit runs | `1234567890 123456` |

A human reading such a bullet can put it back together by eye. That is a real
disclosure the gate never saw, not merely a lost summary — and it is why the
classifier's **anchors** (`ghp_`, `AKIA`/`ASIA`, PEM headers, `ssh-rsa`,
`authorization: bearer`, `.env`, `id_rsa`, `.ssh`, `credentials`) carry
the weight for the families that have one. The family is specifically the
**chunked** form: unsplit, the same body is caught by the projection's opaque-run
rule (`deadbeefdeadbeef` publishes as `[value]`); split into pieces shorter than
16 characters it is indistinguishable from two words. Separating the three shapes
from prose would take a dictionary; redacting every long single-case run wholesale
would eat genuine sentences and numeric configuration (`the retry loop allocates on
every iteration` welds to a 37-character lowercase run). The trade is documented
here rather than guessed at, and bd-223 is the follow-up that hardens it.

### Over-fires that are the design, not a bug

The classifier is over-inclusive on purpose: an extra human question is
recoverable, a published token is not. These are the false positives an operator
meets; every row was run against this tree:

| A gate opens for | Example | Why accepted |
| --- | --- | --- |
| any bare `token`/`secret`/`credential` noun | `the token bucket rate limiter is too small` → `security-topic: token` | without it the split `tok§en` / `tok en` is invisible; a placeholder (`password=<token>`, `${TOKEN}`, `{{ token }}`) is still exempt |
| any anchor, wherever it appears | `risk-free retry` and `task-oriented split` → `credential-shaped: sk-`; a finding that merely names `ghp_` gates | an anchor is meaningless without a secret behind it, so its presence *is* the question |
| a deny directory at the end of a token, and a bare dot-directory | `wiki/src/auth` → `deny-path: wiki/src/auth`; `the .ssh folder` → `deny-path: .ssh` | `~/.ssh` with no trailing slash otherwise evades `.ssh/` |
| a wrapped line joining under the compact reading | `the item.p` + newline + `em class is wrong` → `deny-path: item.pem (separators removed)` | fail-closed against a missed `id_rs a`; the note is load-bearing, because the match is not verbatim |
| a sentence welded by the whitespace-deleted reading | `line 42: the loop allocates 3 times` → `credential-shaped: :theloopallocates3times (whitespace removed)` | deleting every space is the only join no split can outgrow; the entropy test (a digit, an upper-case letter, `/`, `+` or `_`, plus at least one letter) keeps most prose out |
| a key-less assignment whose welded value mixes classes | `port = 1234567890123456 is hardcoded` gates, while `port = 1234567890123456` alone does not | a number is configuration; a value welded to prose is what a leak looks like |
| a body the projection welds into a token run | `top 10 and 20 items per batch` and `the IPv6 address 2001 is misparsed` publish as `[redacted]` | the alternative is a partly masked line that still carries the body's shape |

### Title-Case prose is redacted wholesale — a cost, and it depends on the whole bullet

The case-flip arm fires on prose written in Title Case: `The Retry Logic Is
Bounded` and `A Bug In The Main Path Handler` publish as `[redacted]`, as does
`the GitHub API is slow` (exactly 6 flips on its 18 welded characters — the
threshold is `ceil(length / 3)`). `the Backtrace Shows IPv6 Fallbacks` survives (7
flips on 30). The density is computed over the **whole emitted bullet**, so adding
prose to a boundary sentence changes the verdict: `src/a.ts:12 — the GitHub API is
slow` publishes as written, because the path marker and the extra words dilute the
density (`paththeGitHubAPIisslow`, 6 flips on 22 characters). The direction is
safe — a lost summary, not a published secret — and it is pinned by a test rather
than left to be discovered.

### What the classifier cannot see

- **An ASCII punctuation insertion inside an anchor or a shape.** `gh-p_16C7…` and
  `gh.p_16C7…` are different strings, not spaced ones, so the classifier calls them
  clean. Making the anchor fuzzy would make every short anchor match everything. The
  publish path still catches a **class-mixed** body split that way, because the
  canonical reading deletes the punctuation and welds the chunks — but a
  no-class-mixing body split that way is the residual above.
- **A secret with no anchor at all.** A bare hex blob
  (`8f14e45fceea167a5a36dedd4bea2543` with no `=` or key in front of it, no `.env`,
  no `ghp_`, no `token =`) is indistinguishable from a commit id or a content hash
  and classifies clean. If a finding quotes such a value, name the anchor next to it
  (`token = 8f14…`, `ghp_…`, `.env`) and the next round classifies it; the
  projection's opaque-run rule also replaces it in the published bullet.
- **A key-less assignment depends on what follows it.** `port =
  1234567890123456` and `uuid = 550e8400-…` on their own classify clean, but the
  same line followed by prose (`port = 1234567890123456 is hardcoded`) gates: the
  whitespace-deleted reading welds the value to the next word, and the weld mixes
  classes. Over-match costs one question; that is the direction chosen.

### Operational limits

- **A restart-discovered wait cannot record a decision.** `reviewFindings` is set
  only by `deliverReviewFindings`, so a wait re-armed from an open gate after a
  session restart delivers the human's answer as a user turn but records **no**
  publication decision. Fail-closed: the findings stay withheld, and the decision
  needs a fresh review round (and its gate) to be recordable. This is what keeps an
  unrelated answer from releasing a withheld finding; the cost is that a restart
  loses the recording path, not the wait.
- **The gate comment quotes the finding text verbatim.** That is where the human
  reads what they are deciding about. bd-183 writes nothing to a PR body; the
  comment goes to the bead, or under GitHub-primary to the mapped issue
  (bd-182). The PR surface is bd-174.3/bd-184.
- **One answer covers every sensitive finding of the round.** The gate does not ask
  per finding; `publish as-is` releases the raw text of *all* sensitive findings in
  that record. If one of them must not be published, choose `redact` or `withhold`
  and let the orchestrator fix the misfire in the next round.

### Follow-up

bd-223 hardens the reassembly detector, specifically the no-class-mixing survivor
families above. Until it lands, treat those families as "redacted preview only":
they publish as written.

## Maintainer notes

### Where a rule goes

| Table | File: symbol | For |
| --- | --- | --- |
| security topics | `src/finding-sensitivity.ts`: `SECURITY_TOPIC_RULES` | a word-boundary match for the auth/crypto/secret/session/env vocabulary |
| credential shapes | `src/finding-sensitivity.ts`: `CREDENTIAL_SHAPED_RULES` | a fixed-prefix token, a PEM block, a JWT, a bearer header, a URI userinfo, a `key = value` assignment |
| deny paths | `src/finding-sensitivity.ts`: `FINDING_DENY_PATH_PATTERNS` | a path that is sensitive by location |
| anchors | `src/finding-sensitivity.ts`: `FINDING_CREDENTIAL_ANCHORS` | a substring with no innocent reading; survives any split |
| exempt typography | `src/finding-sensitivity.ts`: `BENIGN_TYPOGRAPHY` | punctuation only — nothing a reader could mistake for a letter or digit |

Every rule addition needs three things: a `// why` comment stating the evasion it
closes, a row in the classifier table in **both** directions (a matching row and a
near-miss that must stay clean), and — for an anchor — the family it belongs to
(`credential-shaped` or `deny-path`). Prefer an anchor over a whole-token pattern
whenever the secret's body cannot be described: an anchor needs no reconstruction
and therefore survives any split. Write patterns for the **normalised** text
(ASCII), never for a specific homoglyph.

A new reason *kind* is a change to `FindingSensitivityReasonSchema` — the TS type
is inferred from the zod schema, and `src/review-findings.ts` validates the record
on disk with that same declaration, so the writer and the disk validator cannot
drift. The same applies to `FindingPublicationDecisionSchema`. Bumping
`schemaVersion` is deliberately not the tool for this: it would discard every
in-flight round.

### Why the classifier is advisory, and the projection is the guarantee

The classifier answers "should a human be asked?", and it is over-inclusive on
purpose. "Is this string a secret?" is unbounded pattern recognition against an
adversary who can insert separators, homoglyphs or brackets — every review round
of this bead found another evasion, and the anchor rule exists because
reconstruction cannot be won (a window that joins N words is escaped by a split
into N+1).

The publish path therefore does not depend on the classifier's answer:
`projectFindingText` runs on **every** deferred finding, whatever the verdict, and
replaces everything a secret could hide in. An under-match on a class-mixed body is
still caught, because the projection judges the emitted line, not the finding's
label. The classifier's remaining job is the human question: over-match costs one
answer, under-match on an anchored family costs a disclosure — which is why the
rules lean the other way.

`isSensitiveFinding` is the live classifier **OR** the stored verdict, never the
stored field alone: the record file is editable and can predate a rule, so a
hand-edited `sensitive: false` must not release text; conversely a rule table that
weakens between rounds must not make an already-flagged finding publishable, which
is what `carryForwardSensitivity` guarantees on the `deliverReviewFindings` write
path (a monotonic table is *not* the mechanism — removing that carry-forward
re-opens the hole).

### The canonical reading is the one place to reason about a split

`findReassemblyViolations` is the safety boundary, and it has exactly one reading:

```ts
const REASSEMBLY_DELETED_PATTERN = /[^A-Za-z0-9+/=_-]+/gu; // delete everything else
```

That is the string a reader welds back together by eye. It covers every separator
in one pass — spaces, tabs, newlines, `,` `.` `;` `|`, brackets, quotes, an em
dash, a zero-width character — **and** the brackets of the printed
`[code]`/`[path]`/`[value]` markers, so a marker cannot stand in for the separator a
split used. Earlier rounds tried a list of readings and a fence-parity count; both
were defeated by a shape nobody had enumerated (round 12: a comma-split body into
6-character chunks). Do not add a second reading: add a case to the corpus and,
if the guard misses it, change the guard — one predicate is shared by
`projectFindingText` (rejects on a non-empty result) and by the tests, so they
cannot disagree about what "safe" means.

The guard's numbers, all in `src/finding-publication.ts`:

| Constant | Value | Why |
| --- | --- | --- |
| `REASSEMBLY_MIN_RUN` | 16 | a shorter run cannot be a token body |
| `INTERLEAVED_DIGIT_PATTERN` | `/[0-9][A-Za-z]+[0-9]/u` | a token body interleaves digits and letters; `lines 1-9 are stale` does not |
| `caseFlipCount` threshold | `>= ceil(length / 3)` | base64 flips case constantly; prose does not — and Title-Case prose crosses it, which is the documented cost |
| `OPAQUE_RUN_PATTERN` | `[A-Za-z0-9+/=_-]{16,}` | the shape of every token body, hex digest and base64 blob |

The projection's order matters and is documented in `projectFindingText`'s
docstring (normalise/fold → HTML comment delimiters → complete fenced blocks →
every leftover backtick/tilde run → inline spans and orphan backticks → paths →
assignment values → opaque runs → one line → non-ASCII → canonical check → cap).
Two invariants keep it safe to extend: *idempotence* (a second projection must be
a no-op — that is why `[value]` is not re-matched as a value) and
*single-sourcing* (`findProjectionViolations` reports the same strings the renderer
rejects on).

### Which test pins what

| Suite | Pins |
| --- | --- |
| `src/__tests__/finding-sensitivity.test.ts` | the four rule families, the three readings, anchors and the placeholder exemption, the refuse rule and its exemptions, `parsePublicationAnswer` spellings, `redactFindingToOneLiner`, split invariance (`— split invariance (property)`) |
| `src/__tests__/finding-publication.test.ts` | the blocked/publish/redact/withhold outcomes, the live-classifier-OR-stored union, re-publish and round reset, the renderer invariant, the documented residual rows, the reassembly guard (`a whitespace-chunked body cannot be reassembled from the section`) |
| `src/__tests__/review-findings.test.ts` | record shape, `carryForwardSensitivity` (including the ambiguous-key widening), `recordPublicationAnswer` and its three refusal causes, `releasedPublicationIn`, gate reason/title wording |
| `src/__tests__/extension-review-gate.test.ts` | `deliverReviewFindings` end-to-end: gate + comment + record, both answer channels, the keyed recording, unrelated answers ignored, round reset, refusal wording |

Run one at a time with `pnpm test -t "<it name>"`; the full suite is 154 files
(4365 tests on this tree).
