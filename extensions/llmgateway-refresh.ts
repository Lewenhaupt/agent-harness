/**
 * LLM Gateway models refresh — pi project-level extension.
 *
 * Exposes `/llmgateway-refresh`, a TypeScript port of
 * `scripts/refresh-llmgateway-models.sh`. Fetches
 * https://api.llmgateway.io/v1/models, maps it through the pure functions in
 * `src/llmgateway-models.ts`, and rewrites `~/.pi/agent/models.json`.
 *
 * Loaded alongside the other harness extensions (package.json `pi.extensions`,
 * bin/pi, the flake's belayd-pi, and .pi/settings.json).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildLlmGatewayModelsDoc,
  diffModelsDoc,
  type GatewayModelEntry,
  isLlmGatewayApiResponse,
  type ModelsJsonDoc,
  mapLlmGatewayModels,
  parseLlmGatewayApiKeyFromAuthJson,
  serializeModelsJsonDoc,
} from "../src/llmgateway-models.js";

const API_URL = "https://api.llmgateway.io/v1/models";

interface ParsedArgs {
  dryRun: boolean;
  print: boolean;
  requireKey: boolean;
  minModels: number;
  outPath: string;
}

type ParseResult = { ok: true; value: ParsedArgs } | { ok: false; error: string };

type LoadResult =
  | {
      ok: true;
      models: GatewayModelEntry[];
      serialized: string;
      summary: string;
    }
  | { ok: false; error: string };

/** Read the llmgateway API key: env first, then auth.json, else undefined. */
function readLlmGatewayApiKey(env: NodeJS.ProcessEnv, authJsonPath: string): string | undefined {
  const envKey = env.LLMGATEWAY_API_KEY;
  if (typeof envKey === "string") {
    const trimmed = envKey.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (!existsSync(authJsonPath)) return undefined;
  try {
    return parseLlmGatewayApiKeyFromAuthJson(readFileSync(authJsonPath, "utf8"));
  } catch {
    return undefined;
  }
}

function parseArgs(args: string): ParseResult {
  const tokens = args.split(/\s+/).filter((token) => token.length > 0);
  const result: ParsedArgs = {
    dryRun: false,
    print: false,
    requireKey: false,
    minModels: 10,
    outPath: join(homedir(), ".pi", "agent", "models.json"),
  };

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    const applied = applyFlag(result, token, tokens[index + 1], index);
    if (!applied.ok) return { ok: false, error: applied.error };
    index = applied.nextIndex;
  }

  return { ok: true, value: result };
}

type FlagApplyResult = { ok: true; nextIndex: number } | { ok: false; error: string };

/** Apply a single command-line flag to `result`, returning the next token index. */
function applyFlag(
  result: ParsedArgs,
  token: string,
  nextToken: string | undefined,
  index: number,
): FlagApplyResult {
  switch (token) {
    case "--dry-run":
      result.dryRun = true;
      return { ok: true, nextIndex: index + 1 };
    case "--print":
      result.print = true;
      return { ok: true, nextIndex: index + 1 };
    case "--require-key":
      result.requireKey = true;
      return { ok: true, nextIndex: index + 1 };
    case "--out": {
      if (nextToken === undefined || nextToken.startsWith("--"))
        return { ok: false, error: "--out requires a path" };
      result.outPath = isAbsolute(nextToken) ? nextToken : resolve(nextToken);
      return { ok: true, nextIndex: index + 2 };
    }
    case "--min-models": {
      if (nextToken === undefined || nextToken.startsWith("--"))
        return { ok: false, error: "--min-models requires an integer" };
      if (!/^\d+$/.test(nextToken))
        return { ok: false, error: "--min-models must be a non-negative integer" };
      result.minModels = Number.parseInt(nextToken, 10);
      return { ok: true, nextIndex: index + 2 };
    }
    default:
      return { ok: false, error: `unknown flag: ${token}` };
  }
}

/** Fetch the API models list and decode it into a LlmGatewayApiResponse. */
async function fetchApiPayload(
  apiKey: string | undefined,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(API_URL, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `failed to fetch ${API_URL}: ${message}` };
  }

  const text = await response.text();
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status} from ${API_URL}: ${text.slice(0, 200)}` };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: `non-JSON response from ${API_URL}` };
  }
}

/** Read an existing models.json document from disk, if present and valid. */
function readExistingDoc(outPath: string): ModelsJsonDoc | undefined {
  if (!existsSync(outPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(outPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const providers = (parsed as Record<string, unknown>).providers;
    if (typeof providers !== "object" || providers === null) return undefined;
    const gateway = (providers as Record<string, unknown>).llmgateway;
    if (typeof gateway !== "object" || gateway === null) return undefined;
    const models = (gateway as Record<string, unknown>).models;
    if (!Array.isArray(models)) return undefined;
    return parsed as unknown as ModelsJsonDoc;
  } catch {
    return undefined;
  }
}

/** Fetch, validate, and map the API payload into a serialized models doc. */
async function loadModels(options: ParsedArgs, apiKey: string | undefined): Promise<LoadResult> {
  const fetched = await fetchApiPayload(apiKey);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  if (!isLlmGatewayApiResponse(fetched.value)) {
    return { ok: false, error: "unexpected API response shape" };
  }
  const models = mapLlmGatewayModels(fetched.value);
  if (models.length < options.minModels) {
    return {
      ok: false,
      error: `only ${models.length} models (min ${options.minModels}); refusing to write`,
    };
  }
  const doc = buildLlmGatewayModelsDoc(models);
  const summary = diffModelsDoc(readExistingDoc(options.outPath), doc);
  return { ok: true, models, serialized: serializeModelsJsonDoc(doc), summary };
}

/** Refresh the in-memory model registry. Returns a warning message on failure. */
async function refreshRegistry(ctx: ExtensionCommandContext): Promise<string | undefined> {
  try {
    const refresh = await ctx.modelRegistry.refresh();
    if (refresh.aborted || refresh.errors.size > 0) {
      return "models written, but the in-memory model registry refresh did not complete cleanly";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `models written, but the in-memory model registry refresh failed (${message}); restart pi to pick up changes`;
  }
  return undefined;
}

export default function llmgatewayRefresh(pi: ExtensionAPI): void {
  pi.registerCommand("llmgateway-refresh", {
    description: "Refresh LLM Gateway models into ~/.pi/agent/models.json",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parsed = parseArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      const options = parsed.value;

      const authJsonPath = join(homedir(), ".pi", "agent", "auth.json");
      const apiKey = readLlmGatewayApiKey(process.env, authJsonPath);
      if (options.requireKey && apiKey === undefined) {
        ctx.ui.notify(
          "no API key found (set LLMGATEWAY_API_KEY or add an 'llmgateway' " +
            "api_key to ~/.pi/agent/auth.json)",
          "error",
        );
        return;
      }

      const loaded = await loadModels(options, apiKey);
      if (!loaded.ok) {
        ctx.ui.notify(loaded.error, "error");
        return;
      }

      if (options.print) {
        pi.sendMessage({
          customType: "llmgateway-refresh",
          content: loaded.serialized,
          display: true,
        });
        return;
      }

      if (options.dryRun) {
        ctx.ui.notify(
          `${loaded.models.length} models would be written to ${options.outPath}. ${loaded.summary}`,
        );
        return;
      }

      await writeModels(options, loaded.models.length, loaded.serialized, loaded.summary, ctx);
    },
  });
}

/** Write the serialized doc atomically, warn on out-of-tree paths, then refresh. */
async function writeModels(
  options: ParsedArgs,
  modelCount: number,
  serialized: string,
  summary: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const defaultAgentDir = dirname(join(homedir(), ".pi", "agent", "models.json"));
  const inDefaultDir = options.outPath.startsWith(`${defaultAgentDir}/`);
  const isDefaultPath = options.outPath === join(defaultAgentDir, "models.json");
  if (!inDefaultDir && !isDefaultPath) {
    ctx.ui.notify(
      `--out ${options.outPath} is outside ${defaultAgentDir}; pi only auto-loads the default models.json path`,
      "warning",
    );
  }

  mkdirSync(dirname(options.outPath), { recursive: true });
  const tmpPath = `${options.outPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, serialized, "utf-8");
  renameSync(tmpPath, options.outPath);

  // A registry refresh failure is a warning, not a total failure — the
  // file is already written and a future pi start will pick it up.
  const warning = await refreshRegistry(ctx);
  if (warning !== undefined) ctx.ui.notify(warning, "warning");

  ctx.ui.notify(`wrote ${modelCount} models to ${options.outPath}. ${summary}`, "info");
}
