# Stale-file guard edit enforcement — user guide (bd-91)

The stale-file guard (`extensions/stale-file-guard.ts`, logic in
`src/stale-file-guard.ts`) blocks an `edit` when the file changed after the agent
last read it. It only sees an edit if it can find the target path in the
`tool_call` input, and bd-91 fixed that lookup: the guard read only the legacy
`filePath` field, while pi 1.0.x `EditToolInput` is `{ path, edits: [{ oldText,
newText }] }`. Every edit therefore carried no path, the check was skipped, and
the guard was a silent no-op.

`extractEditPath(input)` now prefers `path` and falls back to `filePath` (other
tool schemas and older pi versions, matching `extensions/worktree-guard.ts`). A
missing, empty or non-string path returns `undefined` instead of throwing, so
hostile or partial input is never blocked on a guess.

## How to Verify

Run from the repository root, in a devShell.

### 1. The focused suite

```bash
pnpm test src/__tests__/extension-stale-file-guard.test.ts
```

Expected: `Test Files 1 passed (1)` / `Tests 20 passed (20)`. The cases that pin
bd-91:

| Case | Pins |
|---|---|
| `blocks a stale edit for a faithful 1.0.2 EditToolInput ({ path, edits[] })` | the real pi 1.0.x shape is enforced end-to-end through the `tool_call` handler |
| `accepts the capitalized Edit tool name` | `Edit` (not just `edit`) is enforced |
| `blocks a stale edit supplied through the legacy \`filePath\` field` | the fallback still works |
| `reads \`path\` from the documented EditToolInput shape`, `prefers \`path\` when both fields are present` | `extractEditPath` precedence |
| `does not throw or block on null, non-object or non-string path input` | odd input neither throws nor blocks |
| `does not block an edit the guard has no hash for`, `does not block an edit for a file read and left unchanged` | non-stale edits still pass |
| `does not block a write tool_call (write is an intentional overwrite)` | `write` is out of scope |

### 2. Failing-before / passing-after

Restore the pre-bd-91 lookup in a throwaway copy and run the same suite against
it — the worktree file is untouched:

```bash
D=/tmp/bd91-old-guard
rm -rf "$D" && mkdir -p "$D/extensions" "$D/src/__tests__"
cp extensions/stale-file-guard.ts "$D/extensions/"
cp src/stale-file-guard.ts "$D/src/"
cp src/__tests__/extension-stale-file-guard.test.ts "$D/src/__tests__/"
perl -0pi -e 's/  const path = typeof candidate\.path === "string" \? candidate\.path : candidate\.filePath;/  const path = candidate.filePath;/' "$D/extensions/stale-file-guard.ts"
pnpm vitest run --root "$D" src/__tests__/extension-stale-file-guard.test.ts
rm -rf "$D"
```

Expected on the old lookup: `Tests 4 failed | 16 passed (20)` — the two
`tool_call` cases above (`({ path, edits[] })`, capitalized `Edit`) and the two
`extractEditPath` path cases fail; everything else, including the legacy
`filePath` case, still passes. That failure set is the bug: with only `filePath`
read, a real pi edit is never checked. In the worktree (`pnpm test …`, step 1)
all 20 pass.

### 3. Full gates

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: `tsc --noEmit` clean; `biome check` reports the file count with no fixes
applied; `pnpm test` green (baseline for bd-91 was 174 files / 4942 tests, now
174 files / 4949). `pnpm test:integration` is unaffected by this change.

## How to Use

Nothing to configure or call — the guard is an extension loaded by pi from
`package.json` `pi.extensions` (`./extensions/stale-file-guard.ts`), so it runs in
every session that loads the harness package. What the agent/user sees is a
blocked `edit` with the reason:

```
"<absolute path>" has changed since it was read. Re-read it to get the latest content.
```

Behaviour matrix, as the code actually behaves:

| Scenario | Outcome |
|---|---|
| Read → edit, file unchanged | Passes |
| Read → external change (another process, `write`, checkout) → edit | **Blocked** (hash mismatch) |
| Read → external change → re-read → edit | Passes |
| Read → user-typed bash (`user_bash`) → edit | Passes — `clearHashes()` wipes every tracked hash, so there is no baseline left to compare (conservative invalidation) |
| Read → **agent** `bash` tool call that mutates the file → edit | **Blocked** (hash mismatch). Agent bash does **not** clear hashes: `clearHashes` is wired to `user_bash` only, and pi emits that event for user-initiated bash (interactive `handleBashCommand`, RPC `bash`), not for the agent's `bash` tool. bd-283 tracks this doc/behaviour gap — the matrix comment at the top of `src/stale-file-guard.ts` claims bash clears hashes; only `user_bash` does |
| Edit without reading first | Allowed (no hash to compare) |
| `write` tool call | Not blocked (write is an intentional overwrite) |
| `bash` tool call whose command contains `git` and `--no-verify` | **Blocked** (`git --no-verify is not allowed. Pre-commit hooks (lefthook) must run on every commit.`) |
| Any tool input with no usable path (absent, `""`, non-string) | Not blocked, no throw |

Paths are normalized (`src/stale-file-guard.ts`, `normalizePath`): an absolute
path is kept as-is, a relative one is resolved against `process.cwd()` at both
record and check time, so read and edit must agree on cwd.

### Deployment: the global copy must move in lockstep

The same guard also ships globally as
`~/.pi/agent/extensions/belayd-stale-file-guard.ts`. Both copies register the same
`tool_call`/`tool_result`/`user_bash` handlers, so the extension self-dedupes on a
process-wide marker (`__belayd_stale_file_guard_loaded__`): the **first copy
loaded wins** and the second returns before registering anything. pi loads
user-scope extensions before project-scope ones, so the global copy normally wins.

That makes an out-of-date global copy worse than a duplicate: a copy that still
reads only `input.filePath` is a silent no-op and, loading first, permanently
disables the fixed local copy for the whole process. The fix lives in this
repository's `extensions/stale-file-guard.ts` only — **redeploy the global copy
whenever the guard's input contract changes**, or machines running the older one
keep the dead guard.

Check which copy is live, and whether it is current:

```bash
ls -l ~/.pi/agent/extensions/belayd-stale-file-guard.ts
readlink -f ~/.pi/agent/extensions/belayd-stale-file-guard.ts   # store path / checkout it resolves to
grep -c "extractEditPath" "$(readlink -f ~/.pi/agent/extensions/belayd-stale-file-guard.ts)"
```

Expected after redeploy: the file resolves to the copy carrying `extractEditPath`
(count `2` or more). `grep` returning `0` means the loaded copy still reads only
`filePath` and the guard is dead in that process.

For the dev loop, `./bin/pi` loads the worktree copy and never the global one: it
passes `-ne` (no extension discovery) plus an explicit `-e` per entry from
`package.json` `pi.extensions`, which includes
`$repo_dir/extensions/stale-file-guard.ts`. Use it after redeploying or editing
the guard:

```bash
./bin/pi
```
