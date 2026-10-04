/**
 * Tests for the cross-extension registration dedup helper.
 *
 * The helper keys on the extension load batch's shared event bus, so the fake
 * below is a minimal synchronous bus: `on` registers a listener, `emit`
 * invokes them in order. That mirrors pi's bus for the one synchronous emit
 * the helper performs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { claimRegistrationOnce } from "../../src/claim-registry.js";

interface FakeBus {
  api: ExtensionAPI;
  listenerCount: (channel: string) => number;
}

function createBusApi(): FakeBus {
  const listeners = new Map<string, Array<(data: unknown) => void>>();

  const api = {
    events: {
      on: (channel: string, handler: (data: unknown) => void): (() => void) => {
        const existing = listeners.get(channel) ?? [];
        existing.push(handler);
        listeners.set(channel, existing);
        return () => {
          const current = listeners.get(channel) ?? [];
          listeners.set(
            channel,
            current.filter((candidate) => candidate !== handler),
          );
        };
      },
      emit: (channel: string, data: unknown): void => {
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    listenerCount: (channel: string) => (listeners.get(channel) ?? []).length,
  };
}

describe("claimRegistrationOnce", () => {
  it("lets the first copy claim a channel and makes later copies yield", () => {
    const { api } = createBusApi();
    expect(claimRegistrationOnce(api, "channel")).toBe(true);
    expect(claimRegistrationOnce(api, "channel")).toBe(false);
  });

  it("scopes claims to the channel", () => {
    const { api } = createBusApi();
    expect(claimRegistrationOnce(api, "a")).toBe(true);
    expect(claimRegistrationOnce(api, "b")).toBe(true);
  });

  it("leaves the probe listener in place for the winning copy", () => {
    const { api, listenerCount } = createBusApi();
    expect(claimRegistrationOnce(api, "channel")).toBe(true);
    expect(listenerCount("channel")).toBe(1);
  });

  it("removes the probe listener for a yielding copy", () => {
    const { api, listenerCount } = createBusApi();
    claimRegistrationOnce(api, "channel");
    expect(claimRegistrationOnce(api, "channel")).toBe(false);
    expect(listenerCount("channel")).toBe(1);
  });

  it("treats separate load batches (fresh buses) as independent", () => {
    const first = createBusApi();
    const second = createBusApi();
    expect(claimRegistrationOnce(first.api, "channel")).toBe(true);
    expect(claimRegistrationOnce(second.api, "channel")).toBe(true);
  });
});
