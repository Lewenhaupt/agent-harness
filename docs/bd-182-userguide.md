# Reading a person's answer from GitHub issue comments (bd-182)

bd-152 gave a blocked workflow a way back: `belayd_ask_human` posts the question
as an authored comment, opens a bd `human` gate that blocks the bead, and the
first non-harness comment on the bead is delivered as a real user turn.

bd-152 assumed the answer arrives on the **bead**. In a GitHub-primary repo
(`{"authority":"github"}` in `.belayd/config.json`, see
[`bd-180-userguide.md`](bd-180-userguide.md)) the bead is a local projection and
the person is reading the **issue**. bd-182 moves the question and the answer to
the mapped issue — never the PR — and leaves everything else alone: the bd
`human` gate is still the durable wait, delivery is still a real user turn via
`pi.sendUserMessage`, and the gate still resolves only after a successful send.
`authority: "bd"` is byte-for-byte unchanged.

| Piece | Where |
| --- | --- |
| Channel split, poll, delivery, the ask refusal | `extensions/capabilities/human-gate.ts` (`resolveChannel`, `observeGithubAnswer`, `waitHarnessIdentity`, `waitHarnessBotLogins`, `askHuman`) |
| Issue-comment argv, `--slurp` parse, identity filter, read guard | `src/github-comments.ts` |
| Which channel a bead answers on (pure classifier) | `src/github-answer-target.ts` |
| Config + map → target (only the composer calls it) | `src/github-answer-target-resolution.ts` |
| Design record | [`docs/github-primary.md`](github-primary.md) §7 |

## What changed / who this affects

Anyone running a workflow in a repo whose `.belayd/config.json` says
`"authority": "github"`. Local-authority repos see no change at all.

**Configuration.** Two files, both repo-scoped (they are read from the parent of
git's shared common dir, so a linked worktree sees the same ones):

```json
// <repo-root>/.belayd/config.json
{ "authority": "github", "github": { "owner": "acme", "repo": "widgets" } }
```

```json
// <repo-root>/.belayd/github-map.json
{
  "version": 1,
  "repo": { "owner": "acme", "name": "widgets" },
  "issues": { "bd-182": { "number": 42, "nodeId": "I_kwDOx" } },
  "unmappedDependencies": []
}
```

A bead with no entry in that map has no answer channel, so `belayd_ask_human`
**refuses** (exit 1, "no gate was opened") instead of opening a gate nobody can
answer. An unreadable/corrupt map is treated as `unknown` (not `unmapped`) and
refuses the same way, naming the map.

**What the poll reads.** `gh api --paginate --slurp
repos/{owner}/{repo}/issues/{n}/comments?since=<gate createdAt>`. `since` is a
query parameter, not a `gh` flag; `--slurp` keeps every page in one JSON
document (flattened into a comment list, unparsable records counted and named in
one warning). The cursor is the **gate's** `createdAt`, never a persisted
comment id and never the restart time; bd/GitHub timestamps are
second-granularity, hence `>=`.

**Identity.** The harness's own question can never be read back as the answer:

- the comment id returned by the `POST` is excluded (`answerCommentId`), even
  when `gh` authenticates as a real human account;
- the login from `gh api user` joins the allowlist;
- `user.type == "Bot"` and any login ending in `[bot]` are always harness;
- `BELAYD_GITHUB_BOT_LOGINS` (comma/whitespace separated, case-insensitive,
  deduped, lowercased) adds a harness that comments as an ordinary user account.

If neither the posted id nor that login can be determined, the read **fails
closed** (`unknown`) and the wait stays armed. The allowlist and the identity are
resolved once per wait — a *failed* identity read is retried on every claim
cycle — and a restart re-reads the environment.

**Exactly once.** The 30 s poll and the turn-start fallback share one claim
(`state.humanAnswerClaimed`), so a single answer cannot be delivered twice. The
gate is resolved only after `pi.sendUserMessage` succeeded; a failed send
releases the claim and the next tick retries.

**Restart and parked sessions.** Nothing is persisted harness-side: a restart
re-arms from the open gate (`bd gate list <bead> --json`), re-reads the map and
the env, and keeps the gate's `createdAt` as the cursor, so an answer posted
before the restart is still delivered. A *parked* session (a fleet member whose
process is not running) is woken by `belayd-pr-watch` — that is the neighbouring
bead bd-174.12, not this one.

## How to Verify

Everything below was run in this worktree, with no network and no real `gh`.
Run from the repository root after `pnpm build` (the pure halves are asserted
against `dist/`).

### 1. Gates

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test
pnpm test:integration
```

Real output (tool lines only):

```text
$ tsc --noEmit
$ biome check .
Checked 310 files in 588ms. No fixes applied.
$ tsc

 Test Files  137 passed (137)
      Tests  3788 passed (3788)

 Test Files  14 passed (14)
      Tests  108 passed (108)
```

### 2. The suites that pin this bead

```bash
node_modules/.bin/vitest run \
  src/__tests__/github-comments.test.ts \
  src/__tests__/extension-human-answer.test.ts \
  src/__tests__/capability-import-boundary.test.ts
```

```text
 ✓ src/__tests__/github-comments.test.ts (32 tests) 17ms
 ✓ src/__tests__/capability-import-boundary.test.ts (20 tests) 1131ms
 ✓ src/__tests__/extension-human-answer.test.ts (48 tests) 1136ms
 Test Files  3 passed (3)
      Tests  100 passed (100)
```

Case names worth knowing, by what they prove:

| Test (`src/__tests__/…`) | Proves |
| --- | --- |
| `extension-human-answer` › `posts the question to the issue endpoint, never a PR` | argv is `/issues/<n>/comments --input -`, body on stdin, no `/pulls/` |
| `extension-human-answer` › `resolves exactly once for a human issue comment at/after the gate time` | one send, one `gate resolve` |
| `extension-human-answer` › `shares one claim between an in-flight poll tick and the turn-start fallback` | the claim flag, both paths |
| `extension-human-answer` › `keeps the wait armed when the send fails, then delivers on a later tick` | resolve only after a successful send |
| `extension-human-answer` › `does not resolve the wait for a bot or [bot]-typed comment` | `Bot`, `[bot]`, allowlist |
| `extension-human-answer` › `never reads the harness's own question back as the answer (C2)` | posted-id exclusion |
| `extension-human-answer` › `excludes the harness's own question by authenticated login when its id is unknown` | login exclusion |
| `extension-human-answer` › `fails closed while the identity is unknown, then retries it on the next claim` | no id + no identity ⇒ armed, retried |
| `extension-human-answer` › `re-arms after a restart and still uses the gate time as the cursor` | `since=` is the gate's `createdAt` |
| `extension-human-answer` › `never settles the wait when gh is unauthenticated or absent` | `gh` failure ⇒ armed |
| `extension-human-answer` › `refuses to ask, and opens no gate, for a bead with no mapped issue` | unmapped ask |
| `extension-human-answer` › `refuses to ask, and opens no gate, when the map cannot be read` | corrupt map ask |
| `github-comments` › `returns ok:false when gh is absent (ENOENT)` / `… on a non-zero exit and on non-JSON stdout` | the read never throws |
| `github-comments` › `selectHumanAnswer skips bot and allowlisted comments` | the filter, unit level |
| `capability-import-boundary` › `keeps the bd-182 GitHub answer modules inside the scan scope` | the capability graph does not reach the fleet resolver |

### 3. The pure halves, through `dist/`

```bash
node --input-type=module -e '
const m = await import("./dist/src/index.js");
const j = (v) => JSON.stringify(v);

// the two argv builders and the identity read
console.log("read:   ", j(m.buildIssueCommentsArgv({ owner: "acme", repo: "widgets", number: 42, since: "2026-10-26T21:22:05.000Z" })));
console.log("post:   ", j(m.buildIssueCommentCreateArgv({ owner: "acme", repo: "widgets", number: 42 })));
console.log("user:   ", j(m.buildAuthenticatedUserArgv()));
console.log("owner:  ", j(m.buildIssueCommentsArgv({ owner: "--upload-pack=evil", repo: "widgets", number: 42, since: "2026-10-26T21:22:05Z" })));
console.log("number: ", j(m.buildIssueCommentsArgv({ owner: "acme", repo: "widgets", number: 0, since: "2026-10-26T21:22:05Z" })));
console.log("cursor: ", j(m.buildIssueCommentsArgv({ owner: "acme", repo: "widgets", number: 42, since: "yesterday" })));

// --slurp: an array of page arrays, a plain array, one object, and junk
const page = (n) => ({ id: n, body: "b" + n, created_at: "2026-10-26T21:23:00Z", user: { login: "hugo", type: "User" } });
console.log("slurp:  ", j(m.parseIssueComments([[page(1), page(2)], [page(3)]]).map((c) => c.id)));
console.log("array:  ", j(m.parseIssueComments([page(7)]).map((c) => c.id)));
console.log("object: ", j(m.parseIssueComments(page(8)).map((c) => c.id)));
console.log("dropped:", j(m.parseIssueCommentsWithDropped([page(1), { id: 2, body: "x", created_at: "2026-10-26T21:23:00Z", user: null }, "junk"]).dropped));

// BELAYD_GITHUB_BOT_LOGINS: comma/whitespace separated, lowercased, deduped
console.log("logins: ", j(m.harnessGithubLogins("Belayd-Bot, harness\trobot\nAUTOMATION,belayd-bot")));
'
```

Real output:

```text
read:    {"ok":true,"argv":["api","--paginate","--slurp","repos/acme/widgets/issues/42/comments?since=2026-10-26T21%3A22%3A05.000Z"]}
post:    {"ok":true,"argv":["api","--method","POST","repos/acme/widgets/issues/42/comments","--input","-"]}
user:    ["api","user"]
owner:   {"ok":false,"error":"refusing GitHub owner \"--upload-pack=evil\""}
number:  {"ok":false,"error":"refusing GitHub issue number \"0\""}
cursor:  {"ok":false,"error":"refusing GitHub comment cursor \"yesterday\""}
slurp:   ["1","2","3"]
array:   ["7"]
object:  ["8"]
dropped: 2
logins:  ["belayd-bot","harness","robot","automation"]
```

Note what the read argv does **not** contain: any `/pulls/` path, and any
`--method` (`gh api` defaults to GET). The cursor is URL-encoded where it needs
to be, and a flag-shaped owner, a non-positive issue number, or an unparseable
cursor is refused before it can reach a path.

```bash
node --input-type=module -e '
const m = await import("./dist/src/index.js");
const j = (v) => JSON.stringify(v);

// who counts as a human on an issue comment
const allowlist = m.harnessGithubLogins("acme-release-bot");
const comment = (id, author, type, createdAt, text) => ({ id, author, authorType: type, createdAt, text });
const thread = [
  comment("100", "hugo", "User", "2026-10-26T21:20:00Z", "before the gate"),
  comment("101", "acme-release-bot", "User", "2026-10-26T21:22:06Z", "nightly report"),
  comment("102", "ci", "Bot", "2026-10-26T21:22:07Z", "bot"),
  comment("103", "acme-release[bot]", "User", "2026-10-26T21:22:08Z", "[bot] login"),
  comment("104", "reviewer", "User", "2026-10-26T21:22:09Z", "option b, ship it"),
];
for (const c of thread) console.log("human?", c.id, c.author.padEnd(17), m.isHumanIssueComment(c, allowlist));

const sinceMs = Date.parse("2026-10-26T21:22:05Z");
console.log("answer:      ", j(m.selectHumanAnswer(thread, { sinceMs, allowlist })?.text));
console.log("exclude 104: ", j(m.selectHumanAnswer(thread, { sinceMs, allowlist, excludeId: "104" })?.text));
console.log("gh login hugo:", j(m.selectHumanAnswer(thread, { sinceMs, allowlist: [...allowlist, "hugo"] })?.text));

// the read-only guard: false for anything that could write
for (const argv of [
  ["api", "user"],
  ["api", "--paginate", "--slurp", "repos/acme/widgets/issues/42/comments?since=2026-10-26T21%3A22%3A05.000Z"],
  ["api", "--method", "GET", "repos/acme/widgets/issues/42/comments"],
  ["api", "--method", "POST", "repos/acme/widgets/issues/42/comments", "--input", "-"],
  ["api", "--method=POST", "repos/acme/widgets/issues/42/comments"],
  ["api", "-X", "DELETE", "repos/acme/widgets/issues/42"],
  ["api", "-XPOST", "repos/acme/widgets/issues/42"],
  ["api", "repos/acme/widgets/issues/42/comments", "--input", "-"],
  ["api", "repos/acme/widgets/issues/42/comments", "-f", "body=x"],
  ["api", "repos/acme/widgets/issues/42/comments", "-fbody=x"],
  ["api", "repos/acme/widgets/issues/42/comments", "-F", "body=@x"],
  ["api", "repos/acme/widgets/issues/42/comments", "-Fbody=@x"],
  ["repo", "view", "acme/widgets"],
]) console.log(String(m.isGhReadArgv(argv)).padEnd(6), argv.join(" "));
'
```

Real output:

```text
human? 100 hugo              true
human? 101 acme-release-bot  false
human? 102 ci                false
human? 103 acme-release[bot] false
human? 104 reviewer          true
answer:       "option b, ship it"
exclude 104:  undefined
gh login hugo: "option b, ship it"
true   api user
true   api --paginate --slurp repos/acme/widgets/issues/42/comments?since=2026-10-26T21%3A22%3A05.000Z
true   api --method GET repos/acme/widgets/issues/42/comments
false  api --method POST repos/acme/widgets/issues/42/comments --input -
false  api --method=POST repos/acme/widgets/issues/42/comments
false  api -X DELETE repos/acme/widgets/issues/42
false  api -XPOST repos/acme/widgets/issues/42
false  api repos/acme/widgets/issues/42/comments --input -
false  api repos/acme/widgets/issues/42/comments -f body=x
false  api repos/acme/widgets/issues/42/comments -fbody=x
false  api repos/acme/widgets/issues/42/comments -F body=@x
false  api repos/acme/widgets/issues/42/comments -Fbody=@x
false  repo view acme/widgets
```

`100` fails on time (before the gate), `101` on the allowlist, `102` on
`user.type`, `103` on the `[bot]` suffix. `exclude 104` shows the posted-id
exclusion: with the only human comment excluded, nothing is an answer. The `hugo`
row shows the login exclusion in action only for comments after the gate — the
`hugo` comment here predates it, so the answer is unchanged.

The classifier that picks the channel:

```bash
node --input-type=module -e '
const m = await import("./dist/src/index.js");
const j = (v) => JSON.stringify(v);
const github = { authority: "github", github: { owner: "acme", repo: "widgets" } };
const map = { version: 1, repo: { owner: "acme", name: "widgets" }, issues: { "bd-182": { number: 42, nodeId: "I_kw" } }, unmappedDependencies: [] };
console.log("bd authority:  ", j(m.classifyGithubAnswerTarget({ authority: { authority: "bd" }, beadId: "bd-182" })));
console.log("mapped:        ", j(m.classifyGithubAnswerTarget({ authority: github, beadId: "bd-182", map })));
console.log("unmapped:      ", j(m.classifyGithubAnswerTarget({ authority: github, beadId: "bd-999", map })));
console.log("map unreadable:", j(m.classifyGithubAnswerTarget({ authority: github, beadId: "bd-182", mapError: "/repo/.belayd/github-map.json: invalid JSON (...); using an empty map" })));
console.log("no github ref: ", j(m.classifyGithubAnswerTarget({ authority: { authority: "github" }, beadId: "bd-182" })));
'
```

Real output:

```text
bd authority:   {"kind":"local"}
mapped:         {"kind":"github","owner":"acme","repo":"widgets","issue":42}
unmapped:       {"kind":"unmapped","reason":"bd-999 has no issue in .belayd/github-map.json"}
map unreadable: {"kind":"unknown","reason":"/repo/.belayd/github-map.json: invalid JSON (...); using an empty map"}
no github ref:  {"kind":"unknown","reason":"authority is \"github\" but github.owner/github.repo is missing"}
```

### 4. A fake `gh` on `PATH`: one ask, one delivered answer

The extension source (`extensions/**/*.ts`) is not in `dist/`, so this uses the
`vite-node` that vitest already ships. `bd` is the real binary (1.3.0), run in a
throwaway `/tmp` database; `gh` is a shell shim that answers `api user` and the
issue-comment endpoint from a JSON file and logs every argv.

`/tmp/bd182-driver/run.sh` (`REPO_HOME` must point at this worktree):

```bash
#!/usr/bin/env bash
# bd-182: one belayd_ask_human ask, one delivered answer, no network, no real gh.
set -u
REPO_HOME=/home/hugo/git/feat-bd-182
D=/tmp/bd182-ghanswer
rm -rf "$D"; mkdir -p "$D/bin" "$D/bd182-ghanswer/.belayd"
export DRIVER_DIR="$D" REPO="$D/bd182-ghanswer" PATH="$D/bin:$PATH" GH_LOG="$D/gh-calls.log"
export BEADS_ACTOR="" BELAYD_GITHUB_BOT_LOGINS="acme-release-bot"

# 1. throwaway repo, two beads, the GitHub-primary config and the bead<->issue map
cd "$D/bd182-ghanswer" || exit 1
git init -q -b main
bd init -p bd >/dev/null 2>&1
ID=$(bd create "github answer probe" -t task --json | jq -r '.id')
BEAD2=$(bd create "unmapped probe" -t task --json | jq -r '.id')
export BEAD_ID="$ID" BEAD2
printf '%s\n' '{"authority":"github","github":{"owner":"acme","repo":"widgets"}}' > .belayd/config.json
printf '%s\n' "{\"version\":1,\"repo\":{\"owner\":\"acme\",\"name\":\"widgets\"},\"issues\":{\"$ID\":{\"number\":42,\"nodeId\":\"I_kwDOx\"}},\"unmappedDependencies\":[]}" > .belayd/github-map.json
echo "mapped bead:   $ID -> issue #42"
echo "unmapped bead: $BEAD2 (deliberately absent from the map)"
echo

# 2. a fake gh: answers `api user` and the issue-comment read/POST from a JSON file
cat > "$D/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "gh $*" >> "$GH_LOG"
if [ "$1 $2" = "api user" ]; then printf '%s\n' '{"login":"hugo"}'; exit 0; fi
if [ "${1:-} ${2:-} ${3:-}" = "api --method POST" ]; then
  created=$(cat | jq -c --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id: 900, body: .body, created_at: $now, user: {login: "hugo", type: "User"}}')
  if [ -s "$DRIVER_DIR/thread.json" ]; then
    jq -s --argjson c "$created" '.[0] + [$c]' "$DRIVER_DIR/thread.json" > "$DRIVER_DIR/thread.tmp"
  else
    jq -n --argjson c "$created" '[$c]' > "$DRIVER_DIR/thread.tmp"
  fi
  mv "$DRIVER_DIR/thread.tmp" "$DRIVER_DIR/thread.json"
  printf '%s\n' '{"id":900}'
  exit 0
fi
# the `?since=` read: `[[comment, …]]`, exactly what --slurp produces
if [ -f "$DRIVER_DIR/thread.json" ]; then jq -c '[.]' "$DRIVER_DIR/thread.json"; else printf '%s\n' '[]'; fi
GH
chmod +x "$D/bin/gh"

# 3. drive the real belayd_ask_human tool and the real poll through vite-node
#    (extensions/ is TypeScript source, not in dist/, so it needs a TS loader)
VN=$(ls -d "$REPO_HOME"/node_modules/.pnpm/vite-node@*/node_modules/vite-node/vite-node.mjs)
cd "$REPO_HOME" || exit 1
node "$VN" /tmp/bd182-driver/drive.ts

echo
echo "--- every gh argv the harness ran ---"
cat "$GH_LOG"
echo "--- argv containing /pulls/: $(grep -c '/pulls/' "$GH_LOG") ---"
```

`/tmp/bd182-driver/drive.ts`:

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  humanAnswerMessage,
  registerHumanGate,
  type HumanGateDeps,
} from "/home/hugo/git/feat-bd-182/extensions/capabilities/human-gate.js";
import { runBdCommand } from "/home/hugo/git/feat-bd-182/extensions/capabilities/context.js";
import {
  createInitialSessionState,
  createSessionStateStore,
} from "/home/hugo/git/feat-bd-182/extensions/capabilities/session-state.js";
import {
  lookupOpenHumanGate,
  resolveGitCommonDir,
  resolveGithubAnswerTargetForSession,
} from "/home/hugo/git/feat-bd-182/src/index.js";

const repoRoot = process.env.REPO ?? "";
const beadId = process.env.BEAD_ID ?? "";
const threadPath = join(process.env.DRIVER_DIR ?? "", "thread.json");

const store = createSessionStateStore(createInitialSessionState);
const sent: string[] = [];
const deps: HumanGateDeps = {
  getSessionState: store,
  resolveSessionBdActor: () => "belayd:bd-182:orchestrator",
  resolveGithubAnswerTarget: (ctx, id) =>
    resolveGithubAnswerTargetForSession({ cwd: ctx.cwd ?? repoRoot, beadId: id, resolveGitCommonDir }).target,
  sendUserMessage: (text: string) => {
    sent.push(text);
  },
};

type Handler = {
  execute: (...args: never[]) => Promise<{ content: Array<{ text: string }>; details: { exitCode: number } }>;
};
const tools = new Map<string, Handler>();
registerHumanGate({ registerTool: (tool: Handler) => tools.set(tool.name, tool) } as never, deps);

const session = {
  cwd: repoRoot,
  sessionName: "belayd-bd-182",
  sessionManager: { getSessionId: () => "s-drive", getSessionName: () => "belayd-bd-182" },
};
const state = store(session as never);
state.gateActive = true;
state.currentTaskId = beadId;

const ask = tools.get("belayd_ask_human");
if (ask === undefined) throw new Error("belayd_ask_human was not registered");

const asked = await ask.execute(
  "call-1",
  { question: "Which option: A or B?" } as never,
  undefined as never,
  undefined as never,
  session as never,
);
console.log("ask result:", asked.content.map((part) => part.text).join(" "));
console.log("exitCode:", asked.details.exitCode);
console.log("channel recorded:", JSON.stringify(state.awaitingHuman?.channel));
console.log("posted comment id:", state.awaitingHuman?.answerCommentId);

const tick = async (label: string): Promise<void> => {
  const delivered = await humanAnswerMessage(session as never, deps);
  console.log(
    label,
    delivered === undefined
      ? `nothing deliverable (wait armed: ${String(state.awaitingHuman !== undefined)})`
      : `would deliver: ${delivered.message.content}`,
  );
};
await tick("turn-start tick, question only:");

const thread = JSON.parse(readFileSync(threadPath, "utf8")) as unknown[];
const at = (offsetSeconds: number): string =>
  new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
thread.push(
  { id: 901, body: "nightly report", created_at: at(30), user: { login: "acme-release-bot", type: "User" } },
  { id: 902, body: "option b, ship it", created_at: at(31), user: { login: "reviewer", type: "User" } },
);
writeFileSync(threadPath, JSON.stringify(thread, null, 1));
console.log("2 comments added to issue #42: acme-release-bot (allowlisted), reviewer (the human)");
console.log("waiting up to 40 s for the 30 s poll to deliver...");

const deadline = Date.now() + 40_000;
while (sent.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.log("pi.sendUserMessage delivered:", JSON.stringify(sent));
console.log("gate id resolved:", state.awaitingHuman === undefined ? "wait cleared" : "STILL ARMED");
await tick("turn-start tick after the poll:");

const gate = await lookupOpenHumanGate({ beadId, cwd: repoRoot, runBd: runBdCommand });
console.log("gate after delivery:", JSON.stringify(gate));

const ghLog = process.env.GH_LOG ?? "";
const posts = (): number =>
  readFileSync(ghLog, "utf8").split("\n").filter((line) => line.includes("--method POST")).length;
const postsBefore = posts();
const unmapped = await ask.execute(
  "call-2",
  { question: "Which option: A or B?", beadId: process.env.BEAD2 } as never,
  undefined as never,
  undefined as never,
  session as never,
);
console.log("unmapped ask:", unmapped.content.map((part) => part.text).join(" "));
console.log("  exitCode:", unmapped.details.exitCode, "| new gh writes:", posts() - postsBefore);
console.log(
  "  gate:",
  JSON.stringify(await lookupOpenHumanGate({ beadId: process.env.BEAD2 ?? "", cwd: repoRoot, runBd: runBdCommand })),
);
```

```bash
bash /tmp/bd182-driver/run.sh
```

Real output (ids differ per run; the gate id and bead ids come from bd):

```text
mapped bead:   bd-1rt -> issue #42
unmapped bead: bd-qh7 (deliberately absent from the map)

ask result: Asked a human on bd-1rt (gate bd-fzw).
The bead is blocked by a `human` gate and every phase tool is REFUSED until an answer arrives.
END YOUR TURN NOW — do not guess, do not proceed, do not call another phase tool. The answer arrives as a user message.
exitCode: 0
channel recorded: {"kind":"github","owner":"acme","repo":"widgets","issue":42}
posted comment id: 900
turn-start tick, question only: nothing deliverable (wait armed: true)
2 comments added to issue #42: acme-release-bot (allowlisted), reviewer (the human)
waiting up to 40 s for the 30 s poll to deliver...
pi.sendUserMessage delivered: ["reviewer answered: option b, ship it"]
gate id resolved: wait cleared
turn-start tick after the poll: nothing deliverable (wait armed: false)
gate after delivery: {"ok":true,"status":"none"}
unmapped ask: belayd_ask_human: cannot ask about bd-qh7: bd-qh7 has no issue in .belayd/github-map.json. Map the bead to a GitHub issue in .belayd/github-map.json (or fix .belayd/config.json) and retry; no gate was opened.
  exitCode: 1 | new gh writes: 0
  gate: {"ok":true,"status":"none"}

--- every gh argv the harness ran ---
gh api --method POST repos/acme/widgets/issues/42/comments --input -
gh api user
gh api --paginate --slurp repos/acme/widgets/issues/42/comments?since=2026-11-01T20%3A12%3A01.000Z
gh api --paginate --slurp repos/acme/widgets/issues/42/comments?since=2026-11-01T20%3A12%3A01.000Z
--- argv containing /pulls/: 0 ---
```

Read it as the acceptance path, top to bottom:

- the question went to `/issues/42/comments` (a POST, body on stdin) and the
  returned id `900` was recorded as `postedCommentId`;
- the identity read happened once (`gh api user`) and is reused for the wait;
- both comment reads carry `since=` **equal to the gate's `createdAt`** — the
  first (turn-start tick) found the question only and delivered nothing, the
  second (30 s poll) found the allowlisted bot comment, skipped it, and delivered
  `reviewer answered: option b, ship it` through `pi.sendUserMessage`;
- the gate is `none` afterwards and the post-poll tick delivers nothing, i.e.
  exactly once;
- the unmapped bead was refused with exit 1, made **zero** `gh` writes and left
  no gate.

Two things this walkthrough does not cover, deliberately: the parked-session wake
(`belayd-pr-watch`, bd-174.12) and a real GitHub App token (bd-7). Everything
above runs offline.

### 5. Cleanup

```bash
rm -rf /tmp/bd182-ghanswer /tmp/bd182-driver
```

## How to Use

### Turning it on

Nothing to enable beyond the authority switch that bd-180 already defines, plus
one map entry per bead that may need a person:

```json
{ "authority": "github", "github": { "owner": "acme", "repo": "widgets" } }
```

```json
{
  "version": 1,
  "repo": { "owner": "acme", "name": "widgets" },
  "issues": { "bd-182": { "number": 42, "nodeId": "I_kwDOx" } },
  "unmappedDependencies": []
}
```

`.belayd/github-map.json` is written by the projection, not by hand (see
[`bd-180-userguide.md`](bd-180-userguide.md) §5); this bead only reads it. A bead
missing from `issues` cannot ask — the refusal names the bead and the file, and no
gate is created.

To go back to the bead thread, set `"authority": "bd"`; the bd-152 path is
untouched, including its `isHumanComment` filter and its comment caps.

### Asking and answering

The orchestrator calls the tool exactly as in bd-152:

```json
{ "question": "Issue #42 cannot satisfy both constraints. (a) keep the shim, or (b) drop it and require a migration?", "beadId": "bd-182" }
```

Then it ends its turn. Under `authority: "github"` the question is posted as a
comment on issue #42 and the returned tool text is unchanged
(`Asked a human on bd-182 (gate bd-fzw). …`).

The person answers by commenting on the issue — the same place they will read the
question:

```bash
gh issue comment 42 --body "option b — keep the shim"
gh issue view 42 --comments
```

- The answer is the **first** comment at/after the gate's `createdAt` whose author
  is not a bot, not `[bot]`, not in `BELAYD_GITHUB_BOT_LOGINS`, and not the
  harness's own posted comment.
- It arrives as a real user turn: `reviewer answered: option b, ship it` (body
  flattened to one line, capped at 2 000 characters like bd-152).
- The gate is then resolved (`bd gate resolve <gate>`) and phase tools come back.
  The work bead stays `open` — answering is not accepting.
- A PR comment is never read. Only `…/issues/<n>/comments` is called, and the
  guard refuses any `gh api` argv carrying `--method POST`, `--input`, `-f`/`-F`,
  `--raw-field`, or `--field`.

Watching it from bd stays the same as bd-152 (`bd gate list <bead>
--json`, `bd blocked`, `bd ready`); the prompt's waiting line names the issue:
`Reply on GitHub issue #42 (acme/widgets)`. The phase-tool refusal string is
still the channel-agnostic bd-152 wording ("Post a comment on the bead …"), so
trust the prompt line for the channel, not the refusal.

### A harness that comments as a real user account

`user.type == "Bot"` and a `[bot]` login suffix are always treated as harness, but
a GitHub App installation that comments through a normal user account looks
human. Three things cover it: the posted comment's id, the authenticated
`gh api user` login, and this allowlist:

```bash
export BELAYD_GITHUB_BOT_LOGINS="acme-release-bot, ci-mirror robot"
```

Comma/whitespace separated, case-insensitive, read once per wait and re-read
after a restart. The authenticated `gh api user` login is added automatically, and
the posted comment's id is excluded regardless — that id is the primary
guarantee, the allowlist is defence in depth.

### Failure modes

| Situation | What happens | What you see / do |
| --- | --- | --- |
| `gh` absent (`ENOENT`) | read is `unknown`, wait stays armed, no resolve | `[belayd-harness] cannot read the human answer channel for acme/widgets#42: <spawn error>` (once per wait) |
| `gh` unauthenticated, non-zero exit, non-JSON stdout | same: `unknown`, wait armed | the same warning carries `gh`'s own error/exit text; the poll retries every 30 s |
| Identity unknown **and** the posted comment id unknown | fails closed — `unknown`, wait armed, retried next cycle | `… no posted comment id is known, so the read fails closed: the wait stays armed until the identity resolves` |
| Identity unknown but the posted id is known | read proceeds with the id excluded | `… relying on the posted comment id 900 and the bot/allowlist rules` |
| Comment from a bot, `[bot]` login, allowlisted login, or the harness's own comment | never an answer | waiting continues |
| `.belayd/github-map.json` unreadable/corrupt | `belayd_ask_human` refuses, **no gate opened** | exit 1, `… has no issue in .belayd/github-map.json … no gate was opened` / the map error |
| Bead has no mapped issue | same refusal, no gate | exit 1, `cannot ask about bd-qh7: bd-qh7 has no issue in …` |
| Gate JSON corrupt or renamed (`status`/`await_type` changed) | treated as `unknown`, wait stays armed (bd-152 rule) | one warning per wait |
| `bd gate list` reports no gate | the wait is genuinely resolved (external `bd gate resolve`) | resumption message, `… was resolved without a comment; you may proceed.` |
| Question post fails | the gate is resolved again (compensation); if that also fails the wait stays armed | exit 1 with the recovery commands |
| `pi.sendUserMessage` fails | claim released, gate **not** resolved, next tick retries | nothing is lost but the turn |
| A second `belayd_ask_human` while one is open | no second gate, no second poll | `Already waiting for a human answer on <bead> — END YOUR TURN.` |

### From code

The read half is exported from `belayd-agent-harness`, and the `gh` runner is
injected — which is how the walkthrough above drives it against a shim:

```typescript
import { execFile } from "node:child_process";

import {
  buildIssueCommentsArgv,
  harnessGithubLogins,
  isGhReadArgv,
  lookupAuthenticatedLogin,
  lookupIssueComments,
  selectHumanAnswer,
} from "belayd-agent-harness";

const runGh = async (argv: readonly string[], options: { cwd: string }) => ({
  stdout: (await execFile("gh", [...argv], { cwd: options.cwd })).stdout,
});

buildIssueCommentsArgv({ owner: "acme", repo: "widgets", number: 42, since: "2026-10-26T21:22:05Z" });
// ["api","--paginate","--slurp","repos/acme/widgets/issues/42/comments?since=…"]
isGhReadArgv(["api", "--method", "POST", "repos/acme/widgets/issues/42/comments"]); // false

const since = "2026-10-26T21:22:05.000Z";
const read = await lookupIssueComments({
  repo: { owner: "acme", repo: "widgets" },
  number: 42,
  since,
  cwd: "/repo",
  runGh,
});
if (read.ok) {
  const allowlist = [...harnessGithubLogins(process.env.BELAYD_GITHUB_BOT_LOGINS)];
  const identity = await lookupAuthenticatedLogin({ cwd: "/repo", runGh });
  if (identity.ok) allowlist.push(identity.login);
  const answer = selectHumanAnswer(read.comments, {
    sinceMs: Date.parse(since),
    allowlist,
    excludeId: "900", // the harness's own question; omit only if unknown
  });
  // answer: { id, author, authorType, createdAt, text } | undefined
}
```

`lookupIssueComments` never throws: `gh` absent, unauthenticated, non-zero, or
non-JSON all come back as `{ ok: false }` — read that as "unknown", never as "no
answer yet". And if neither `identity` nor `excludeId` is available, do not call
`selectHumanAnswer` at all: that is the case the harness fails closed on (an
issue comment cannot be told apart from the question).

Related: [`docs/bd-152-userguide.md`](bd-152-userguide.md) (the human answer
channel and its bd gate), [`docs/bd-180-userguide.md`](bd-180-userguide.md)
(authority config, the bead ↔ issue map, append-only policy),
[`docs/github-primary.md`](github-primary.md) (design record, §7 is this bead).
