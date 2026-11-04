/**
 * In-session model recovery (bd-229).
 *
 * A session the harness did not spawn has no `spawn-with-fallback` wrapper, so a
 * quota-class error on its own turn used to end the turn with nothing retried.
 * These tests drive the two hooks directly: `message_end` must classify and
 * persist the verdict, `agent_before_settle` must switch the model and continue
 * exactly once, and phase sub-agents must be left alone.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelRecovery } from "../../extensions/capabilities/model-recovery.js";
import { type CapacityCache, createCapacityCache } from "../capacity-cache.js";
import { createModelCooldownStore } from "../model-cooldown.js";
import type { ModelStateStore } from "../model-state-store.js";
import { openModelStateStore } from "../model-state-store.js";

const OPENCODE = "opencode-go/deepseek-v4.1-flash";
const COMMANDCODE = "commandcode/deepseek/deepseek-v4.1-flash";

/** The live `402 … billing_error` body that motivated bd-229. */
const BILLING_ERROR =
  '402: {"message":"Dev Plan credit limit reached. Upgrade your plan or wait for renewal on 11/4/2026.",' +
  '"type":"invalid_request_error","param":null,"code":"billing_error"}';

interface ModelRef {
  provider: string;
  id: string;
}

/** Minimal pi stand-in: registers handlers, records setModel calls. */
function createPi(options: {
  knownModels: readonly ModelRef[];
  setModelOk?: (m: ModelRef) => boolean;
}) {
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
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        options.knownModels.find((m) => m.provider === provider && m.id === modelId),
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, setModel };
}

function createCtx(model: ModelRef, knownModels: readonly ModelRef[]) {
  return {
    model,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => "sess-1", getSessionName: () => "belayd-bd-229" },
    // pi resolves a candidate to a live model object before `setModel`, so the
    // context must expose the same registry lookup the real one does.
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        knownModels.find((m) => m.provider === provider && m.id === modelId),
    },
  } as unknown as ExtensionContext;
}

/** A boundary event as pi builds it: the run errored and may continue. */
const BOUNDARY = {
  type: "agent_before_settle",
  entries: [],
  continue: false,
  outcome: "error",
  context: { canContinue: true },
};

const KNOWN_MODELS: ModelRef[] = [
  { provider: "llmgateway", id: "deepseek-v4.1-flash-1017" },
  { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" },
  { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" },
  { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
];

let dir: string;
/** The session's store, and a second connection standing in for a peer process. */
let stateStore: ModelStateStore;
let otherConnection: ModelStateStore;

function openTestStore(): ModelStateStore {
  const opened = openModelStateStore({ path: join(dir, "model-state.sqlite") });
  if (!opened.ok) throw new Error(opened.error);
  return opened.store;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "belayd-model-recovery-"));
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
}) {
  const store = createModelCooldownStore({ store: stateStore });
  const pi = createPi({
    knownModels: options.knownModels ?? KNOWN_MODELS,
    ...(options.setModelOk === undefined ? {} : { setModelOk: options.setModelOk }),
  });
  const notify = vi.fn();
  registerModelRecovery({
    pi: pi.api,
    routing: {
      cooldownStore: store,
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      enabled: options.enabled ?? true,
    },
    isSubAgent: () => options.isSubAgent ?? false,
    notify,
  });
  const emit = async (event: string, payload: unknown, ctx: ModelRef) =>
    Promise.all(
      (pi.handlers.get(event) ?? []).map((handler) =>
        handler(payload, createCtx(ctx, options.knownModels ?? KNOWN_MODELS)),
      ),
    );
  return { store, pi, notify, emit };
}

const errorMessage = (errorMessage: string, model = "deepseek-v4.1-flash-1017") => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "error", errorMessage, model },
});

describe("in-session model recovery", () => {
  it("switches to the next candidate and continues the run once on a 402", async () => {
    const { pi, notify, emit } = setup({});
    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);
    const result = (await emit(
      "agent_before_settle",
      BOUNDARY,
      KNOWN_MODELS[0] as ModelRef,
    )) as Array<{ continue?: boolean; entries?: Array<{ customType: string }> } | undefined>;

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setModel.mock.calls[0]?.[0]).toEqual({
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
    const last = result[result.length - 1];
    expect(last?.continue).toBe(true);
    expect(last?.entries?.[0]?.customType).toBe("belayd-model-recovery");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(OPENCODE), "warning");
  });

  it("persists a provider-scoped cooldown so the next phase spawn skips it", async () => {
    const { store, emit } = setup({});
    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);

    const entry = store.providerEntries().get("llmgateway");
    expect(entry).toBeDefined();
    expect(entry?.cause).toBe("quota");
    expect(entry?.reason).toContain("402");
    expect(store.cooldownScope("llmgateway/glm-5.3")).toBe("provider");
  });

  it("does not repeat a candidate it already ran on", async () => {
    const { pi, emit } = setup({});
    const ctx = KNOWN_MODELS[0] as ModelRef;
    await emit("message_end", errorMessage(BILLING_ERROR), ctx);
    await emit("agent_before_settle", BOUNDARY, ctx);

    // The same failure again, now on the second provider (the session model did
    // not change in this fake, so drive the second switch from a fresh error).
    await emit("message_end", errorMessage(BILLING_ERROR, "deepseek-v4.1-flash"), {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
    await emit("agent_before_settle", BOUNDARY, {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
    });

    const chosen = pi.setModel.mock.calls.map((call) => call[0] as ModelRef);
    expect(chosen.map((m) => `${m.provider}/${m.id}`)).toEqual([OPENCODE, COMMANDCODE]);
  });

  it("falls through a candidate the session cannot switch to", async () => {
    const { pi, emit } = setup({
      setModelOk: (model) => model.provider !== "opencode-go",
    });
    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);
    const result = (await emit(
      "agent_before_settle",
      BOUNDARY,
      KNOWN_MODELS[0] as ModelRef,
    )) as Array<{ continue?: boolean } | undefined>;

    expect(pi.setModel).toHaveBeenCalledTimes(2);
    expect(result[result.length - 1]?.continue).toBe(true);
  });

  it("stays put when no candidate is left", async () => {
    const { pi, emit, notify } = setup({ knownModels: [] });
    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);
    const result = (await emit(
      "agent_before_settle",
      BOUNDARY,
      KNOWN_MODELS[0] as ModelRef,
    )) as Array<unknown>;

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(result.every((value) => value === undefined)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a phase sub-agent alone", async () => {
    const { pi, emit } = setup({ isSubAgent: true });
    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);
    const result = (await emit(
      "agent_before_settle",
      BOUNDARY,
      KNOWN_MODELS[0] as ModelRef,
    )) as Array<unknown>;

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(result.every((value) => value === undefined)).toBe(true);
  });

  it("ignores a successful turn", async () => {
    const { pi, emit } = setup({});
    await emit(
      "message_end",
      { type: "message_end", message: { role: "assistant", stopReason: "end" } },
      KNOWN_MODELS[0] as ModelRef,
    );
    await emit("agent_before_settle", BOUNDARY, KNOWN_MODELS[0] as ModelRef);
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("ignores a failure switching models cannot fix", async () => {
    const { store, pi, emit } = setup({});
    await emit("message_end", errorMessage("401: invalid api key"), KNOWN_MODELS[0] as ModelRef);
    await emit("agent_before_settle", BOUNDARY, KNOWN_MODELS[0] as ModelRef);

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(store.providerEntries().size).toBe(0);
  });

  it("does nothing when fallback is disabled", async () => {
    const { store, pi, emit } = setup({ enabled: false });
    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);
    await emit("agent_before_settle", BOUNDARY, KNOWN_MODELS[0] as ModelRef);

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(store.providerEntries().size).toBe(0);
  });

  it("does not continue when the boundary cannot continue", async () => {
    const { pi, emit } = setup({});
    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);
    const result = (await emit(
      "agent_before_settle",
      { ...BOUNDARY, context: { canContinue: false } },
      KNOWN_MODELS[0] as ModelRef,
    )) as Array<unknown>;

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(result.every((value) => value === undefined)).toBe(true);
  });

  it("sees a provider another process cooled after the store was created (bd-234)", async () => {
    // The session's cooldown adapter holds no snapshot: every scope read goes
    // through the shared ModelStateStore, so a fleet member spending opencode-go
    // after registration must still be skipped when the switch target is chosen,
    // or the one continuation lands on a dead provider.
    const { pi, emit } = setup({});
    // Mark AFTER `message_end` has persisted this session's own llmgateway entry.
    // Visibility is structural, not the effect of a refresh: every cooldown read
    // is an uncached `listCooldowns` query against the shared store, so the peer's
    // row is seen exactly as the continuation builds its plan.
    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);
    const otherMember = createModelCooldownStore({ store: otherConnection });
    otherMember.markProviderCooldown("opencode-go", 3600, "quota", { cause: "quota" });

    await emit("agent_before_settle", BOUNDARY, KNOWN_MODELS[0] as ModelRef);

    expect(pi.setModel.mock.calls[0]?.[0]).toEqual({
      provider: "commandcode",
      id: "deepseek/deepseek-v4.1-flash",
    });
  });

  it("does not probe the capacity endpoint before the continuation (bd-257)", async () => {
    // Recovery is a one-shot continuation after a failed turn: a probe bounded by
    // the endpoint timeout would delay it, so it judges candidates against the
    // capacity cache it already has (bd-257 review W1).
    const capacity = createCapacityCache();
    const probe = vi.spyOn(capacity, "refreshIfStale");
    const { pi, emit } = setup({ capacity });

    await emit("message_end", errorMessage(BILLING_ERROR), KNOWN_MODELS[0] as ModelRef);
    await emit("agent_before_settle", BOUNDARY, KNOWN_MODELS[0] as ModelRef);

    expect(probe).not.toHaveBeenCalled();
    expect(pi.setModel).toHaveBeenCalledTimes(1);
  });

  it("stops switching at the per-session cap instead of walking the class forever", async () => {
    const { pi, emit } = setup({});
    // Each provider serves the frontier candidate list in turn; after three
    // switches the cap must stop a fourth, or one exhausted allowlist burns a
    // failed request per candidate on every turn.
    const providers: ModelRef[] = [
      { provider: "llmgateway", id: "deepseek-v4.1-flash-1017" },
      { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" },
      { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" },
      { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
    ];
    for (const ctx of providers) {
      await emit("message_end", errorMessage(BILLING_ERROR, ctx.id), ctx);
      await emit("agent_before_settle", BOUNDARY, ctx);
    }
    expect(pi.setModel.mock.calls.length).toBe(3);
  });
});
