/**
 * Session model pre-flight (bd-257).
 *
 * A plain pi-web session starts on the operator's global default with no
 * routing at all: when that default provider is cooling for quota, the first
 * turn spends a `402` before in-session recovery can switch. These tests drive
 * the single `session_start` handler directly: a cooled default must be routed
 * to the first usable candidate with one explanatory log line, a healthy one
 * must be left alone, and a fully blocked class must be reported instead of
 * starting silently dead.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionModelRouting } from "../../extensions/capabilities/session-model-routing.js";
import { type CapacityCache, createCapacityCache } from "../capacity-cache.js";
import { createModelCooldownStore, type ModelCooldownStore } from "../model-cooldown.js";
import { type ModelStateStore, openModelStateStore } from "../model-state-store.js";

const CURRENT = "llmgateway/deepseek-v4.1-flash";
const OPENCODE = "opencode-go/deepseek-v4.1-flash";
const COMMANDCODE = "commandcode/deepseek/deepseek-v4.1-flash";
/** Pinned store clock: a 1 h cooldown always resets at 2030-01-01T01:00Z. */
const NOW_MS = Date.UTC(2030, 0, 1, 0, 0, 0);

interface ModelRef {
  provider: string;
  id: string;
}

/** Providers a frontier-class candidate of `CURRENT` can land on. */
const ALL_PROVIDERS = ["llmgateway", "opencode-go", "commandcode", "openrouter"];

const KNOWN_MODELS: ModelRef[] = [
  { provider: "llmgateway", id: "deepseek-v4.1-flash-1017" },
  { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" },
  { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" },
  { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
];

/** Minimal pi stand-in: registers handlers, records setModel calls. */
function createPi(options: { setModelOk?: (m: ModelRef) => boolean }) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const setModel = vi.fn(async (model: ModelRef) =>
    options.setModelOk === undefined ? true : options.setModelOk(model),
  );
  const api = {
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    setModel,
  } as unknown as ExtensionAPI;
  return { api, handlers, setModel };
}

let dir: string;
let statePath: string;
/** The session's view of the shared store, and a peer process's second connection. */
let stateStore: ModelStateStore;
let otherConnection: ModelStateStore;

function openTestStore(): ModelStateStore {
  const opened = openModelStateStore({ path: statePath });
  if (!opened.ok) throw new Error(opened.error);
  return opened.store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "belayd-session-routing-"));
  statePath = join(dir, "model-state.sqlite");
  stateStore = openTestStore();
  otherConnection = openTestStore();
});

afterEach(() => {
  stateStore.close();
  otherConnection.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(options: {
  knownModels?: readonly ModelRef[];
  setModelOk?: (m: ModelRef) => boolean;
  isSubAgent?: boolean;
  enabled?: boolean;
  capacity?: CapacityCache;
  /** Pin the store/capacity clock so a reset window is deterministic. */
  nowMs?: number;
  /** Leave the sink un-injected, exercising the default `[belayd-harness]` log. */
  defaultSink?: boolean;
  /** Make the model registry lookup throw, as a broken registry would. */
  findThrows?: boolean;
}) {
  const knownModels = options.knownModels ?? KNOWN_MODELS;
  const fixedNow = options.nowMs;
  // bd-256: there is one cooldown truth (the shared SQLite store), so the test
  // binds the adapter to its own connection instead of a JSON file.
  const store = createModelCooldownStore({
    store: stateStore,
    ...(fixedNow === undefined ? {} : { now: () => fixedNow }),
  });
  const pi = createPi(options.setModelOk === undefined ? {} : { setModelOk: options.setModelOk });
  const notify = vi.fn();
  const sessionRouting = {
    pi: pi.api,
    routing: {
      cooldownStore: store,
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      enabled: options.enabled ?? true,
    },
    isSubAgent: () => options.isSubAgent ?? false,
    ...(options.defaultSink === true ? {} : { notify }),
  };
  registerSessionModelRouting(sessionRouting);

  const uiNotify = vi.fn();
  const ctx = {
    model: { provider: "llmgateway", id: "deepseek-v4.1-flash" },
    ui: { notify: uiNotify },
    sessionManager: { getSessionId: () => "sess-257", getSessionName: () => "pi-web-session" },
    modelRegistry: {
      find: (provider: string, modelId: string) => {
        if (options.findThrows === true) throw new Error("registry lookup exploded");
        return knownModels.find((m) => m.provider === provider && m.id === modelId);
      },
    },
  } as unknown as ExtensionContext;

  const emit = async () =>
    Promise.all(
      (pi.handlers.get("session_start") ?? []).map((handler) =>
        handler({ type: "session_start", reason: "new" }, ctx),
      ),
    );
  return { store, pi, notify, uiNotify, emit };
}

/** Cool every provider a frontier candidate can land on. */
function coolEveryProvider(store: ModelCooldownStore, resetInMinutes = 120): void {
  for (const provider of ALL_PROVIDERS) {
    store.markProviderCooldown(provider, resetInMinutes * 60, "quota", { cause: "quota" });
  }
}

describe("session model pre-flight", () => {
  it("routes a session off a cooled default before its first turn", async () => {
    // A pinned clock makes the reset window (and therefore the whole line)
    // exact: the test must pin old-before-new and the reason, not just both ids.
    const { store, pi, notify, emit } = setup({ nowMs: NOW_MS });
    store.markProviderCooldown("llmgateway", 3600, "quota", { cause: "quota" });

    await emit();

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setModel.mock.calls[0]?.[0]).toEqual({
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual([
      `session model routed from ${CURRENT} to ${OPENCODE} because llmgateway (resets 2030-01-01T01:00:00.000Z) cannot serve a turn.`,
      "info",
    ]);
  });

  it("logs the routing line to the harness sink when no notify is injected", async () => {
    const { store, emit } = setup({ nowMs: NOW_MS, defaultSink: true });
    store.markProviderCooldown("llmgateway", 3600, "quota", { cause: "quota" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await emit();

      expect(log).toHaveBeenCalledTimes(1);
      // Without the prefix an operator cannot tell the harness's routing
      // decision from any other process writing to the same stdout.
      expect(log.mock.calls[0]?.[0]).toBe(
        `[belayd-harness] session model routed from ${CURRENT} to ${OPENCODE} because llmgateway (resets 2030-01-01T01:00:00.000Z) cannot serve a turn.`,
      );
    } finally {
      log.mockRestore();
    }
  });

  it("reports a routing failure without rejecting session_start", async () => {
    const { store, pi, notify, emit } = setup({ findThrows: true });
    store.markProviderCooldown("llmgateway", 3600, "quota", { cause: "quota" });

    // pi runs every `session_start` handler: a rejection here would abort the
    // telemetry reset, the provider wrapping and the gate resume after it.
    await expect(emit()).resolves.toBeDefined();

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "session model pre-flight failed: registry lookup exploded",
      "warning",
    );
    // A failure must not also emit a routing decision claiming a switch.
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("session model routed from"),
      expect.anything(),
    );
  });

  it("leaves a healthy default untouched", async () => {
    const { pi, notify, uiNotify, emit } = setup({});

    await emit();

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(uiNotify).not.toHaveBeenCalled();
  });

  it("reports the blocked providers instead of starting silently dead", async () => {
    const { store, pi, notify, uiNotify, emit } = setup({});
    coolEveryProvider(store);

    await emit();

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("No model candidate can serve"),
      "warning",
    );
    for (const provider of ALL_PROVIDERS) {
      expect(notify).toHaveBeenCalledWith(expect.stringContaining(provider), "warning");
    }
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("resets"), "warning");
    // The operator-facing UI gets the same warning; the session does not start a
    // turn on a provider that cannot serve one.
    expect(uiNotify).toHaveBeenCalledTimes(1);
    expect(uiNotify).toHaveBeenCalledWith(expect.stringContaining("resets"), "warning");
  });

  it("skips the pre-flight entirely when fallback is disabled", async () => {
    const { store, pi, notify, emit } = setup({ enabled: false });
    coolEveryProvider(store);
    const refresh = vi.spyOn(store, "refresh");

    await emit();

    expect(refresh).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a phase sub-agent alone even when its model is cooled", async () => {
    const { store, pi, notify, emit } = setup({ isSubAgent: true });
    coolEveryProvider(store);

    await emit();

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("falls through a candidate the session cannot switch to", async () => {
    const { store, pi, notify, emit } = setup({
      setModelOk: (model) => model.provider !== "opencode-go",
    });
    store.markProviderCooldown("llmgateway", 3600, "quota", { cause: "quota" });

    await emit();

    expect(pi.setModel).toHaveBeenCalledTimes(2);
    expect(pi.setModel.mock.calls[1]?.[0]).toEqual({
      provider: "commandcode",
      id: "deepseek/deepseek-v4.1-flash",
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(COMMANDCODE), "info");
  });

  it("sees a provider another process cooled after the store was created (bd-234)", async () => {
    const { pi, emit } = setup({});
    // Cooldown reads are uncached `listCooldowns` queries against the shared
    // store, so the peer's write is visible without any refresh. This case guards
    // that wiring: an adapter holding a snapshot would still see a healthy
    // default and leave the session on the spent provider.
    const otherMember = createModelCooldownStore({ store: otherConnection });
    otherMember.markProviderCooldown("llmgateway", 3600, "quota", { cause: "quota" });

    await emit();

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setModel.mock.calls[0]?.[0]).toEqual({
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
  });

  it("routes on a capacity window without a cooldown entry", async () => {
    const capacity = createCapacityCache();
    const probe = vi.spyOn(capacity, "refreshIfStale");
    capacity.record({
      provider: "llmgateway",
      resetAt: Date.now() + 3600_000,
      reason: "Quota/credit/rate limit (HTTP 402).",
    });
    const { store, pi, emit } = setup({ capacity });

    await emit();

    expect(store.providerEntries().size).toBe(0);
    // The pre-flight runs once per session, so it pays for a fresh endpoint read
    // instead of trusting the cache (bd-257 review W1).
    expect(probe).toHaveBeenCalledTimes(1);
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setModel.mock.calls[0]?.[0]).toEqual({
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
  });
});

/**
 * Composed-extension wiring: every case above registers the handler directly, so
 * dropping `registerSessionModelRouting(...)` from `extensions/index.ts` would
 * leave the whole suite green. This boots the real composer and dispatches its
 * `session_start` chain in registration order, the way pi does.
 */

/**
 * Env the composer resolves to pick its stores and honour the kill switch.
 *
 * `BELAYD_MODEL_STATE_FILE` decides the one shared store (`resolveModelStatePath`)
 * and `BELAYD_MODEL_COOLDOWN_FILE` still names the retired JSON file the store
 * imports from once. `BELAYD_MODEL_FALLBACK` is captured when the module loads.
 * A developer shell exporting any of them would otherwise decide this test's
 * outcome, so each is pinned for the boot and restored afterwards.
 */
const COMPOSER_ENV_KEYS = [
  "BELAYD_MODEL_STATE_FILE",
  "BELAYD_MODEL_COOLDOWN_FILE",
  "BELAYD_MODEL_FALLBACK",
] as const;

type ComposerEnvKey = (typeof COMPOSER_ENV_KEYS)[number];

/** Run `boot` with the composer's ambient env pinned; a missing key means "unset". */
async function withComposerEnv(
  overrides: Partial<Record<ComposerEnvKey, string>>,
  boot: () => Promise<void>,
): Promise<void> {
  const previous = new Map<ComposerEnvKey, string | undefined>();
  for (const key of COMPOSER_ENV_KEYS) previous.set(key, process.env[key]);
  try {
    for (const key of COMPOSER_ENV_KEYS) {
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await boot();
  } finally {
    // `undefined` means the key was absent, so deleting it is the exact restore;
    // writing "undefined" would leave a truthy-looking string behind.
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("session model pre-flight wiring (extensions/index.ts)", () => {
  it("runs the pre-flight registered by the composed extension", async () => {
    await withComposerEnv(
      {
        BELAYD_MODEL_STATE_FILE: statePath,
        // A nonexistent import source: an ambient legacy file with live windows
        // would otherwise be imported into this test's store on first use.
        BELAYD_MODEL_COOLDOWN_FILE: join(dir, "legacy-cooldowns.json"),
        BELAYD_MODEL_FALLBACK: "1",
      },
      async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        try {
          const mod = await import("../../extensions/index.js");
          const composed = createComposedPi();
          mod.default(composed.api);

          // Persisted after the composed module loaded its store, so only the
          // pre-flight's own read at `session_start` can see it.
          const peer = openModelStateStore({ path: statePath });
          if (!peer.ok) throw new Error(peer.error);
          peer.store.markCooldown({
            provider: "llmgateway",
            durationMs: 3_600_000,
            reason: "quota",
            cause: "quota",
            hinted: true,
          });
          peer.store.close();

          const handler = composed.eventHandlers.get("session_start");
          expect(handler).toBeDefined();
          await handler?.({ type: "session_start", reason: "new" }, wiringContext());

          expect(composed.setModel).toHaveBeenCalledTimes(1);
          expect(composed.setModel.mock.calls[0]?.[0]).toEqual({
            provider: "opencode-go",
            id: "deepseek-v4.1-flash",
          });
          // The composed hook injects no `notify`, so the decision must reach the
          // default harness sink with the same wording the direct cases pin. The
          // window comes from the real clock here, hence the anchored pattern.
          expect(log).toHaveBeenCalledTimes(1);
          expect(log).toHaveBeenCalledWith(
            expect.stringMatching(
              /^\[belayd-harness\] session model routed from llmgateway\/deepseek-v4\.1-flash to opencode-go\/deepseek-v4\.1-flash because llmgateway \(resets \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\) cannot serve a turn\.$/,
            ),
          );
        } finally {
          log.mockRestore();
          warn.mockRestore();
        }
      },
    );
  });
});

/** pi stand-in rich enough to boot the composer: it registers every capability. */
function createComposedPi() {
  const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let activeTools: string[] = [];
  const setModel = vi.fn(async (_model: ModelRef) => true);
  const api = {
    registerTool: () => {},
    registerCommand: () => {},
    registerProvider: () => {},
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event !== "session_start") {
        eventHandlers.set(event, handler);
        return;
      }
      sessionStartHandlers.push(handler);
      // pi runs every `session_start` handler in registration order and the
      // pre-flight is registered last, after the bd-187 provider wrapping.
      eventHandlers.set(event, (e: unknown, c: unknown) =>
        Promise.all(sessionStartHandlers.map((registered) => registered(e, c))),
      );
    },
    sendMessage: () => {},
    sendUserMessage: () => {},
    setModel,
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => {
      activeTools = next;
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        const set = listeners.get(channel) ?? new Set<(data: unknown) => void>();
        set.add(handler);
        listeners.set(channel, set);
        return () => {
          set.delete(handler);
        };
      },
    },
  } as unknown as ExtensionAPI;
  return { api, eventHandlers, setModel };
}

/**
 * A plain pi-web session: it has no session file and no `-sub-` name, so only
 * the pre-flight and the cheap reset path run.
 */
function wiringContext(): ExtensionContext {
  return {
    cwd: dir,
    model: { provider: "llmgateway", id: "deepseek-v4.1-flash" },
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => "sess-257-wiring",
      getSessionName: () => "pi-web-session",
      getSessionFile: () => undefined,
    },
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        KNOWN_MODELS.find((m) => m.provider === provider && m.id === modelId),
      getAll: () => [],
      getProvider: () => undefined,
    },
  } as unknown as ExtensionContext;
}
