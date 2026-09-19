/**
 * Honcho memory configuration — pure derivation, no I/O.
 *
 * Reads the Honcho settings from environment variables with an optional
 * ~/.pi/agent/auth.json fallback for the API key (mirroring the llmgateway
 * key-resolution pattern in src/llmgateway-models.ts). When the API key is
 * absent the integration is a no-op, so every caller must treat a non-ok
 * result as "do nothing" rather than a failure.
 */

import { basename } from "node:path";

export const HONCHO_DEFAULT_BASE_URL = "https://api.honcho.dev";
export const HONCHO_DEFAULT_REQUEST_TIMEOUT_MS = 3000;
export const HONCHO_DEFAULT_CONTEXT_TOKENS = 2000;

export interface HonchoConfig {
  apiKey: string;
  workspaceId: string;
  baseUrl: string;
  peerId: string;
  enabled: true;
  requestTimeoutMs: number;
  contextTokens: number;
}

export type HonchoConfigResult =
  | { ok: true; value: HonchoConfig }
  | { ok: false; reason: "disabled" | "missing_api_key"; message: string };

/** Values of HONCHO_ENABLED that mean "off" once trimmed and lowercased. */
const HONCHO_DISABLED_VALUES: ReadonlySet<string> = new Set(["0", "false", "off", "no", ""]);

/**
 * The kill switch must be exact enough to disable reliably: unset means
 * enabled, and any trimmed, case-insensitive falsy spelling disables.
 */
function isHonchoDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HONCHO_ENABLED;
  if (raw === undefined) return false;
  return HONCHO_DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/** Lowercase `input` and collapse every run of non-alphanumerics into `-`. */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "repo" : slug;
}

/** Parse a positive integer env value, falling back to `fallback` when invalid. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return fallback;
  const value = Number.parseInt(trimmed, 10);
  return value > 0 ? value : fallback;
}

/**
 * Extract the honcho api_key from auth.json text. Only the
 * `{ type: "api_key", key }` shape is honored; every parse/shape error
 * yields undefined (auth.json is optional and user-edited).
 */
export function parseHonchoApiKeyFromAuthJson(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const honcho = (parsed as Record<string, unknown>).honcho;
    if (typeof honcho !== "object" || honcho === null) return undefined;
    const entry = honcho as Record<string, unknown>;
    if (entry.type !== "api_key") return undefined;
    const key = entry.key;
    return typeof key === "string" && key.trim() !== "" ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the API key: HONCHO_API_KEY env wins, then auth.json's honcho entry. */
function resolveApiKey(env: NodeJS.ProcessEnv, authJsonText?: string): string | undefined {
  const envKey = env.HONCHO_API_KEY;
  if (typeof envKey === "string") {
    const trimmed = envKey.trim();
    if (trimmed !== "") return trimmed;
  }
  if (authJsonText !== undefined) {
    return parseHonchoApiKeyFromAuthJson(authJsonText);
  }
  return undefined;
}

/**
 * Derive the Honcho workspace id. `HONCHO_WORKSPACE_ID` wins, otherwise the
 * slug of the repository basename for the current working directory.
 */
export function deriveWorkspaceId(cwd: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HONCHO_WORKSPACE_ID;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return slugify(basename(cwd));
}

/**
 * Derive the Honcho peer id. `HONCHO_PEER_ID` wins, otherwise
 * `project:<slug-of-repo-basename>`.
 */
export function derivePeerId(cwd: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HONCHO_PEER_ID;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return `project:${slugify(basename(cwd))}`;
}

/**
 * Read and validate the Honcho configuration. Returns a discriminated-union
 * result so callers can no-op on `disabled` / `missing_api_key` instead of
 * throwing.
 */
export function readHonchoConfig(
  env: NodeJS.ProcessEnv,
  options: { cwd: string; authJsonText?: string },
): HonchoConfigResult {
  if (isHonchoDisabled(env)) {
    return {
      ok: false,
      reason: "disabled",
      message: "Honcho memory is disabled (HONCHO_ENABLED set to a falsy value)",
    };
  }

  const apiKey = resolveApiKey(env, options.authJsonText);
  if (apiKey === undefined) {
    return {
      ok: false,
      reason: "missing_api_key",
      message:
        "no Honcho API key found (set HONCHO_API_KEY or add a 'honcho' api_key to ~/.pi/agent/auth.json)",
    };
  }

  const baseUrlRaw = env.HONCHO_BASE_URL;
  const baseUrl =
    typeof baseUrlRaw === "string" && baseUrlRaw.trim() !== ""
      ? baseUrlRaw.trim().replace(/\/+$/, "")
      : HONCHO_DEFAULT_BASE_URL;

  return {
    ok: true,
    value: {
      apiKey,
      workspaceId: deriveWorkspaceId(options.cwd, env),
      baseUrl,
      peerId: derivePeerId(options.cwd, env),
      enabled: true,
      requestTimeoutMs: parsePositiveInt(
        env.HONCHO_REQUEST_TIMEOUT_MS,
        HONCHO_DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      contextTokens: parsePositiveInt(env.HONCHO_CONTEXT_TOKENS, HONCHO_DEFAULT_CONTEXT_TOKENS),
    },
  };
}
