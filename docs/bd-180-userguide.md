# GitHub-primary repos: authority, projection map, drift and readiness (bd-180)

A repo can now declare that **GitHub Issues owns its work graph**. The switch
lives beside the existing publish contract in `<repo-root>/.belayd/config.json`:

```json
{ "authority": "bd" }
```

```json
{ "authority": "github", "github": { "owner": "acme", "repo": "widgets" } }
```

`{"authority":"bd"}` is the default and is byte-for-byte today's behaviour: no
GitHub read, no projection, no gh gate path. Choosing `github` turns a phase
sub-agent's `bd` tool into **append-only** — it may read and append
(comments/notes/new beads) and is refused for status, assignee, priority,
dependency, label-closure and close/reopen writes. The human-facing orchestrator
is deliberately exempt: it is the actor that applies GitHub's decisions locally.

| Piece | Where |
| --- | --- |
| Authority reader, refusal rules, drift classification | `src/github-authority.ts` |
| Bead ↔ issue map (parse/serialize/upsert + never-throw fs seams) | `src/github-issue-map.ts` |
| Readiness and stale-gate expiry | `src/github-ready.ts` |
| Append-only verdict for one `bd` argv | `src/github-append-policy.ts` |
| Shared flag spellings (used by validation *and* the policy) | `src/bd-command.ts` |
| Where the policy is applied to a real `bd` call | `extensions/capabilities/bd.ts` |
| Authority resolution from the session repo root | `extensions/index.ts` |
| Design record (experiment, rules, rationale) | [`docs/github-primary.md`](github-primary.md) |

> **Scope.** What is *wired into a running session* is the authority contract and
> its application to the `bd` tool. The map, drift and readiness functions are the
> projection core: pure, exported from `src/index.ts`, fully tested, and not yet
> called by any command or tool. **No command pushes beads to GitHub or pulls
> issues.** bd's own `bd github sync` does the transport, and the experiment in
> §8 is why the projection has to carry dependency edges itself.

## How to Verify

Every command runs from the repository root of this checkout, after `pnpm build`
(so `dist/src/index.js` exists). The config and map walkthroughs use throwaway
directories under `/tmp`; nothing here needs network access, a GitHub token, or a
beads database.

### 1. Gates

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test
pnpm test:integration
```

Real output (the tool lines; pnpm's own banner lines are omitted):

```text
$ tsc --noEmit
$ biome check .
Checked 302 files in 574ms. No fixes applied.
$ tsc

 Test Files  134 passed (134)
      Tests  3539 passed (3539)

 Test Files  14 passed (14)
      Tests  108 passed (108)
```

The five suites that pin this bead (125 tests together):

```bash
node_modules/.bin/vitest run \
  src/__tests__/github-authority.test.ts src/__tests__/github-issue-map.test.ts \
  src/__tests__/github-ready.test.ts src/__tests__/github-append-policy.test.ts \
  src/__tests__/extension-bd-tool.test.ts
```

```text
 ✓ src/__tests__/extension-bd-tool.test.ts (21 tests) 6000ms
 Test Files  5 passed (5)
      Tests  125 passed (125)
```

### 2. The authority config: default, opt-in, and every refusal

```bash
D=/tmp/bd180-config
rm -rf "$D" && mkdir -p "$D/.belayd" && cd "$D" && git init -q -b main
probe() {
  node --input-type=module -e '
  const m = await import("/home/hugo/git/feat-bd-180/dist/src/index.js");
  const fs = await import("node:fs");
  const root = process.argv[1];
  fs.writeFileSync(`${root}/.belayd/config.json`, process.argv[2]);
  console.log(process.argv[3], JSON.stringify(m.readGithubAuthorityConfig({ repoRoot: root })));
  ' "$D" "$1" "$2"
}
probe '{}' "empty object:"
probe '{"authority":"github","github":{"owner":"acme","repo":"widgets"}}' "github:"
probe '{"authority":"github"}' "github, no ref:"
probe '{"authority":"github","github":{"owner":"acme"}}' "github, no repo:"
probe '{"authority":"bd","github":{"owner":"acme","repo":"widgets"}}' "both markers:"
probe '{"github":{"owner":"acme","repo":"widgets"}}' "block without authority:"
probe '{"authority":["bd","github"]}' "authority collection:"
probe '{"authority":"gitlab"}' "unknown authority:"
probe '{"authority":"github","github":{"owner":"--upload-pack=evil","repo":"widgets"}}' "flag-shaped owner:"
probe '{"authority":"github","github":{"owner":"acme","repo":"widgets","extra":"x"}}' "extra key:"
probe '{ not json' "invalid JSON:"
```

Real output:

```text
empty object: {"ok":true,"value":{"authority":"bd"},"warnings":[]}
github: {"ok":true,"value":{"authority":"github","github":{"owner":"acme","repo":"widgets"}},"warnings":[]}
github, no ref: {"ok":false,"error":"authority \"github\" requires github.owner and github.repo ((root): Invalid input: expected object, received undefined)"}
github, no repo: {"ok":false,"error":"authority \"github\" requires github.owner and github.repo (repo: Invalid input: expected string, received undefined)"}
both markers: {"ok":false,"error":"ambiguous authority: \"authority\" is \"bd\" but a \"github\" block is configured (both authorities set)"}
block without authority: {"ok":false,"error":"ambiguous authority: a \"github\" block is configured but \"authority\" is not set (both authorities set)"}
authority collection: {"ok":false,"error":"ambiguous authority: \"authority\" must be a single \"bd\" or \"github\", not a collection"}
unknown authority: {"ok":false,"error":"unknown authority \"gitlab\"; expected \"bd\" or \"github\""}
flag-shaped owner: {"ok":false,"error":"authority \"github\" requires github.owner and github.repo (owner: must not start with '-')"}
extra key: {"ok":false,"error":"authority \"github\" requires github.owner and github.repo ((root): Unrecognized key: \"extra\")"}
invalid JSON: {"ok":true,"value":{"authority":"bd"},"warnings":["/tmp/bd180-config/.belayd/config.json: invalid JSON (Expected property name or '}' in JSON at position 2 (line 1 column 3))"]}
```

Read it as three tiers, which is the whole contract:

1. **No usable file** (absent, unreadable, invalid JSON, non-object root) →
   `bd` plus a warning. A broken file never selects GitHub.
2. **A file that parses but is ambiguous** → refused, never narrowed. That is
   every `github`-without-owner/repo case, both markers at once, a collection,
   and an unknown authority string. `github` is strict about extra keys and about
   values that start with `-` or contain control characters, because these
   strings later become API paths and argv.
3. **A valid `github` block** → resolved, and `publish` in the same file keeps
   working (both readers share `readRepoConfigObject`; a `github` key produces no
   publish warning).

### 3. The repo root, not the caller's cwd

`.belayd/config.json` is repo-scoped, so it is read from the parent of git's
shared common dir. A `bd` call from a subdirectory or a linked worktree must see
the same authority, and a directory where git cannot resolve a root must refuse
rather than fall back to local mode.

```bash
D=/tmp/bd180-config
mkdir -p "$D/src/nested"
printf '%s' '{"authority":"github","github":{"owner":"acme","repo":"widgets"}}' > "$D/.belayd/config.json"
node --input-type=module -e '
const m = await import("/home/hugo/git/feat-bd-180/dist/src/index.js");
const j = (v) => JSON.stringify(v);
const root = "/tmp/bd180-config";
const r = m.resolveGitCommonDir;
console.log("repo root:     ", j(m.resolveGithubAuthorityForSession({ cwd: root, resolveGitCommonDir: r })));
console.log("nested cwd:    ", j(m.resolveGithubAuthorityForSession({ cwd: `${root}/src/nested`, resolveGitCommonDir: r })));
console.log("outside a repo:", j(m.resolveGithubAuthorityForSession({ cwd: "/tmp", resolveGitCommonDir: r })));
'
```

Real output:

```text
repo root:      {"ok":true,"authority":"github","repoRoot":"/tmp/bd180-config","warnings":[]}
nested cwd:     {"ok":true,"authority":"github","repoRoot":"/tmp/bd180-config","warnings":[]}
outside a repo: {"ok":false,"error":"authority unresolved: git rev-parse --git-common-dir failed in /tmp: Command failed: git rev-parse --path-format=absolute --git-common-dir\nfatal: not a git repository (or any of the parent directories): .git\n"}
```

The nested cwd resolves the same `repoRoot`, and the third line is the fail-closed
case: a phase session with no resolvable root gets its write refused with
`bd write refused: authority unresolved: …` instead of silently becoming local.

### 4. Append-only refusals for a phase session

The policy is a pure function over argv. This is the verdict table the `bd` tool
applies, with `authority: "github"`:

```bash
node --input-type=module -e '
const m = await import("/home/hugo/git/feat-bd-180/dist/src/index.js");
const cases = [
  "show bd-1 --json", "comment bd-1 shipped", "dep list bd-1", "label add bd-1 human",
  "update bd-1 -s closed", "update bd-1 -s=closed", "update bd-1 -sclosed",
  "update bd-1 --status=closed", "update bd-1 -a alice", "update bd-1 -p 1",
  "update bd-1 --remove-label human", "update bd-1 --set-labels x",
  "dep add bd-2 --blocked-by bd-1", "label remove bd-1 human",
  "label rm bd-1 human", "label rename a b", "label propagate a",
  "close bd-1", "reopen bd-1",
];
for (const command of cases) {
  const verdict = m.classifyBdWriteForAuthority({ argv: command.split(" "), authority: "github" });
  const tail = verdict.verdict === "refused" ? `refused [${verdict.reason}] ${verdict.message}` : `allowed (${verdict.mode})`;
  console.log(command.padEnd(34, "."), tail);
}
'
```

Real output:

```text
show bd-1 --json.................. allowed (read)
comment bd-1 shipped.............. allowed (append)
dep list bd-1..................... allowed (read)
label add bd-1 human.............. allowed (append)
update bd-1 -s closed............. refused [status] GitHub owns status; a phase agent must not change it
update bd-1 -s=closed............. refused [status] GitHub owns status; a phase agent must not change it
update bd-1 -sclosed.............. refused [status] GitHub owns status; a phase agent must not change it
update bd-1 --status=closed....... refused [status] GitHub owns status; a phase agent must not change it
update bd-1 -a alice.............. refused [assignee] GitHub owns assignment; a phase agent must not change it
update bd-1 -p 1.................. refused [priority] GitHub owns priority; a phase agent must not change it
update bd-1 --remove-label human.. refused [label] removing a label rewrites shared state; append instead
update bd-1 --set-labels x........ refused [label] replacing the label set rewrites shared state; append instead
dep add bd-2 --blocked-by bd-1.... refused [dependency] GitHub owns blocked-by edges; a phase agent must not change them
label remove bd-1 human........... refused [label] bd label remove rewrites shared label state; append instead
label rm bd-1 human............... refused [label] bd label rm rewrites shared label state; append instead
label rename a b.................. refused [label] bd label rename rewrites shared label state; append instead
label propagate a................. refused [label] bd label propagate rewrites shared label state; append instead
close bd-1........................ refused [close] GitHub owns closure; merge closes the bead, a phase agent must not
reopen bd-1....................... refused [reopen] GitHub owns lifecycle; a phase agent must not reopen work
```

Short (`-s closed`), equals (`-s=closed`), attached (`-sclosed`) and long
(`--status=closed`) spellings are one flag, defined once in `src/bd-command.ts`
and shared with the tool's option validation. Under `authority: "bd"` the same
function returns `allowed` for every row above.

The end-to-end wiring (tool → policy → no spawn) is covered by
[`src/__tests__/extension-bd-tool.test.ts`](../src/__tests__/extension-bd-tool.test.ts):

```bash
node_modules/.bin/vitest run src/__tests__/extension-bd-tool.test.ts -t "github-primary"
```

```text
 ✓ src/__tests__/extension-bd-tool.test.ts (21 tests | 19 skipped) 1229ms
   ✓ bd tool proxy > keeps reads and appended comments open in a github-primary phase session  1220ms

 Test Files  1 passed (1)
      Tests  2 passed | 19 skipped (21)
```

That file is the honest proof of the boundary, because it drives the real tool
against a real `git init` temp repo with `node:child_process.execFile` mocked:

- `applies the GitHub-primary policy to a phase session, not the orchestrator` —
  a phase session's `update bd-150 -s closed` returns exit 1 with `GitHub owns
  status`, **zero** child processes; the same repo's orchestrator call keeps bd's
  own local-mode refusal (`bd subcommand "close" is not allowed`).
- `names GitHub as the closure owner for a phase session` — `close bd-150` from a
  phase session says `GitHub owns closure` (the authority reason overrides the
  generic allowlist rejection) and still spawns nothing.
- `keeps reads and appended comments open in a github-primary phase session` —
  `show bd-150 --json` and `comment bd-150 shipped` both exit 0 and spawn `bd`
  only.
- `exempts the orchestrator from the policy in a github-primary repo` — `dep add`
  from the orchestrator runs.
- `resolves the authority from the repo root, not a subdirectory cwd` — a phase
  `close` from `src/nested` is still refused.
- `refuses a phase write when the authority config is ambiguous` — `bd write
  refused: … ambiguous authority …`, nothing spawned.
- `refuses a phase write when the session repo root cannot be resolved` —
  `authority unresolved`, nothing spawned.
- `keeps a bd-authority phase session's writes and never forks gh` — `dep add`
  runs and the only binary ever spawned is `bd`.
- `warns once per session for the same broken authority config` — two phase `bd`
  calls both run, and the config warning is logged exactly once.

Who counts as a phase session: the session name contains the `-sub-` marker
(`isSubAgentSession` in `extensions/capabilities/human-gate.ts`), e.g.
`belayd-bd-150-sub-review-abc123`. The orchestrator session name has no marker.

### 5. The bead ↔ issue map

```bash
rm -rf /tmp/bd180-map && mkdir -p /tmp/bd180-map/.belayd
node --input-type=module -e '
const m = await import("/home/hugo/git/feat-bd-180/dist/src/index.js");
const fs = await import("node:fs");
const j = (v) => JSON.stringify(v);
const root = "/tmp/bd180-map";
const repo = { owner: "acme", name: "widgets" };
const path = m.githubIssueMapPath(root);

console.log("absent:       ", j(m.readGithubIssueMap({ repoRoot: root, repo })));

let map = m.upsertGithubIssue(m.emptyGithubIssueMap(repo), "bd-180", { number: 42, nodeId: "I_kwDOx" });
map = m.recordUnmappedDependency(map, { beadId: "bd-182", dependsOnBeadId: "bd-181", reason: "blocker has no issue" });
console.log("write:        ", j(m.writeGithubIssueMap({ repoRoot: root, map })));
console.log("read back:    ", j(m.readGithubIssueMap({ repoRoot: root, repo })));

fs.writeFileSync(path, "{ not json");
console.log("corrupt read: ", j(m.readGithubIssueMap({ repoRoot: root, repo })));
console.log("corrupt write:", j(m.writeGithubIssueMap({ repoRoot: root, map })));

fs.writeFileSync(path, j({ version: 2, repo, issues: {}, unmappedDependencies: [] }));
console.log("v2 read:      ", j(m.readGithubIssueMap({ repoRoot: root, repo })));
console.log("v2 write:     ", j(m.writeGithubIssueMap({ repoRoot: root, map })));
fs.rmSync(path);
'
```

Real output:

```text
absent:        {"ok":true,"map":{"version":1,"repo":{"owner":"acme","name":"widgets"},"issues":{},"unmappedDependencies":[]},"warnings":[]}
write:         {"ok":true,"path":"/tmp/bd180-map/.belayd/github-map.json"}
read back:     {"ok":true,"map":{"version":1,"repo":{"owner":"acme","name":"widgets"},"issues":{"bd-180":{"number":42,"nodeId":"I_kwDOx"}},"unmappedDependencies":[{"beadId":"bd-182","dependsOnBeadId":"bd-181","reason":"blocker has no issue"}]},"warnings":[]}
corrupt read:  {"ok":true,"map":{"version":1,"repo":{"owner":"acme","name":"widgets"},"issues":{},"unmappedDependencies":[]},"warnings":["/tmp/bd180-map/.belayd/github-map.json: invalid JSON (Expected property name or '}' in JSON at position 2 (line 1 column 3)); using an empty map"]}
corrupt write: {"ok":false,"error":"/tmp/bd180-map/.belayd/github-map.json: existing map is not parsable; refusing to overwrite it"}
v2 read:       {"ok":false,"error":"/tmp/bd180-map/.belayd/github-map.json: unsupported GitHub issue map version \"2\" (this harness writes 1); refusing to read or downgrade it"}
v2 write:      {"ok":false,"error":"/tmp/bd180-map/.belayd/github-map.json: existing map is not parsable; refusing to overwrite it"}
```

Two behaviours are the point of the last four lines:

- **A corrupt map degrades, it does not crash.** The read returns an empty map
  plus a warning so a projection can still run. The write then *refuses to
  overwrite* the bytes it cannot parse, so the recovery path cannot destroy what
  an operator might still salvage.
- **A version this harness did not write is refused on read** (typed error, no
  throw, no silent downgrade) and the write refuses it too, for the same reason.

The file is deterministic on disk — issue keys sorted, two-space indent, trailing
newline — so a rewrite with no logical change is a no-op in git.

### 6. Drift

```bash
node --input-type=module -e '
const m = await import("/home/hugo/git/feat-bd-180/dist/src/index.js");
const repo = { owner: "acme", name: "widgets" };
let map = m.emptyGithubIssueMap(repo);
map = m.upsertGithubIssue(map, "bd-180", { number: 42, nodeId: "I_a" });
map = m.upsertGithubIssue(map, "bd-181", { number: 43, nodeId: "I_b" });
map = m.upsertGithubIssue(map, "bd-190", { number: 50, nodeId: "I_c" });
map = m.recordUnmappedDependency(map, { beadId: "bd-182", dependsOnBeadId: "bd-183", reason: "blocker has no issue" });
map = m.recordUnmappedDependency(map, { beadId: "bd-182", dependsOnBeadId: "bd-184", reason: "blocker has no issue" });
const drifts = m.classifyGithubDrift({
  authority: { authority: "github", github: { owner: "acme", repo: "widgets" } },
  map,
  beads: [{ id: "bd-180", state: "open" }, { id: "bd-181", state: "open" }, { id: "bd-182", state: "open" }],
  issues: [{ beadId: "bd-180", state: "closed" }, { beadId: "bd-181", state: "missing" }],
  openGates: [{ beadId: "bd-180", gateId: "g1" }],
});
for (const drift of drifts) console.log(m.githubDriftWarning(drift));
console.log("status:", m.githubDriftStatus(drifts));
'
```

Real output:

```text
github drift [issue-closed-bead-open] bd-180: issue #42 is closed but the bead is still open (1 open local gate(s) hold it)
github drift [issue-missing] bd-181: mapped issue #43 no longer resolves on GitHub
github drift [issue-missing] bd-182: bead has no GitHub issue in the projection map
github drift [bead-missing] bd-190: projection map names issue #50 for a bead that no longer exists
github drift [unmapped-dependency] bd-182->bd-183: bd-182 depends on bd-183, which has no GitHub issue (blocker has no issue)
github drift [unmapped-dependency] bd-182->bd-184: bd-182 depends on bd-184, which has no GitHub issue (blocker has no issue)
status: drift
```

Note the two `unmapped-dependency` ids: the finding is keyed by the **edge**
(`blocked->blocker`), so two blockers out of one bead are two findings instead of
one deduped bead id. Ordering is deterministic: bead list (in input order), then
orphaned map entries, then unmapped dependencies.

The aggregate cases:

```bash
node --input-type=module -e '
const m = await import("/home/hugo/git/feat-bd-180/dist/src/index.js");
const j = (v) => JSON.stringify(v);
const repo = { owner: "acme", name: "widgets" };
const authority = { authority: "github", github: { owner: "acme", repo: "widgets" } };
const inSync = m.upsertGithubIssue(m.emptyGithubIssueMap(repo), "bd-180", { number: 42, nodeId: "I_a" });
console.log("in sync:", m.githubDriftStatus(m.classifyGithubDrift({
  authority, map: inSync,
  beads: [{ id: "bd-180", state: "open" }],
  issues: [{ beadId: "bd-180", state: "open" }],
})));
console.log("local repo:", j(m.classifyGithubDrift({ authority: { authority: "bd" }, map: inSync, beads: [], issues: [] })));
console.log("map unreadable:", j(m.classifyGithubDrift({
  authority, map: m.emptyGithubIssueMap(repo),
  beads: [{ id: "bd-180", state: "open" }], issues: [],
  mapUnreadableReason: "/tmp/bd180-map/.belayd/github-map.json: invalid JSON (...); using an empty map",
})));
'
```

Real output:

```text
in sync: in-sync
local repo: [{"id":"(repo)","kind":"authority-mismatch","message":"this repo declares authority \"bd\", so a GitHub projection must not be applied"}]
map unreadable: [{"id":"(map)","kind":"map-unreadable","message":"/tmp/bd180-map/.belayd/github-map.json: invalid JSON (...); using an empty map"}]
```

`map-unreadable` replaces all map-derived findings on purpose: with an empty map
every bead would otherwise be reported `issue-missing`, which would present a
filesystem problem as a sync failure.

### 7. Ready, and stale-gate expiry

```bash
node --input-type=module -e '
const m = await import("/home/hugo/git/feat-bd-180/dist/src/index.js");
const j = (v) => JSON.stringify(v);
const authority = "github";
const gates = m.parseGithubGates([
  { id: "g1", status: "open", await_type: "gh:pr", await_id: "42", created_at: "2026-01-01T00:00:00Z" },
  { id: "g2", status: "open", await_type: "gh:run", await_id: "ci", created_at: "2026-01-01T00:00:00Z" },
  { id: "g3", status: "open", await_type: "gh:pr", await_id: "0x10" },
], "bd-180");
const evidence = {
  prs: [{ number: 42, state: "closed", merged: true }],
  runs: [{ name: "ci", status: "completed", conclusion: "success", createdAt: "2026-01-01T00:00:01Z" }],
};
for (const gate of gates) console.log("gate", gate.gateId, "->", j(gate));
for (const entry of m.classifyGates(gates, evidence)) {
  console.log("verdict", entry.gate.gateId, "->", entry.verdict);
}
console.log("ready, no edges:", j(m.computeReady({ authority, beadId: "bd-180", blockedBy: [], gates, evidence })));
console.log("ready, one open edge:", j(m.computeReady({ authority, beadId: "bd-180", blockedBy: [{ dependsOnBeadId: "bd-181", state: "open" }], gates, evidence })));
console.log("stale run, only evidence older:", j(m.computeReady({
  authority, beadId: "bd-180", blockedBy: [],
  gates: m.parseGithubGates([{ id: "g4", status: "open", await_type: "gh:run", await_id: "ci", created_at: "2026-02-01T00:00:00Z" }], "bd-180"),
  evidence,
})));
console.log("gate without created_at:", j(m.computeReady({
  authority, beadId: "bd-180", blockedBy: [],
  gates: m.parseGithubGates([{ id: "g5", status: "open", await_type: "gh:run", await_id: "ci" }], "bd-180"),
  evidence,
})));
console.log("local mode:", j(m.computeReady({ authority: "bd", beadId: "bd-180", blockedBy: [], gates, evidence })));
'
```

Real output:

```text
gate g1 -> {"kind":"gh-pr","gateId":"g1","beadId":"bd-180","number":42,"createdAt":"2026-01-01T00:00:00Z"}
gate g2 -> {"kind":"gh-run","gateId":"g2","beadId":"bd-180","run":"ci","createdAt":"2026-01-01T00:00:00Z"}
gate g3 -> {"kind":"unknown","gateId":"g3","beadId":"bd-180","reason":"gh:pr gate has a malformed await_id \"0x10\""}
verdict g1 -> satisfied-externally
verdict g2 -> satisfied-externally
verdict g3 -> unknown
ready, no edges: {"ready":false,"reason":"waiting-on-gate","gate":{"kind":"unknown","gateId":"g3","beadId":"bd-180","reason":"gh:pr gate has a malformed await_id \"0x10\""},"verdict":"unknown","clearedGates":[{"kind":"gh-pr","gateId":"g1","beadId":"bd-180","number":42,"createdAt":"2026-01-01T00:00:00Z"},{"kind":"gh-run","gateId":"g2","beadId":"bd-180","run":"ci","createdAt":"2026-01-01T00:00:00Z"}]}
ready, one open edge: {"ready":false,"reason":"blocked-by","blockers":["bd-181"],"clearedGates":[{"kind":"gh-pr","gateId":"g1","beadId":"bd-180","number":42,"createdAt":"2026-01-01T00:00:00Z"},{"kind":"gh-run","gateId":"g2","beadId":"bd-180","run":"ci","createdAt":"2026-01-01T00:00:00Z"}]}
stale run, only evidence older: {"ready":false,"reason":"waiting-on-gate","gate":{"kind":"gh-run","gateId":"g4","beadId":"bd-180","run":"ci","createdAt":"2026-02-01T00:00:00Z"},"verdict":"unknown","clearedGates":[]}
gate without created_at: {"ready":false,"reason":"waiting-on-gate","gate":{"kind":"gh-run","gateId":"g5","beadId":"bd-180","run":"ci"},"verdict":"unknown","clearedGates":[]}
local mode: {"ready":true,"reason":"unblocked","clearedGates":[]}
```

What to read off that:

- `g1` and `g2` are **cleared** (`satisfied-externally`) and appear in
  `clearedGates` — this is the stale-local-gate failure the bead names: GitHub
  already proved the condition, so the projection must not block forever.
- `g3` (`await_id: "0x10"`) degrades to an `unknown` gate naming the bad id and
  **keeps the wait**. Only the strict decimal grammar parses: `^\d+$`, positive
  safe integer. `1e3`, `" 42 "`, `+7`, `4_2`, `0`, `-1`, `42.0`, `""` are all
  malformed. Numeric run ids use the same validator.
- The stale-run case keeps the wait even though a `success` run named `ci`
  exists, because the only evidence predates the gate's `created_at`. A gate or
  run with a missing/unparseable timestamp also keeps the wait (fail closed).
  When several runs match, the newest one wins.
- Local mode never classifies a gate and never reads GitHub evidence: it returns
  the plain blocked-by answer.

### 8. Reproducing the bd 1.3.0 experiment

This is the bead's first acceptance criterion, and the evidence the projection's
design rests on. A real GitHub token is not needed: the driver points bd at a
local GitHub REST stand-in via `GITHUB_API_URL` and reads the exact HTTP requests
bd makes, which is stricter than a dry-run summary.

```bash
bash docs/proof/bd-180-experiment/scripts/bd180-experiment.sh \
  > /tmp/bd180-experiment.log 2>&1; echo "exit=$?"
grep -n -e "github.token is not configured" \
        -e "Would create in GitHub" \
        -e "Pushed 1 issues" \
        -e '^  BODY:' /tmp/bd180-experiment.log
```

The committed transcript is
[`docs/proof/bd-180-experiment/experiment.log`](proof/bd-180-experiment/experiment.log).
It re-creates `/tmp/bd180-experiment` on every run, makes no network calls, and
expects a local `bd` on `PATH` (1.3.0 when the log was captured).

What a reader should see:

1. bd's identity and surface (`bd version`, `bd --help`, `bd github --help`,
   `bd github sync --help`), then a two-bead repo with `bd dep add`.
2. A bare dry-run with no GitHub configuration **fails**, and that failure is the
   reason the rest of the script uses the stand-in:

   ```text
   $ bd github sync --dry-run
   Error: github.token is not configured. Set via 'bd config set github.token <token>' or GITHUB_TOKEN environment variable
   [exit=1]
   ```

3. Against the stand-in, the dry-run only prints the plan — and the request log
   for that pass contains a single `GET …/issues`, no mutations:

   ```text
   Dry run mode - no changes will be made

     [dry-run] Would create in GitHub: Bead B
     [dry-run] Would create in GitHub: Bead A

   Run without --dry-run to apply changes
   [exit=0]
   ```

4. A real push creates two issues, and **every create body is an issue only** —
   no blocked-by edge anywhere, and no dependency endpoint is called:

   ```text
   BODY: {"body":"","labels":["type::task","priority::medium"],"title":"Bead B"}
   BODY: {"body":"","labels":["type::task","priority::medium"],"title":"Bead A"}
   ```

5. Pushing the blocked bead alone succeeds with no warning and never names the
   blocker: `✓ Pushed 1 issues`, and the request log holds one create body.
   Meanwhile `bd dep list <bead> --json` still shows the edge locally.

The transcript's closing answer is the design consequence: bd 1.3.0 carries no
dependency edges, so the projection must carry them itself and record every edge
whose blocker has no issue in `unmappedDependencies` (see §5 and §6).

### 9. Cleanup

```bash
rm -rf /tmp/bd180-config /tmp/bd180-map /tmp/bd180-experiment /tmp/bd180-experiment.log
```

## How to Use

### Turn it on for a repository

Put the key beside `publish` in `<repo-root>/.belayd/config.json`:

```json
{
  "publish": { "mode": "pr", "remote": "origin", "base": "main" },
  "authority": "github",
  "github": { "owner": "acme", "repo": "widgets" }
}
```

`owner` and `repo` are the GitHub identity the projection maps onto. Both are
required, 1–128 characters, and must not start with `-` or contain control
characters. The file is repo-scoped: it is read from the main checkout (the
parent of the shared git common dir), so every linked worktree sees the same
authority and a worktree-local copy is ignored.

**Do nothing** to keep local mode. An absent key, an absent file, or an
unparsable file all mean `authority: "bd"`. In this repository `.belayd/` is
gitignored, so the file is per-checkout — set it again in a fresh clone.

`authority: "github"` does **not** start publishing anything by itself: `publish`
is a separate key with a separate reader, and a `github` key produces no publish
warning.

### What a phase agent may and may not write

| Category | Refused for a phase session when authority is `github` | Allowed |
| --- | --- | --- |
| status | `update -s/--status <any spelling>`, `--defer`, `set-state`, `defer`, `undefer` | `update` with no graph flag |
| assignee | `assign`, `update -a/--assignee`, `update --owner` | — |
| priority | `priority`, `update -p/--priority` | — |
| dependency | `dep add/remove/relate`, `link`, `update --parent`, `update --type=parent-child` | `dep list/tree/cycles` |
| closure / lifecycle | `close`, `reopen` | — |
| labels | every `bd label` write (`remove`, `rm`, `delete`, `rename`, `propagate`, …), `update --remove-label`, `update --set-labels` | `label list`, `label list-all`, `label add`, `tag` |
| append | — | `comment`, `note`, `create`, `remember`, `heartbeat`; every read (`show`, `list`, `ready`, `search`, `gate list/show`, …) |
| anything unclassified | refused with reason `unclassified-write` | — |

`create --parent` is refused in a phase session too, but by bd's own hierarchy
rule in `validateBdCommand` (`Creating child beads (--parent) is not allowed.`),
before the authority policy sees it. That ordering is pinned by the test
`keeps bd's own hierarchy refusal for create --parent in a phase session`.

The refusal the phase agent sees is prefixed `bd write refused: ` and names the
owner, e.g.:

```text
bd write refused: GitHub owns status; a phase agent must not change it
bd write refused: GitHub owns closure; merge closes the bead, a phase agent must not
bd write refused: ambiguous authority: "authority" is "bd" but a "github" block is configured (both authorities set)
bd write refused: authority unresolved: git rev-parse --git-common-dir failed in /tmp: …
```

The orchestrator and any human session are not subject to the policy: they keep
bd's normal validation. So the orchestrator can still apply a GitHub decision
locally, and `bd close` from an orchestrator session is refused by bd's own
allowlist (as before), not by the authority policy.

Config warnings are emitted **once per session**, keyed by the warning text. Both
`bd` calls still re-read the config and reach the same verdict; only the log line
is deduped, so a typo in `config.json` does not spam every phase call. The prefix
is `[belayd-harness] `.

### The map file

`<repo-root>/.belayd/github-map.json` is written by the projection, not by hand:

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
number while GraphQL relationships use node ids. Two writers exist in the module
and both are safe to call with hand-edited data: an upsert never mutates its
input, and a write refuses to replace a file it cannot parse.

### Calling drift and readiness from code

Both are pure over injected facts — no network, no clock, no fs inside the
classification. Serialize `bd gate list <bead> --json` into `parseGithubGates`,
and feed issue/PR/run observations you already have:

```typescript
import {
  classifyGithubDrift,
  classifyGates,
  computeReady,
  githubDriftWarning,
  parseGithubGates,
  readGithubAuthorityConfig,
  readGithubIssueMap,
  type GithubBlockedByEdge,
  type GithubDriftBead,
  type GithubGateEvidence,
  type GithubIssueObservation,
} from "../src/index.js";

function reportDrift(input: {
  repoRoot: string;
  gateListJson: unknown; // `bd gate list <bead> --json`
  blockedBy: readonly GithubBlockedByEdge[]; // local edges, resolved through the map
  evidence: GithubGateEvidence; // PRs/runs you already read from GitHub
  beads: readonly GithubDriftBead[];
  issues: readonly GithubIssueObservation[];
}): void {
  const authority = readGithubAuthorityConfig({ repoRoot: input.repoRoot });
  if (!authority.ok) return; // ambiguous config: surface authority.error, never pick a side

  const read = readGithubIssueMap({
    repoRoot: input.repoRoot,
    repo: { owner: "acme", name: "widgets" },
  });
  if (!read.ok) return; // unsupported map version: surface read.error, never downgrade
  const mapUnreadableReason = read.warnings[0]; // a corrupt file degrades to an empty map

  const gates = parseGithubGates(input.gateListJson, "bd-180");

  for (const entry of classifyGates(gates, input.evidence)) {
    // entry.verdict: "open" | "satisfied-externally" | "expired" | "unknown"
  }

  const ready = computeReady({
    authority: "github",
    beadId: "bd-180",
    blockedBy: input.blockedBy,
    gates,
    evidence: input.evidence,
  });
  // ready.reason: "unblocked" | "blocked-by" | "waiting-on-gate"
  // ready.clearedGates holds gates GitHub proved done (or that can never be met)

  const drifts = classifyGithubDrift({
    authority: authority.value,
    map: read.map,
    beads: input.beads,
    issues: input.issues,
    mapUnreadableReason,
  });
  for (const drift of drifts) console.warn(githubDriftWarning(drift));
}
```

`computeReady` with `authority: "bd"` ignores gates and evidence entirely and
returns the local blocked-by answer, so a caller can use one function for both
modes.

### Failure modes

| Situation | What happens | What you see / do |
| --- | --- | --- |
| No `.belayd/config.json`, or no `authority` key | Local mode, no warning | `{"ok":true,"value":{"authority":"bd"},"warnings":[]}` |
| `{"publish":"pr"}` only | Authority stays `bd`; publish still resolves to `pr` | no authority warning |
| Config file is invalid JSON | One warning, local mode — never GitHub | `<path>/config.json: invalid JSON (… )` |
| Config root is not a JSON object | One warning, local mode | `<path>/config.json: expected a JSON object` |
| `authority:"github"` without `owner`/`repo` | Refused, never narrowed to `bd` | `authority "github" requires github.owner and github.repo (repo: Invalid input: expected string, received undefined)` |
| `authority:"github"` with an extra key in the `github` block | Refused (strict object) | `authority "github" requires github.owner and github.repo ((root): Unrecognized key: "extra")` |
| A `github` block with no `authority`, or `authority:"bd"` plus a `github` block | Refused as ambiguous — there is no safe precedence | `ambiguous authority: … (both authorities set)` |
| `authority` is an array/object, or an unknown string | Refused | `ambiguous authority: "authority" must be a single "bd" or "github", not a collection` / `unknown authority "gitlab"; expected "bd" or "github"` |
| `owner`/`repo` starts with `-` or contains a control character | Refused (these become API paths/argv) | `… (owner: must not start with '-')` / `… (repo: must not contain control characters)` |
| A phase write where git's common dir cannot be resolved | Refused, does not fall back to local mode | `bd write refused: authority unresolved: …` |
| A phase write in an ambiguous repo | Refused | `bd write refused: ambiguous authority: …` |
| `github-map.json` is corrupt/unreadable | Empty map + one warning; drift reports a single `map-unreadable`; the map write refuses to overwrite | `… existing map is not parsable; refusing to overwrite it` |
| `github-map.json` has `version: 2` | Read refused (no throw, no downgrade) and write refused | `unsupported GitHub issue map version "2" (this harness writes 1); refusing to read or downgrade it` |
| `gh:pr`/`gh:run` gate with a loose `await_id` (`0x10`, `1e3`, `" 42 "`, `+7`, `4_2`, `0`, `42.0`) | Gate is carried as `unknown` and keeps the wait | `gh:pr gate has a malformed await_id "0x10"` |
| Run evidence older than the gate's `created_at`, or either timestamp missing/unparseable | Never satisfies the gate; verdict `unknown` | `{"ready":false,"reason":"waiting-on-gate",…,"verdict":"unknown"}` |
| A `human` gate in a GitHub-primary repo | Stays open by definition — GitHub cannot answer a person (that channel is bd-182) | `verdict: open` |
| A phase session writes status/assignee/priority/dep/close/label state | Refused before spawn, with the owner named | `bd write refused: GitHub owns …` |
| The orchestrator writes the same thing | Policy does not apply | bd's own validation decides |

### Limitations worth knowing once

- **The policy is a tripwire, not the boundary.** A gated phase session's active
  tool surface comes from the process gate
  (`workflowGateToolSet` in `src/role-tools.ts`), which contains no `bash`,
  `edit` or `write`, so a phase agent cannot shell out to raw `bd`. The
  append-only policy exists so that a *refused* write returns an actionable
  reason naming GitHub, instead of a generic allowlist error or a silent local
  divergence. Do not rely on the policy alone as a security boundary.
- **`unknown` pauses work; it does not free it.** Missing PR/run evidence, an
  unreadable `blockedBy` edge, a malformed `await_id` and a timestamp we cannot
  parse all keep a bead blocked. Degrade, do not guess.
- **The map is a projection cache, not the source of truth.** GitHub Issues owns
  the work; a missing or corrupt local map loses nothing but the cross-reference,
  and the write refusal exists so you can recover the old bytes by hand.
- **Nothing here pushes or pulls issues.** The transport is bd's own
  `bd github sync`, and it carries no dependency edges (§8), which is exactly why
  `unmappedDependencies` exists.
- **Drift and readiness have no command or tool surface yet.** They are exported
  library functions (`src/index.ts`) with tests; the only session-visible
  behaviour this bead adds is authority resolution and the append-only policy on
  the `bd` tool.
- **In PR mode the merge is the human's acceptance** (close-on-merge is
  bd-174.4/.10/.12). The local-mode rule "never close, the human closes with
  `wt merge`" stays a local-mode rule, and a phase agent's `close` is refused in
  both modes — by bd's allowlist in local mode, by the authority policy in
  GitHub-primary mode.

**Not implemented in bd-180, and who owns each:**

| Concern | Owner |
| --- | --- |
| Close-on-merge and `mergedAt` acceptance | bd-174.4 / bd-174.10 / bd-174.12 |
| Reading a person's answer from issue comments | bd-182 |
| PR body | bd-184 (unbuilt) |
| Token and credential boundary for GitHub access | bd-7 |

Related: [`docs/github-primary.md`](github-primary.md) (design record: the
experiment, every rule and its rationale), [`docs/repo-layout.md`](repo-layout.md)
(module map), [`docs/bd-174.1-userguide.md`](bd-174.1-userguide.md) (the publish
contract in the same config file), [`docs/bd-150-userguide.md`](bd-150-userguide.md)
(beads actor identity that the refused/attributed writes interact with).
