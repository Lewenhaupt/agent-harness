/**
 * Tests for src/honcho-memory/config.ts.
 *
 * Pure module — no mocks; every case passes env/auth data as arguments and
 * asserts on the returned discriminated-union shape.
 */

import { describe, expect, it } from "vitest";
import {
  derivePeerId,
  deriveWorkspaceId,
  HONCHO_DEFAULT_BASE_URL,
  HONCHO_DEFAULT_CONTEXT_TOKENS,
  HONCHO_DEFAULT_REQUEST_TIMEOUT_MS,
  parseHonchoApiKeyFromAuthJson,
  readHonchoConfig,
} from "../honcho-memory/config.js";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("readHonchoConfig", () => {
  it("returns missing_api_key when no env or auth.json key is present", () => {
    const result = readHonchoConfig(env(), { cwd: "/work/foo" });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result).toHaveProperty("reason", "missing_api_key");
    }
  });

  it("returns disabled when HONCHO_ENABLED=0 even with a key present", () => {
    const result = readHonchoConfig(env({ HONCHO_ENABLED: "0", HONCHO_API_KEY: "sk-x" }), {
      cwd: "/work/foo",
    });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result).toHaveProperty("reason", "disabled");
    }
  });

  it.each([["false"], ["off"], ["no"], [" 0 "], ["False"], ["OFF"]])(
    "returns disabled when HONCHO_ENABLED=%s",
    (value) => {
      const result = readHonchoConfig(env({ HONCHO_ENABLED: value, HONCHO_API_KEY: "sk-x" }), {
        cwd: "/work/foo",
      });
      expect(result).toHaveProperty("ok", false);
      if (!result.ok) {
        expect(result).toHaveProperty("reason", "disabled");
      }
    },
  );

  it("enables when HONCHO_ENABLED=1 or is unset", () => {
    const withOne = readHonchoConfig(env({ HONCHO_ENABLED: "1", HONCHO_API_KEY: "sk-x" }), {
      cwd: "/work/foo",
    });
    expect(withOne).toHaveProperty("ok", true);

    const unset = readHonchoConfig(env({ HONCHO_API_KEY: "sk-x" }), { cwd: "/work/foo" });
    expect(unset).toHaveProperty("ok", true);
  });

  it("prefers HONCHO_API_KEY env over auth.json", () => {
    const result = readHonchoConfig(
      env({ HONCHO_API_KEY: "sk-env", HONCHO_WORKSPACE_ID: "w-env" }),
      {
        cwd: "/work/foo",
        authJsonText: JSON.stringify({ honcho: { type: "api_key", key: "sk-file" } }),
      },
    );
    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.value).toHaveProperty("apiKey", "sk-env");
      expect(result.value).toHaveProperty("workspaceId", "w-env");
    }
  });

  it("falls back to auth.json honcho entry when env key is unset", () => {
    const result = readHonchoConfig(env(), {
      cwd: "/work/foo",
      authJsonText: JSON.stringify({ honcho: { type: "api_key", key: "sk-file" } }),
    });
    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.value).toHaveProperty("apiKey", "sk-file");
    }
  });

  it("ignores a malformed auth.json honcho entry", () => {
    const result = readHonchoConfig(env(), {
      cwd: "/work/foo",
      authJsonText: JSON.stringify({ honcho: { type: "oauth" } }),
    });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result).toHaveProperty("reason", "missing_api_key");
    }
  });

  it("ignores malformed auth.json text", () => {
    const result = readHonchoConfig(env(), { cwd: "/work/foo", authJsonText: "{not json" });
    expect(result).toHaveProperty("ok", false);
  });

  it("defaults baseUrl, timeout, and tokens when not provided", () => {
    const result = readHonchoConfig(env({ HONCHO_API_KEY: "sk-x" }), { cwd: "/work/foo" });
    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.value).toHaveProperty("baseUrl", HONCHO_DEFAULT_BASE_URL);
      expect(result.value).toHaveProperty("requestTimeoutMs", HONCHO_DEFAULT_REQUEST_TIMEOUT_MS);
      expect(result.value).toHaveProperty("contextTokens", HONCHO_DEFAULT_CONTEXT_TOKENS);
    }
  });

  it("honors baseUrl, timeout, and tokens overrides", () => {
    const result = readHonchoConfig(
      env({
        HONCHO_API_KEY: "sk-x",
        HONCHO_BASE_URL: "https://honcho.example.com/",
        HONCHO_REQUEST_TIMEOUT_MS: "5000",
        HONCHO_CONTEXT_TOKENS: "4000",
      }),
      { cwd: "/work/foo" },
    );
    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.value).toHaveProperty("baseUrl", "https://honcho.example.com");
      expect(result.value).toHaveProperty("requestTimeoutMs", 5000);
      expect(result.value).toHaveProperty("contextTokens", 4000);
    }
  });

  it("falls back to defaults for non-numeric timeout/tokens", () => {
    const result = readHonchoConfig(
      env({ HONCHO_API_KEY: "sk-x", HONCHO_REQUEST_TIMEOUT_MS: "abc", HONCHO_CONTEXT_TOKENS: "0" }),
      { cwd: "/work/foo" },
    );
    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.value).toHaveProperty("requestTimeoutMs", HONCHO_DEFAULT_REQUEST_TIMEOUT_MS);
      expect(result.value).toHaveProperty("contextTokens", HONCHO_DEFAULT_CONTEXT_TOKENS);
    }
  });
});

describe("deriveWorkspaceId / derivePeerId", () => {
  it("env wins over repo slug", () => {
    expect(
      deriveWorkspaceId("/work/belayd-agent-harness", env({ HONCHO_WORKSPACE_ID: "custom" })),
    ).toBe("custom");
    expect(derivePeerId("/work/belayd-agent-harness", env({ HONCHO_PEER_ID: "peer-x" }))).toBe(
      "peer-x",
    );
  });

  it("derives slug from repo basename", () => {
    expect(deriveWorkspaceId("/work/belayd-agent-harness", env())).toBe("belayd-agent-harness");
    expect(derivePeerId("/work/belayd-agent-harness", env())).toBe("project:belayd-agent-harness");
  });

  it("normalizes non-alphanumerics to dashes and lowercases", () => {
    expect(deriveWorkspaceId("/work/My Repo_Here", env())).toBe("my-repo-here");
    expect(derivePeerId("/work/My Repo_Here", env())).toBe("project:my-repo-here");
  });
});

describe("parseHonchoApiKeyFromAuthJson", () => {
  it("returns the key for the api_key shape", () => {
    expect(
      parseHonchoApiKeyFromAuthJson(JSON.stringify({ honcho: { type: "api_key", key: "sk-1" } })),
    ).toBe("sk-1");
  });

  it("returns undefined for non-api_key shapes", () => {
    expect(
      parseHonchoApiKeyFromAuthJson(JSON.stringify({ honcho: { type: "oauth" } })),
    ).toBeUndefined();
  });

  it("returns undefined for missing honcho entry and invalid JSON", () => {
    expect(parseHonchoApiKeyFromAuthJson("{}")).toBeUndefined();
    expect(parseHonchoApiKeyFromAuthJson("nope")).toBeUndefined();
  });
});
