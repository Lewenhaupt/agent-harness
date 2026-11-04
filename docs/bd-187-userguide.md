# Shared model-state store and provider wrapper — operator guide (bd-187)

The API key is globally shared, but before this bead every process kept its own
opinion of cooldown, capacity and spend, so two repo daemons each believed they
owned the remaining budget and burned into the same 429. bd-187 adds one shared
SQLite state file plus a provider wrapper that reads and writes it at the single
point every runtime dispatches through.

| Piece | Where |
|---|---|
| Shared store (cooldown, capacity/lease, spend) | `src/model-state-store.ts` |
| Decision layer (dispatch, failure, lease, spend, retry constants) | `src/provider-policy.ts` |
| Provider wrapper and installers | `src/provider-wrapper.ts` |
| pi extension registration (`session_start`, per-turn reconcile) | `extensions/capabilities/model.ts`, `extensions/capabilities/workflow-context.ts` |
| Package exports | `src/index.ts` |
| Cross-process proof | `test/model-state-cross-process.integration.test.ts`, `test/fixtures/model-state-process.mjs` |
| Design record | [`model-capacity-and-telemetry.md`](model-capacity-and-telemetry.md#shared-model-state-store-and-provider-wrapper-bd-187) |

> **What this bead does and does not change.** It is **additive**. The old paths
> — `capacity-cache.ts`, `model-cooldown.ts`, the `spawn-with-fallback` loop,
> `model-session-state.ts` and telemetry — still run exactly as before; the
> deletions are a follow-up bead. There is no UI, no page and no browser step in
> this guide: everything below is a terminal command, a log line or a state file.
>
> **Explicit non-guarantee.** The store bounds and records concurrency; it does
> **not** coalesce identical in-flight requests across processes. Two processes
> can both see free capacity and both send a request whose capacity was free a
> moment ago. Coalescing would need a proxy, and the gateway design was rejected
> (bd-188). Nothing in this guide makes that claim.

---

## How to Verify

All commands run from this worktree root, on Node v24.18.0 (the store needs
`node:sqlite`, which this Node ships). Run `pnpm build` once before any script
that imports `dist/src/…`, and again after any `src/` edit.

### 1. The gates

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
```

Observed in this worktree (pnpm's own banner lines omitted):

```text
$ tsc --noEmit
$ biome check .
Checked 364 files in 697ms. No fixes applied.
$ tsc

Test Files  167 passed (167)
     Tests  4640 passed (4640)

Test Files  16 passed (16)
     Tests  115 passed (115)
```

All five exit 0. `Tests 4640 passed (4640)` carries **0 skipped**, so a bd-187
suite that silently skipped (a host without `node:sqlite`) would show up as a
different count, not as a pass.

### 2. The bd-187 suites alone

```bash
pnpm vitest run src/__tests__/model-state-store.test.ts \
  src/__tests__/provider-policy.test.ts \
  src/__tests__/provider-wrapper.test.ts \
  src/__tests__/extension-model-providers.test.ts \
  src/__tests__/extension-provider-registration.test.ts
```

```text
 ✓ src/__tests__/extension-model-providers.test.ts (14 tests) 13ms
 ✓ src/__tests__/provider-policy.test.ts (18 tests) 539ms
 ✓ src/__tests__/model-state-store.test.ts (20 tests) 620ms
 ✓ src/__tests__/provider-wrapper.test.ts (35 tests) 790ms
 ✓ src/__tests__/extension-provider-registration.test.ts (2 tests) 1461ms
 Test Files  5 passed (5)
      Tests  89 passed (89)
```

Then the two suites that grew the additive `capacity` failure kind:

```bash
pnpm vitest run src/__tests__/quota-failure.test.ts src/__tests__/spawn-with-fallback.test.ts
```

```text
 ✓ src/__tests__/quota-failure.test.ts (72 tests) 23ms
 ✓ src/__tests__/spawn-with-fallback.test.ts (63 tests) 49ms
 Test Files  2 passed (2)
      Tests  135 passed (135)
```

### 3. The cross-process integration file

```bash
pnpm vitest run --config vitest.integration.config.ts \
  test/model-state-cross-process.integration.test.ts --reporter=verbose
```

```text
 ✓ test/model-state-cross-process.integration.test.ts > shared model-state store across processes (bd-187) > two concurrent processes see one cooldown window, after the reader's cache lapses 107ms
 ✓ test/model-state-cross-process.integration.test.ts > shared model-state store across processes (bd-187) > a lease left by SIGKILL expires and frees capacity 82ms
 ✓ test/model-state-cross-process.integration.test.ts > shared model-state store across processes (bd-187) > a live child keeps its lease renewed past the original TTL across connections 1737ms
 ✓ test/model-state-cross-process.integration.test.ts > shared model-state store across processes (bd-187) > spend rows reconcile exactly with provider-reported usage 19ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Per-test durations are host-emitted; the counts and names are the stable part.

What each one actually proves, because a green line alone does not say it:

| Test | Real processes involved | What a wrong implementation does |
|---|---|---|
| `two concurrent processes see one cooldown window, after the reader's cache lapses` | reader store on the shared file, a child that writes `until_ms`, a **second** child that SELECTs | a per-process store returns its cached `null` and the exact-`untilMs` assertion fails |
| `a lease left by SIGKILL expires and frees capacity` | a child that writes a lease then `process.kill(pid, "SIGKILL")` itself | a pid-liveness lease or a lease that never prunes leaves the bucket at 1/1 and the post-expiry reservation is refused |
| `a live child keeps its lease renewed past the original TTL across connections` | a child heartbeating `UPDATE lease SET expires_ms = …` every 200 ms with a 1 500 ms TTL | remove the heartbeat and the lease expires at 1.5 s, so the parent's reservation is **granted** instead of refused |
| `spend rows reconcile exactly with provider-reported usage` | 4 real `wrapped.stream(…).result()` calls through one store | a double count gives `rows: 8`/`input: 8000`; a dropped row gives 3/3000 — both fail the exact aggregate |

### 4. A manual, real-SQLite recipe

This runs the real store over a scratch file and prints the schema, the WAL
mode, the file modes, a cooldown written by one store and read by another, a
lease with its refusal, and the spend sum. It needs `pnpm build` first.

```bash
cat > /tmp/bd187-recipe.mjs <<'EOF'
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const base = `${process.cwd()}/dist/src`;
const storeModule = await import(`${base}/model-state-store.js`);
const policyModule = await import(`${base}/provider-policy.js`);

const path = storeModule.resolveModelStatePath({ env: process.env });
console.log(`resolved store path: ${path}`);

// One writer store, and a rival store over the same file that claims another
// host/pid so lease ownership is a real check rather than the same process.
const openedWriter = storeModule.openModelStateStore({ path });
if (!openedWriter.ok) throw new Error(openedWriter.error);
const writer = openedWriter.store;
const openedRival = storeModule.openModelStateStore({ path, host: "other-host", daemonPid: 424242 });
if (!openedRival.ok) throw new Error(openedRival.error);
const rival = openedRival.store;

// 1. schema, WAL and file modes while the writer holds the file open
const inspect = new DatabaseSync(path, { readOnly: true });
const pragma = (name) => Object.values(inspect.prepare(`PRAGMA ${name}`).get() ?? {})[0];
console.log(`journal_mode: ${pragma("journal_mode")}  user_version: ${pragma("user_version")}`);
console.log(`tables: ${inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name).join(", ")}`);
inspect.close();
console.log(execSync(`ls -l ${path} ${path}-wal ${path}-shm`, { encoding: "utf8" }).trim());

// 2. one cooldown window, written by one store and read by the other
console.log(`rival before any write: ${JSON.stringify(rival.cooldownFor({ provider: "llmgateway", model: "glm-5.3" }))}`);
console.log(`markCooldown: ${JSON.stringify(writer.markCooldown({ provider: "llmgateway", model: "glm-5.3", durationMs: 60_000, reason: "429 rate limited", hinted: true }))}`);
console.log(`rival immediately (its own 1s read cache): ${JSON.stringify(rival.cooldownFor({ provider: "llmgateway", model: "glm-5.3" }))}`);
await new Promise((resolve) => setTimeout(resolve, 1_100));
console.log(`rival after the cache lapses: ${JSON.stringify(rival.cooldownFor({ provider: "llmgateway", model: "glm-5.3" }))}`);
const reader = new DatabaseSync(path, { readOnly: true });
console.log(`cooldown rows on disk: ${JSON.stringify(reader.prepare("SELECT provider, model, until_ms, reason, retry_after_ms FROM cooldown").all())}`);
reader.close();

// 3. one lease: granted, rival refused, released, rival granted
console.log(`writer reserveCapacity: ${JSON.stringify(writer.reserveCapacity({ provider: "llmgateway", class: "standard", limit: 1, leaseId: "daemon-a-lease" }))}`);
console.log(`rival reserveCapacity: ${JSON.stringify(rival.reserveCapacity({ provider: "llmgateway", class: "standard", limit: 1, leaseId: "daemon-b-lease" }))}`);
console.log(`rival releases the writer's lease: ${JSON.stringify(rival.releaseCapacity({ provider: "llmgateway", class: "standard", leaseId: "daemon-a-lease" }))}`);
console.log(`writer release: ${JSON.stringify(writer.releaseCapacity({ provider: "llmgateway", class: "standard", leaseId: "daemon-a-lease" }))}`);
console.log(`rival reserveCapacity after the release: ${JSON.stringify(rival.reserveCapacity({ provider: "llmgateway", class: "standard", limit: 1, leaseId: "daemon-b-lease" }))}`);
console.log(`capacity snapshot: ${JSON.stringify(rival.readCapacity({ provider: "llmgateway", class: "standard" }))}`);
rival.releaseCapacity({ provider: "llmgateway", class: "standard", leaseId: "daemon-b-lease" });

// 4. spend rows reconcile exactly with provider-reported usage
const usage = { input: 1_000, output: 250, cacheRead: 40, cacheWrite: 10, cost: 0.125 };
for (let index = 0; index < 4; index += 1) {
  writer.recordSpend({ ts: Date.now(), provider: "llmgateway", model: "glm-5.3", phase: "scout", taskId: "bd-187", ...usage });
}
console.log(`spendTotals: ${JSON.stringify(writer.spendTotals())}`);
console.log(`policy constants: ${JSON.stringify({ RECOMMENDED_RETRY_MAX_RETRIES: policyModule.RECOMMENDED_RETRY_MAX_RETRIES, MAX_ATTEMPTS_PER_DISPATCH: policyModule.MAX_ATTEMPTS_PER_DISPATCH, TRANSIENT_RETRY_BUDGET: policyModule.TRANSIENT_RETRY_BUDGET, DEFAULT_CAPACITY_LIMIT: policyModule.DEFAULT_CAPACITY_LIMIT, LEASE_TTL_FLOOR_MS: policyModule.LEASE_TTL_FLOOR_MS, LEASE_RENEWAL_INTERVAL_FLOOR_MS: policyModule.LEASE_RENEWAL_INTERVAL_FLOOR_MS, LEASE_TTL_DEFAULT_MS: storeModule.DEFAULT_CAPACITY_LEASE_TTL_MS })}`);

writer.close();
rival.close();
console.log(`file mode after close: ${(statSync(path).mode & 0o777).toString(8)} (octal), sidecars left behind: ${[`${path}-wal`, `${path}-shm`].filter((sidecar) => existsSync(sidecar)).length}`);
EOF
rm -f /tmp/bd187-state.sqlite*
BELAYD_MODEL_STATE_FILE=/tmp/bd187-state.sqlite node /tmp/bd187-recipe.mjs
```

Observed (the `until_ms`/`expiresMs` epoch values are host-emitted; everything
else is stable):

```text
resolved store path: /tmp/bd187-state.sqlite
journal_mode: wal  user_version: 2
tables: capacity, cooldown, cooldown_ladder, lease, spend
-rw------- 1 hugo users  4096 nov  3 14:18 /tmp/bd187-state.sqlite
-rw------- 1 hugo users 32768 nov  3 14:18 /tmp/bd187-state.sqlite-shm
-rw------- 1 hugo users 98912 nov  3 14:18 /tmp/bd187-state.sqlite-wal
rival before any write: {"ok":true,"value":null}
markCooldown: {"ok":true,"value":{"provider":"llmgateway","model":"glm-5.3","untilMs":1793711991332,"reason":"429 rate limited","retryAfterMs":60000}}
rival immediately (its own 1s read cache): {"ok":true,"value":null}
rival after the cache lapses: {"ok":true,"value":{"scope":"model","untilMs":1793711991332,"reason":"429 rate limited","retryAfterMs":60000}}
cooldown rows on disk: [{"provider":"llmgateway","model":"glm-5.3","until_ms":1793711991332,"reason":"429 rate limited","retry_after_ms":60000}]
writer reserveCapacity: {"ok":true,"value":{"granted":true,"leaseId":"daemon-a-lease","provider":"llmgateway","class":"standard","inUse":1,"limit":1,"expiresMs":1793712532435}}
rival reserveCapacity: {"ok":true,"value":{"granted":false,"reason":"capacity-exhausted","provider":"llmgateway","class":"standard","inUse":1,"limit":1}}
rival releases the writer's lease: {"ok":false,"reason":"lease-not-owned","error":"lease daemon-a-lease is owned by another daemon"}
writer release: {"ok":true,"value":{"released":true,"inUse":0}}
rival reserveCapacity after the release: {"ok":true,"value":{"granted":true,"leaseId":"daemon-b-lease","provider":"llmgateway","class":"standard","inUse":1,"limit":1,"expiresMs":1793712532436}}
capacity snapshot: {"ok":true,"value":{"provider":"llmgateway","class":"standard","limit":1,"inUse":1}}
spendTotals: {"ok":true,"value":{"rows":4,"input":4000,"output":1000,"cacheRead":160,"cacheWrite":40,"cost":0.5}}
policy constants: {"RECOMMENDED_RETRY_MAX_RETRIES":1,"MAX_ATTEMPTS_PER_DISPATCH":2,"TRANSIENT_RETRY_BUDGET":1,"DEFAULT_CAPACITY_LIMIT":8,"LEASE_TTL_FLOOR_MS":10000,"LEASE_RENEWAL_INTERVAL_FLOOR_MS":1000,"LEASE_TTL_DEFAULT_MS":600000}
file mode after close: 600 (octal), sidecars left behind: 0
```

Read those lines as the whole contract:

- **One window, one store.** The rival saw `null`, then `null` again inside the
  1 000 ms read cache, then the writer's exact `until_ms` after the cache lapsed
  — and a third connection (the raw `node:sqlite` reader) sees the same row.
  Since bd-256 this is also the row the routing layer reads and writes, so there
  is no second cooldown file whose lapsed cache could disagree with it.
- **A lease is exclusive and owned.** The rival's reservation is
  `capacity-exhausted` (not an error), its attempt to free the writer's lease is
  `lease-not-owned`, and after the owner's release the same bucket grants the
  rival. The lease id alone does not buy a release.
- **Spend is exact.** 4 rows × `{1000, 250, 40, 10}` = `input 4000`, `output
  1000`, `cacheRead 160`, `cacheWrite 40`; 4 × `0.125` = `cost 0.5`. No
  tolerance.
- **Modes.** The `.sqlite` and both sidecars are `0600` while open; a clean close
  checkpoints and removes the sidecars.

The directory the store creates is `0700` (the file sits inside it):

```bash
rm -rf /tmp/bd187-dirprobe
node --input-type=module -e '
const { openModelStateStore } = await import(`${process.cwd()}/dist/src/model-state-store.js`);
const opened = openModelStateStore({ path: "/tmp/bd187-dirprobe/belayd/model-state.sqlite" });
if (!opened.ok) throw new Error(opened.error);
opened.store.markCooldown({ provider: "llmgateway", durationMs: 1000, reason: "dir probe" });
opened.store.close();
console.log("store created");
'
ls -ld /tmp/bd187-dirprobe /tmp/bd187-dirprobe/belayd
ls -l /tmp/bd187-dirprobe/belayd
```

```text
store created
drwx------ 3 hugo users 4096 nov  3 14:18 /tmp/bd187-dirprobe
drwx------ 2 hugo users 4096 nov  3 14:18 /tmp/bd187-dirprobe/belayd
total 56
-rw------- 1 hugo users 57344 nov  3 14:18 model-state.sqlite
```

Cleanup:

```bash
rm -f /tmp/bd187-state.sqlite*
rm -rf /tmp/bd187-dirprobe /tmp/bd187-absent
rm -f /tmp/bd187-recipe.mjs
```

### 5. The wrapper: id, idempotency, capacity refusal, classification

```bash
cat > /tmp/bd187-wrapper.mjs <<'EOF'
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = `${process.cwd()}/dist`;
const { openModelStateStore } = await import(`${dist}/src/model-state-store.js`);
const { createProviderPolicy, resolveCapacityLimit, DEFAULT_CAPACITY_LIMIT } = await import(`${dist}/src/provider-policy.js`);
const { wrapProvider, isPolicyWrapped, installProviderPolicy } = await import(`${dist}/src/provider-wrapper.js`);
const { classifyAssistantMessage, classifySpawnFailure, isFallbackWorthy } = await import(`${dist}/src/quota-failure.js`);

// 1. a real wrapped dispatch: id kept, members forwarded, capacity refusal typed
const dir = mkdtempSync(join(tmpdir(), "bd187-wrapper-"));
const opened = openModelStateStore({ path: join(dir, "model-state.sqlite") });
if (!opened.ok) throw new Error(opened.error);
const store = opened.store;
const policy = createProviderPolicy({ store: () => store, capacity: { limit: 1 } });
let release;
const gate = new Promise((resolve) => { release = resolve; });
const real = {
  id: "llmgateway",
  baseUrl: "https://example.invalid",
  stream: () => ({ result: () => gate.then(() => ({ role: "assistant", stopReason: "end", usage: { input: 10, output: 2, cost: 0.001 } })) }),
  streamSimple: () => { throw new Error("unused"); },
};
const wrapped = wrapProvider(real, policy, { phase: "implement", taskId: "bd-187" });
console.log(`id kept: ${wrapped.id === real.id} (${wrapped.id}); baseUrl forwarded by reference: ${wrapped.baseUrl === real.baseUrl}; stream overridden: ${wrapped.stream !== real.stream}`);
console.log(`wrapProvider(wrapped) is the same object: ${wrapProvider(wrapped, policy) === wrapped} (isPolicyWrapped: ${isPolicyWrapped(wrapped)})`);
const held = wrapped.stream({ id: "glm-5.3" }, {});
try {
  wrapped.stream({ id: "glm-5.3" }, {});
} catch (error) {
  console.log(`second concurrent dispatch: ${error.name}: ${error.message}`);
  const classified = classifyAssistantMessage({ role: "assistant", stopReason: "error", errorMessage: error.message });
  console.log(`assistant-path classification: ${JSON.stringify(classified)} fallback-worthy: ${isFallbackWorthy(classified.kind)}`);
  console.log(`spawn-path classification: ${JSON.stringify(classifySpawnFailure({ messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 }, stderr: error.message, exitCode: 1 }))}`);
}
release();
await held.result();
await new Promise((resolve) => setTimeout(resolve, 20));
const settled = store.readCapacity({ provider: "llmgateway", class: "frontier" });
console.log(`after the held stream settled: spend ${JSON.stringify(store.spendTotals())}, leases in use ${settled.ok ? settled.value.inUse : "error"}`);
store.close();
rmSync(dir, { recursive: true, force: true });

// 2. capacity knobs
console.log(`resolveCapacityLimit({}) = ${resolveCapacityLimit({})} (default ${DEFAULT_CAPACITY_LIMIT}); =2 -> ${resolveCapacityLimit({ BELAYD_MODEL_CAPACITY_LIMIT: "2" })}; =0 -> ${resolveCapacityLimit({ BELAYD_MODEL_CAPACITY_LIMIT: "0" })}`);
console.log(`limit 0: ${JSON.stringify(createProviderPolicy({ store: () => null, capacity: { limit: 0 } }).acquireLease({ provider: "llmgateway", model: "glm-5.3" }))}, renewal interval ${createProviderPolicy({ store: () => null, capacity: { limit: 0 } }).leaseRenewalIntervalInMs()}ms`);
console.log(`limit 1, default TTL: renewal interval ${createProviderPolicy({ store: () => null, capacity: { limit: 1 } }).leaseRenewalIntervalInMs()}ms; with a 300ms TTL ${createProviderPolicy({ store: () => null, capacity: { limit: 1, leaseTtlMs: 300 } }).leaseRenewalIntervalInMs()}ms`);

// 3. pi-durable entry point over a Models-shaped object
const makeProvider = (id) => ({ id, stream: () => ({ result: async () => ({}) }), streamSimple: () => ({ result: async () => ({}) }) });
const catalog = [makeProvider("llmgateway"), makeProvider("opencode-go"), makeProvider("commandcode")];
const models = {
  getProviders: () => catalog.map((provider) => provider),
  setProvider: (next) => { const index = catalog.findIndex((provider) => provider.id === next.id); catalog[index] = next; },
};
const policyFor = () => createProviderPolicy({ store: () => null, capacity: { limit: 0 } });
console.log(`installProviderPolicy #1: ${JSON.stringify(installProviderPolicy(models, { policyFor, directProviderId: "llmgateway" }))}`);
console.log(`installProviderPolicy #2: ${JSON.stringify(installProviderPolicy(models, { policyFor, directProviderId: "llmgateway" }))}`);
console.log(`installProviderPolicy enabled:false: ${JSON.stringify(installProviderPolicy(models, { policyFor, directProviderId: "llmgateway", enabled: false }))}`);
console.log(`ids unchanged: ${JSON.stringify(catalog.map((provider) => provider.id))}`);
EOF
node /tmp/bd187-wrapper.mjs
```

```text
id kept: true (llmgateway); baseUrl forwarded by reference: true; stream overridden: true
wrapProvider(wrapped) is the same object: true (isPolicyWrapped: true)
second concurrent dispatch: ProviderPolicyRefusalError: belayd-capacity-refused: model dispatch refused (capacity): capacity in use (1/1) on llmgateway/frontier
assistant-path classification: {"kind":"capacity","reason":"Local provider capacity limit refused the dispatch."} fallback-worthy: true
spawn-path classification: {"kind":"capacity","reason":"Local provider capacity limit refused the dispatch."}
after the held stream settled: spend {"ok":true,"value":{"rows":1,"input":10,"output":2,"cacheRead":0,"cacheWrite":0,"cost":0.001}}, leases in use 0
resolveCapacityLimit({}) = 8 (default 8); =2 -> 2; =0 -> 0
limit 0: {"allowed":true,"lease":null}, renewal interval 0ms
limit 1, default TTL: renewal interval 200000ms; with a 300ms TTL 3333ms
installProviderPolicy #1: {"wrapped":["opencode-go","commandcode"],"direct":["llmgateway"],"failed":[]}
installProviderPolicy #2: {"wrapped":["opencode-go","commandcode"],"direct":["llmgateway"],"failed":[]}
installProviderPolicy enabled:false: {"wrapped":[],"direct":["llmgateway","opencode-go","commandcode"],"failed":[]}
ids unchanged: ["llmgateway","opencode-go","commandcode"]
```

Note the class in the refusal: `glm-5.3` resolves to the `frontier` bucket, not
`standard` — capacity is keyed by **model class**, so pick the bucket you mean
when you inspect `capacity` rows by hand. Note also that the mandatory one
direct provider is excluded from both `wrapped` and the warnings.

### 6. Degradation: read-only and unopenable stores

```bash
cat > /tmp/bd187-degrade.mjs <<'EOF'
const dist = `${process.cwd()}/dist`;
const { openModelStateStore } = await import(`${dist}/src/model-state-store.js`);
const { createProviderPolicy } = await import(`${dist}/src/provider-policy.js`);
const { wrapProvider } = await import(`${dist}/src/provider-wrapper.js`);

const path = process.env.BELAYD_MODEL_STATE_FILE;
const writable = openModelStateStore({ path });
if (!writable.ok) throw new Error(writable.error);
writable.store.markCooldown({ provider: "llmgateway", model: "glm-5.3", durationMs: 60_000, reason: "429", hinted: true });
writable.store.close();

const readOnly = openModelStateStore({ path, readOnly: true });
if (!readOnly.ok) throw new Error(readOnly.error);
const ro = readOnly.store;
console.log(`read-only open: readOnly flag ${ro.readOnly}`);
console.log(`read still serves: ${JSON.stringify(ro.cooldownFor({ provider: "llmgateway", model: "glm-5.3" }))}`);
console.log(`write is a value: ${JSON.stringify(ro.markCooldown({ provider: "llmgateway", model: "glm-5.3", durationMs: 1000, reason: "x" }))}`);
console.log(`lease is a value: ${JSON.stringify(ro.reserveCapacity({ provider: "llmgateway", class: "frontier", limit: 1, leaseId: "ro-lease" }))}`);

let calls = 0;
const real = {
  id: "llmgateway",
  stream: () => { calls += 1; return { result: async () => ({ role: "assistant", stopReason: "end", usage: { input: 5, output: 1, cost: 0.01 } }) }; },
  streamSimple: () => { throw new Error("unused"); },
};
// A model id with no cooldown row: the point is the store, not the cooldown.
const wrapped = wrapProvider(real, createProviderPolicy({ store: () => ro, capacity: { limit: 1 } }));
const served = await wrapped.stream({ id: "glm-5.3-air" }, {}).result();
console.log(`dispatch over a read-only store: provider calls ${calls}, stopReason ${served.stopReason}, spend rows ${ro.spendTotals().ok ? ro.spendTotals().value.rows : "error"}`);
ro.close();

const missing = openModelStateStore({ path: "/tmp/bd187-absent/model-state.sqlite", readOnly: true });
console.log(`unopenable store: ${JSON.stringify(missing)}`);
const wrappedNull = wrapProvider(real, createProviderPolicy({ store: () => null, capacity: { limit: 1 } }));
calls = 0;
const servedNull = await wrappedNull.stream({ id: "glm-5.3-air" }, {}).result();
console.log(`dispatch with no store at all: provider calls ${calls}, stopReason ${servedNull.stopReason}`);
EOF
rm -f /tmp/bd187-degrade.sqlite*
BELAYD_MODEL_STATE_FILE=/tmp/bd187-degrade.sqlite node /tmp/bd187-degrade.mjs
```

```text
read-only open: readOnly flag true
read still serves: {"ok":true,"value":{"scope":"model","untilMs":1793712057931,"reason":"429","retryAfterMs":60000}}
write is a value: {"ok":false,"error":"model state store is read-only (markCooldown)"}
lease is a value: {"ok":false,"error":"model state store is read-only (reserveCapacity)"}
dispatch over a read-only store: provider calls 1, stopReason end, spend rows 0
unopenable store: {"ok":false,"error":"model state store /tmp/bd187-absent/model-state.sqlite does not exist"}
dispatch with no store at all: provider calls 1, stopReason end
```

The two acceptance-shaped facts: a read-only store **reads** and refuses every
**write** as a value, and the real provider is called exactly once either way —
a bookkeeping failure never becomes a provider error. A read-only open of a
missing file is reported as unopenable instead of creating a database behind the
owner.

### 7. Retry accounting (both layers, measured)

```bash
cat > /tmp/bd187-retry.mjs <<'EOF'
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = `${process.cwd()}/dist`;
const { openModelStateStore } = await import(`${dist}/src/model-state-store.js`);
const { createProviderPolicy, MAX_ATTEMPTS_PER_DISPATCH, TRANSIENT_RETRY_BUDGET } = await import(`${dist}/src/provider-policy.js`);
const { wrapProvider } = await import(`${dist}/src/provider-wrapper.js`);

const dir = mkdtempSync(join(tmpdir(), "bd187-retry-"));
const opened = openModelStateStore({ path: join(dir, "model-state.sqlite") });
if (!opened.ok) throw new Error(opened.error);
const store = opened.store;
const policy = createProviderPolicy({ store: () => store, capacity: { limit: 8 } });

function countingProvider(id, streamBody) {
  let calls = 0;
  return {
    calls: () => calls,
    provider: { id, stream: (...args) => { calls += 1; return streamBody(...args); }, streamSimple: () => { throw new Error("unused"); } },
  };
}

// 1. quota throw: one upstream call, then the cooldown refuses the retries.
const quota = countingProvider("quota-provider", () => { throw new Error("429 Too Many Requests: quota exceeded for this key"); });
const quotaWrapped = wrapProvider(quota.provider, policy);
const outcomes = [];
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try { quotaWrapped.stream({ id: "glm-5.3" }, {}); outcomes.push("served"); } catch (error) { outcomes.push(`${error.name}: ${error.message}`); }
}
console.log(`quota: 3 caller attempts -> ${quota.calls()} provider call(s)`);
outcomes.forEach((outcome, index) => console.log(`  attempt ${index + 1}: ${outcome}`));
console.log(`  cooldown row: ${JSON.stringify(store.cooldownFor({ provider: "quota-provider", model: "glm-5.3" }))}`);

// 2. transient throw with a working store: the retry is denied by the cooldown.
const transient = countingProvider("transient-provider", () => { throw new Error("ECONNRESET network down"); });
const transientWrapped = wrapProvider(transient.provider, policy);
try { transientWrapped.stream({ id: "glm-5.4" }, {}); } catch (error) { console.log(`transient with a store: ${error.message}`); }
console.log(`transient with a store: provider calls ${transient.calls()}`);

// 3. transient throw with no store to record it: the budget is the only cap.
const noStore = createProviderPolicy({ store: () => null });
const unbounded = countingProvider("transient-no-store", () => { throw new Error("ECONNRESET network down"); });
const unboundedWrapped = wrapProvider(unbounded.provider, noStore);
try { unboundedWrapped.stream({ id: "glm-5.5" }, {}); } catch (error) { console.log(`transient without a store: ${error.message}`); }
console.log(`transient without a store: provider calls ${unbounded.calls()} (MAX_ATTEMPTS_PER_DISPATCH=${MAX_ATTEMPTS_PER_DISPATCH}, TRANSIENT_RETRY_BUDGET=${TRANSIENT_RETRY_BUDGET})`);

// 4. an unclassifiable throw is never retried.
const boom = countingProvider("boom-provider", () => { throw new Error("boom"); });
try { wrapProvider(boom.provider, noStore).stream({ id: "glm-5.6" }, {}); } catch (error) { console.log(`unclassifiable throw: ${error.message}, provider calls ${boom.calls()}`); }

store.close();
rmSync(dir, { recursive: true, force: true });
EOF
node /tmp/bd187-retry.mjs
```

```text
quota: 3 caller attempts -> 1 provider call(s)
  attempt 1: Error: 429 Too Many Requests: quota exceeded for this key
  attempt 2: ProviderPolicyRefusalError: model dispatch refused (provider): Quota/credit/rate limit (HTTP 429).
  attempt 3: ProviderPolicyRefusalError: model dispatch refused (provider): Quota/credit/rate limit (HTTP 429).
  cooldown row: {"ok":true,"value":{"scope":"provider","untilMs":1793712901922,"reason":"Quota/credit/rate limit (HTTP 429).","retryAfterMs":900000}}
transient with a store: ECONNRESET network down
transient with a store: provider calls 1
transient without a store: ECONNRESET network down
transient without a store: provider calls 2 (MAX_ATTEMPTS_PER_DISPATCH=2, TRANSIENT_RETRY_BUDGET=1)
unclassifiable throw: boom, provider calls 1
```

State that plainly, because it is the part people get wrong:

- A quota-class failure gets **no** wrapper retry. The first attempt reaches the
  provider, the failure is classified and a provider-scoped cooldown row is
  written, and every later caller attempt is refused **locally** — so the
  provider is called *once*, not once per caller attempt.
- A transient synchronous throw is where the "at most one extra attempt" budget
  lives (`TRANSIENT_RETRY_BUDGET = 1`, `MAX_ATTEMPTS_PER_DISPATCH = 2`). With a
  **working** store the first throw also writes a 5-minute transient cooldown, so
  the retry is denied and the provider is still called once. The second call only
  happens when nothing can record the failure (no store, read-only store): 2
  calls, then the original error surfaces.
- An unclassifiable throw (`boom`) is recorded but never retried.

### 8. The env knobs, as the extension reads them

Sub-floor lease TTL → one warning, then the floor:

```bash
BELAYD_MODEL_LEASE_TTL_MS=500 node --input-type=module -e '
const model = await import(`${process.cwd()}/dist/extensions/capabilities/model.js`);
console.log(`renewal interval: ${model.modelStatePolicy().leaseRenewalIntervalInMs()}ms`);
console.log(`renewal interval from a second policy: ${model.modelStatePolicy().leaseRenewalIntervalInMs()}ms`);
'
```

```text
[belayd-harness] BELAYD_MODEL_LEASE_TTL_MS=500ms is below the 10000ms floor; using 10000ms so the lease heartbeat cannot become a renewal storm.
renewal interval: 3333ms
renewal interval from a second policy: 3333ms
```

One warning for the process, not one per wrapped provider, and the TTL is clamped
to 10 s (renewal cadence 10 000/3 = 3 333 ms).

Which provider stays direct, which are wrapped, and what the kill switch does:

```bash
cat > /tmp/bd187-register.mjs <<'EOF'
const model = await import(`${process.cwd()}/dist/extensions/capabilities/model.js`);

const provider = (id) => ({ id, stream: () => ({ result: async () => ({}) }), streamSimple: () => ({ result: async () => ({}) }) });
const providers = new Map([
  ["llmgateway", provider("llmgateway")],
  ["opencode-go", provider("opencode-go")],
  // A registered provider whose object has no id: reported, never wrapped.
  ["idless-provider", { stream: () => ({ result: async () => ({}) }), streamSimple: () => ({ result: async () => ({}) }) }],
]);
const registered = [];
const pi = { registerProvider: (next) => registered.push(next.id) };
const registry = {
  getAll: () => [...providers.keys()].map((name) => ({ provider: name })),
  getProvider: (id) => providers.get(id),
};
model.beginProviderRegistrationSession();
console.log(`report: ${JSON.stringify(model.registerModelProviderWrappers(pi, registry))}`);
console.log(`registered: ${JSON.stringify(registered)}`);
EOF
node /tmp/bd187-register.mjs
BELAYD_MODEL_STATE_DIRECT_PROVIDER=opencode-go node /tmp/bd187-register.mjs
BELAYD_MODEL_STATE_WRAPPER=0 node /tmp/bd187-register.mjs
node --input-type=module -e '
const model = await import(`${process.cwd()}/dist/extensions/capabilities/model.js`);
model.beginProviderRegistrationSession();
model.warnProviderRegistrationFailure(new Error("registry enumeration exploded"));
model.warnProviderRegistrationFailure(new Error("second failure in the same session"));
'
```

```text
[belayd-harness] model-state policy bypassed for: idless-provider (missing provider id)
report: {"wrapped":["opencode-go"],"direct":["llmgateway"],"bypassed":[{"id":"idless-provider","reason":"missing provider id"}],"deferred":[]}
registered: ["opencode-go"]
[belayd-harness] model-state policy bypassed for: idless-provider (missing provider id)
report: {"wrapped":["llmgateway"],"direct":["opencode-go"],"bypassed":[{"id":"idless-provider","reason":"missing provider id"}],"deferred":[]}
registered: ["llmgateway"]
report: {"wrapped":[],"direct":[],"bypassed":[],"deferred":[]}
registered: []
[belayd-harness] model-state provider registration failed (registry enumeration exploded); 1 failure(s) this session, providers stay direct; further failures are suppressed until the next session_start.
```

The rows are, in order: defaults; then `BELAYD_MODEL_STATE_DIRECT_PROVIDER=opencode-go`
(the direct slot moved and `llmgateway` is now wrapped); then
`BELAYD_MODEL_STATE_WRAPPER=0` (the kill switch: nothing is registered at all, so
every provider stays as pi already had it — direct); then the per-session failure
warning, where the second call in the same session prints nothing.

### 9. Mutation evidence for the renewal heartbeat

A green suite alone cannot distinguish "the lease is renewed" from "the lease
never expires in the window we looked at", so the test phase mutated the fixture
and re-ran:

- `test/fixtures/model-state-process.mjs` `hold-lease` — with the heartbeat body
  disabled, `a live child keeps its lease renewed past the original TTL across
  connections` **failed** with
  `timed out waiting for progress.json to satisfy its predicate` (exit 1): the
  child never reached 8 renewals.
- The fixture was restored (byte-identical, `diff` clean) and the file went green
  again, 4/4, in ~2 s.

Verified in this worktree right now: that test issues the heartbeat via
`setInterval` in the fixture and asserts `renewals >= 8` **and**
`Date.now() - started_ms > leaseTtlMs` (= 1 500 ms) before the parent's own
connection is refused. Remove the heartbeat and the lease expires at 1.5 s, the
parent is granted, and the refused assertion fails — that is why the test is the
proof, not just a passing line.

### 10. What to look for in the logs

All three lines were produced above, verbatim:

| Line | When | What it means |
|---|---|---|
| `[belayd-harness] BELAYD_MODEL_LEASE_TTL_MS=500ms is below the 10000ms floor; using 10000ms so the lease heartbeat cannot become a renewal storm.` | once per process, first time a policy resolves the TTL | your configured TTL was refused. The floor is `LEASE_TTL_FLOOR_MS`, the renewal cadence is `max(1 s, ttl/3)`. Fix the env var; nothing else is wrong. |
| `[belayd-harness] model-state provider registration failed (registry enumeration exploded); 1 failure(s) this session, providers stay direct; further failures are suppressed until the next session_start.` | at most once per session, first failure | the wrapper could not be installed; every provider stays **direct** (unwrapped), so dispatch still works with no shared cooldown/capacity/spend. The count is a running total for the session; the window resets on the next `session_start`. |
| `[belayd-harness] model-state policy bypassed for: idless-provider (missing provider id)` | once, when something cannot be wrapped | names every provider outside the policy with its reason: `provider object unavailable`, `provider still unavailable (lazy catalog)`, `missing provider id`, `provider id mismatch (…)` or `registration failed: …`. The intentionally-direct provider is **never** listed. |

Two more bd-187 warnings, both reproduced here:

```bash
# the store file cannot be opened at all (here: the path is a directory)
BELAYD_MODEL_STATE_FILE=/tmp node --input-type=module -e '
const model = await import(`${process.cwd()}/dist/extensions/capabilities/model.js`);
console.log(`store: ${model.sharedModelStateStoreInstance()}`);
console.log(`decision: ${JSON.stringify(model.modelStatePolicy().decideDispatch({ provider: "llmgateway", model: "glm-5.3" }))}`);
'
```

```text
[belayd-harness] shared model state store unavailable (could not open /tmp: unable to open database file); provider policy is permissive.
store: null
decision: {"allowed":true,"degraded":true}
```

That is the degradation in one screen: no store, still `allowed`, marked
`degraded`.

```bash
# a dispatch whose model object carries no id
node --input-type=module -e '
const { createProviderPolicy } = await import(`${process.cwd()}/dist/src/provider-policy.js`);
const { wrapProvider } = await import(`${process.cwd()}/dist/src/provider-wrapper.js`);
const provider = { id: "llmgateway", stream: () => ({ result: async () => ({ role: "assistant", stopReason: "end", usage: { input: 1, output: 1, cost: 0 } }) }), streamSimple: () => { throw new Error("unused"); } };
const wrapped = wrapProvider(provider, createProviderPolicy({ store: () => null }));
await wrapped.stream({}, {}).result();
await wrapped.stream({}, {}).result();
console.log("two id-less dispatches done (warned once)");
'
```

```text
[belayd-harness] provider llmgateway dispatched a model without an id; skipping cooldown/spend writes for it.
two id-less dispatches done (warned once)
```

Once per wrapped provider, and nothing is written under a synthetic key: a
bucket the real model never clears would keep it healthy on the next dispatch.

### 11. A pre-existing, unrelated observation

The unit suite appends to the operator's **real**
`~/.local/state/belayd/aws-audit.jsonl` from the AWS-sandbox tests in
`src/__tests__/spawn.test.ts`. Measured here: 834 lines before `pnpm test` + `pnpm test:integration`, 835 after, and running only
`pnpm vitest run src/__tests__/spawn.test.ts` appended one more:

```text
audit lines: 835 -> 836
{"ts":"2026-11-03T13:17:18.939Z","scope":"","worktree":"/tmp/belayd-spawn-aws-jBHgQM/repo","profile":"","action":"ensure-scope","outcome":"error:not-configured"}
```

This is **pre-existing and not caused by bd-187** — `spawn.ts` and
`spawn.test.ts` are untouched by this bead. bd-187 itself leaves no trace in the
real state directory: after both full suites, `~/.local/state/belayd/` contains
`aws-audit.jsonl`, `metrics/` and `proof/` and **no** `model-state.sqlite` or
`-wal`/`-shm`, because the production store opens lazily on the first dispatch
and no test dispatches through it.

---

## How to Use

### Mental model

1. **One file is the truth.** Cooldown, capacity leases and spend live in
   `model-state.sqlite`; every daemon on the host reads and writes the same rows.
2. **The wrapper is the only enforcement point.** It spreads the real provider,
   overrides `stream`/`streamSimple`, and decides before the call (cooldown, then
   a capacity lease) and after the stream settles (release, then cooldown/spend).
3. **Nothing here can fail a turn.** Every store error is a value, a failed read
   is permissive, and a failed write is logged or ignored — never thrown.

```
                 ┌──────────────── model-state.sqlite (WAL, 0600) ───────────────┐
   dispatch ──▶  │ cooldown   capacity   lease   spend   cooldown_ladder        │
                 └──────────────────────────────────────────────────────────────┘
      ▲ write/read                                   ▲
  wrapped provider (stream/streamSimple)      other daemons' wrapped providers
      │
      └─ one provider stays DIRECT (unwrapped) as the fail-safe
```

### The store file

| Knob | Effect |
|---|---|
| (none) | `$XDG_STATE_HOME/belayd/model-state.sqlite`, else `~/.local/state/belayd/model-state.sqlite` |
| `BELAYD_MODEL_STATE_FILE` | absolute path override (same precedent as `BELAYD_MODEL_COOLDOWN_FILE`) |

The override is what the recipe above used, and it is the safest way to
experiment: it keeps `/tmp` state out of the operator's real budget.

```bash
BELAYD_MODEL_STATE_FILE=/tmp/bd187-state.sqlite node /tmp/bd187-recipe.mjs
```

Store shape: `journal_mode = WAL`, `PRAGMA user_version = 2`, directory `0700`,
and the `.sqlite` plus its `-wal`/`-shm` sidecars `0600` — re-tightened after
**every** write, including lease renewals and releases. Reads are cached per
store instance for 1 000 ms (`MODEL_STATE_READ_CACHE_MAX_AGE_MS`); every write
invalidates the cache, so another process's cooldown is visible within a second
at worst. That second is why the recipe's rival sees `null` on the second read
and the row on the third.

Tables, in the shapes you will query:

```text
cooldown(provider, model, until_ms, reason, retry_after_ms, cause, escalations, last_mark_ms)
                                                              model = '*' means provider-wide
                                                              provider = '*' means a bare model id
cooldown_ladder(provider, escalations, last_mark_ms)          unhinted escalation ladder
capacity(provider, class, limit, in_use)
lease(lease_id, provider, class, daemon_pid, host, expires_ms)
spend(ts, provider, model, phase, task_id, input, output, cache_read, cache_write, cost)
```

The `cooldown_ladder` table is the escalation authority (an unhinted provider-wide
mark doubles per rung up to the 24 h ceiling; a hinted mark replaces the window
exactly and clears the ladder). `cooldown.escalations` mirrors the rung that
produced the row (`NULL` on hinted and model rows) and `cooldown.cause`
(`quota` | `unconfigured`) is what the capacity probe and the fallback skip rows
read instead of matching display text. Those three columns arrived in bd-256
(schema v2); a v1 file is migrated in place on open.

### Capacity: `BELAYD_MODEL_CAPACITY_LIMIT`

One scalar limit per `(provider, class)` bucket, **default 8**. Every wrapped
dispatch reserves a lease for the duration of its stream and releases it when the
stream settles (success, terminal error, or rejected stream), so `in_use` is live
cross-process concurrency.

```bash
# 4 concurrent children against one provider+class bucket
BELAYD_MODEL_CAPACITY_LIMIT=4 pi ...
# capacity off entirely: no leases, no refusals, no renewal timer
BELAYD_MODEL_CAPACITY_LIMIT=0 pi ...
```

- **Fan-out interaction.** In a fleet, every spawned child process holds its own
  lease against the same bucket. A fan-out wider than the limit means the
  (limit+1)th child is refused rather than all of them running at once — and
  because the refusal classifies as `capacity`, it moves to the next candidate
  instead of failing the phase (see below). Size the limit for the widest fan-out
  you actually run, or the run will spend its fallbacks early.
- **`0` disables capacity entirely.** `acquireLease` returns
  `{allowed: true, lease: null}`, `leaseRenewalIntervalInMs()` returns `0`, and no
  timer is created. Verified: `limit 0: {"allowed":true,"lease":null}, renewal interval 0ms`.
- A refusal carries the bucket and a wait hint
  (`scope: "capacity"`, `capacity: { provider, class, inUse, limit, waitHintMs }`),
  and the real provider is never called.

### Lease TTL: `BELAYD_MODEL_LEASE_TTL_MS`

The TTL is a **renewal** TTL, not a stream-length limit: a live stream renews at
`max(1 s, ttl/3)`, so the TTL only bounds how long a killed daemon's slot stays
held.

| Value | Result |
|---|---|
| unset | 600 000 ms (10 min), renewal every 200 000 ms |
| `30000` | renewal every 10 000 ms |
| `500` | clamped to `LEASE_TTL_FLOOR_MS` = 10 000 ms, one warning, renewal every 3 333 ms |
| `0`, negative, unparseable | falls back to 600 000 ms |
| `abc` | falls back to 600 000 ms |

The floor exists because the renewal is a `BEGIN IMMEDIATE` write: a tiny TTL
turns every live stream into a renewal storm contending with the cooldown/spend
writers under the store's 5 s busy timeout. It is refused with one warning naming
the env var and the floor used, not accepted silently.

A lease is **never resurrected** after it expires (its slot may already be
someone else's); a renewal that fails simply keeps failing until the stream
settles, and the slot frees by wall clock. Leases are not pid-checked: a SIGKILLed
daemon's slot frees at `expires_ms`, which is the only release path that survives
a SIGKILL.

### The one direct provider: `BELAYD_MODEL_STATE_DIRECT_PROVIDER`

At least one provider stays registered **unwrapped**, so a broken wrapper or an
unreadable store is never the only path to a model. The default is `llmgateway`
(the harness's per-token primary).

```bash
BELAYD_MODEL_STATE_DIRECT_PROVIDER=opencode-go pi ...   # move the fail-safe slot
```

Behaviour details worth knowing:

- If the named id is not registered, `providers[0]` takes the direct slot instead
  (`direct` in the report tells you which one it was).
- The direct provider is excluded from the bypass warning; everything else that
  could not be wrapped is named there.
- The wrapper never renames a provider: `wrapped.id === real.id`. pi
  `model_change` conversation entries and pi-durable `pi.agent` documents store
  provider ids, so a rename would orphan stored conversations.

### Kill switch: `BELAYD_MODEL_STATE_WRAPPER=0`

```bash
BELAYD_MODEL_STATE_WRAPPER=0 pi ...
```

`report: {"wrapped":[],"direct":[],"bypassed":[],"deferred":[]}` and nothing is
registered: every provider stays exactly as pi had it. Use it to prove a
suspected wrapper problem, or during an incident where the shared store itself is
suspect.

### Registration lifecycle (what to expect, not what to configure)

- Wrapping happens on `session_start` via `pi.registerProvider`; the store is
  opened **lazily on the first dispatch decision**, so starting a session creates
  no file.
- A provider whose object has not materialised yet (a lazy/dynamic catalog) is
  deferred on first sighting, then reported once, then remembered — it is not
  re-warned every second session. It is also re-checked on every turn start
  (`reconcileDeferredProviders`), so it is wrapped as soon as its object appears.
  Known limit: a provider that materialises *after* that observation stays direct
  until the next one, because pi emits no notification when a provider object
  appears.
- Registration is idempotent: `wrapProvider` recognises its own wrapper (a
  non-enumerable symbol marker checked on the input object), so repeated
  `session_start` cannot double-wrap and double-count a stream.
- `installProviderPolicy(models, { policyFor, directProviderId, enabled })` is the
  same path for pi-durable, driven through `models.getProviders()` /
  `models.setProvider`.

### Degradation: what happens when the store is unavailable

| Situation | Read | Write | Dispatch |
|---|---|---|---|
| normal | served | committed in `BEGIN IMMEDIATE` | cooldown + lease enforced |
| `readOnly: true` store | served | `{ ok: false, error: "model state store is read-only (…)" }` | allowed, **no lease**, provider called |
| unopenable store (missing path on a read-only open, no `node:sqlite`, corrupt file) | `{ ok: false }` → treated as "no cooldown, no capacity" | n/a | allowed, provider called |
| store null / factory returns `null` | n/a | n/a | allowed, provider called |
| lease write fails mid-dispatch | n/a | reported as a value | dispatch continues without a lease |
| release or renewal fails | n/a | ignored | cleanup only; never surfaced as a provider error |

The rule to remember: **a failed state write never fails a dispatch.** The reverse
also holds — a *decision* (cooldown active, capacity full) does refuse, because
that is a routing answer, not a bookkeeping failure.

### What a `capacity` refusal means, and why it falls over

A capacity refusal is thrown as `ProviderPolicyRefusalError` whose message starts
with the stable marker `belayd-capacity-refused`. That marker is classified first,
ahead of every status/wording rule, on **both** paths:

```text
second concurrent dispatch: ProviderPolicyRefusalError: belayd-capacity-refused: model dispatch refused (capacity): capacity in use (1/1) on llmgateway/frontier
assistant-path classification: {"kind":"capacity", …} fallback-worthy: true
spawn-path classification: {"kind":"capacity", …}
```

(The `…` above is only this guide abbreviating the shared
`"reason":"Local provider capacity limit refused the dispatch."` — the script in
step 5 printed both objects in full.)

Consequences you can rely on:

- `isFallbackWorthy("capacity") === true`, so the spawn loop moves to the next
  candidate instead of dying as `other`.
- **No cooldown row** and no capacity window: nothing upstream was spent, so
  punishing the provider would be wrong.
- Telemetry does **not** count it as a `quotaFailure`.
- The process path sees it too: a child that writes the marker to stderr and
  exits non-zero is classified `capacity`, and the marker beats 429 wording.

### Retry: two layers, only one of them ours

**Layer 1 — the wrapper.** No retry for a quota-class failure; at most
`TRANSIENT_RETRY_BUDGET = 1` extra attempt for a transient synchronous dispatch
throw, capped at `MAX_ATTEMPTS_PER_DISPATCH = 2` per caller attempt. Measured
above: 1 provider call for a 429 across 3 caller attempts, 1 for a transient
throw when the store records it, 2 for a transient throw when nothing can.

**Layer 2 — pi's own retry.** `settings.retry.maxRetries` defaults to **3** and
multiplies whatever the caller does. It is a second, **unenforced** layer: this
repo does not write `~/.pi/agent/settings.json`, so it cannot bound the total.

Set it to the exported recommendation:

```jsonc
// ~/.pi/agent/settings.json
{ "retry": { "maxRetries": 1 } }
```

`RECOMMENDED_RETRY_MAX_RETRIES = 1` is what the wrapper is designed against. With
the default of 3, a 429 becomes a 429 storm even though the wrapper refused the
first retry.

### Inspecting the store

Read-only, no daemon interaction, no risk:

```bash
node --input-type=module -e '
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name").all("table", "sqlite_%")) {
  console.log(`${row.name}: ${db.prepare(`SELECT COUNT(*) AS n FROM "${row.name}"`).get().n} row(s)`);
}
console.log(`cooldown: ${JSON.stringify(db.prepare("SELECT provider, model, until_ms, reason FROM cooldown").all())}`);
console.log(`spend: ${JSON.stringify(db.prepare("SELECT COUNT(*) AS rows, SUM(input) AS input, SUM(cost) AS cost FROM spend").get())}`);
db.close();
' /tmp/bd187-state.sqlite
```

```text
capacity: 1 row(s)
cooldown: 1 row(s)
cooldown_ladder: 0 row(s)
lease: 0 row(s)
spend: 4 row(s)
cooldown: [{"provider":"llmgateway","model":"glm-5.3","until_ms":1793711991332,"reason":"429 rate limited"}]
spend: {"rows":4,"input":4000,"cost":0.5}
```

`until_ms` is epoch milliseconds, so `date -d @$((1793711991332/1000))` (GNU) or
`date -r $((1793711991332/1000))` (BSD) tells you when the window lapses. A
`lease` row that outlives its daemon is normal and self-healing: it disappears
from `in_use` counting at `expires_ms`.

For the same data through the typed API (after `pnpm build`, from the repo root;
this run is over a scratch file holding one cooldown, one live lease and one
spend row):

```bash
node --input-type=module -e '
const { openModelStateStore } = await import(`${process.cwd()}/dist/src/model-state-store.js`);
const opened = openModelStateStore({ path: "/tmp/bd187-state.sqlite", readOnly: true });
if (!opened.ok) throw new Error(opened.error);
const { store } = opened;
console.log(store.cooldownFor({ provider: "llmgateway", model: "glm-5.3" }));
console.log(store.readCapacity({ provider: "llmgateway", class: "standard" }));
console.log(store.spendTotals());
store.close();
'
```

```text
{
  ok: true,
  value: {
    scope: 'model',
    untilMs: 1793712314657,
    reason: '429 rate limited',
    retryAfterMs: 60000
  }
}
{
  ok: true,
  value: { provider: 'llmgateway', class: 'standard', limit: 2, inUse: 1 }
}
{
  ok: true,
  value: {
    rows: 1,
    input: 1000,
    output: 250,
    cacheRead: 40,
    cacheWrite: 10,
    cost: 0.125
  }
}
```

`inUse: 1` is recomputed from the `lease` table at read time, not read from the
`capacity.in_use` counter — that is why a killed daemon's slot stops counting the
moment its `expires_ms` passes.

### Resetting the store safely

Cooldowns and spend are the only durable state, and both are safe to discard:

```bash
# 1. stop every daemon/child that dispatches through the store. A live lease
#    held by a running stream is the one thing deletion can confuse.
pgrep -fa "pi --skill"          # pi sessions; also stop fleet daemons/children
# 2. delete the file AND its sidecars (a stale -wal replays into a new file).
#    Resolve the path instead of hard-coding the default, so an override is
#    honoured: BELAYD_MODEL_STATE_FILE, else BELAYD_MODEL_COOLDOWN_FILE's
#    .sqlite sibling, else the XDG state home.
STATE="$(node --input-type=module -e '
const m = await import(`${process.cwd()}/dist/src/model-state-store.js`);
process.stdout.write(m.resolveModelStatePath({ env: process.env }));')"
ls "$(dirname "$STATE")"
rm -f "$STATE" "$STATE-wal" "$STATE-shm"
# 3. the next dispatch recreates it (dir 0700, file 0600, WAL, user_version 2)
```

On this host there is no store file yet, so step 2 is a no-op and that is what
`rm -f` reporting exit 0 with an unchanged listing looks like:

```text
$ ls ~/.local/state/belayd/
aws-audit.jsonl
metrics
proof
$ STATE="$(node --input-type=module -e 'const m = await import(`${process.cwd()}/dist/src/model-state-store.js`); process.stdout.write(m.resolveModelStatePath({ env: process.env }));')"; rm -f "$STATE" "$STATE-wal" "$STATE-shm"; echo "rm -f exit: $?"
rm -f exit: 0
$ ls ~/.local/state/belayd/
aws-audit.jsonl
metrics
proof
```

`pgrep -fa "pi --skill"` returned this session's own pi process and the shell
running the query; match count 2. Note the pattern: a bare `pgrep -fa "pi"`
matches container helpers (`conmon`, `crun`) on this host too, which is why the
narrower pattern is the one shown.

What you lose: every cooldown window (all providers look healthy again — including
a 24 h escalated one), every spend row (the shared cost/usage history, and any
total you were reading from `spendTotals()`), and any lease row. Nothing else:
the file holds no credentials and no conversation data.

Do **not** delete it while daemons are dispatching: a process holding an open WAL
handle keeps writing to the unlinked inode, so that daemon's cooldowns silently
stop being visible to everyone else. Deleting while nothing is running is the only
supported form.

### The two non-features to plan around

1. **No cross-process in-flight coalescing.** Two processes can both observe free
   capacity and both dispatch; the store bounds and records concurrency, it does
   not deduplicate live requests. If you need "only one request for this prompt
   across the fleet", that is a proxy, and it is out of scope here (bd-188).
2. **Nothing is deleted (the routing layer stays).** `capacity-cache.ts`,
   `model-cooldown.ts`, the `spawn-with-fallback` loop, `model-session-state.ts`
   and telemetry still run beside this layer — and that is deliberate: bd-256
   only moved *cooldown persistence* onto this store. `model-cooldown.ts` is now
   a thin adapter over `ModelStateStore` (bd-256), so routing and the wrapper
   share one truth; the retired JSON file at `~/.pi/agent/model-cooldowns.json`
   (override `BELAYD_MODEL_COOLDOWN_FILE`) is read **once** on first use to
   import still-active windows (marked by a `.imported` file beside it) and is
   never written again. If a window exists only in that JSON file, it is
   pre-migration state: the import will adopt it, but nothing reads it directly
   afterwards. Read `model-state.sqlite` (or `providerEntries()`), not the JSON
   file, to conclude whether a provider is healthy.
