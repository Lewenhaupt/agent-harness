/**
 * Agent process spawner.
 *
 * Spawns a separate pi process with the agent's configuration, streams JSON
 * events back to the caller, and tracks usage statistics.
 *
 * The spawn path is split into three stages so callers can launch a child in
 * the background and collect its result later:
 *
 * - `buildSpawnArgs` resolves everything needed before the process starts.
 * - `launchAgentProcess` starts the child and returns a handle immediately.
 * - `collectSpawnResult` resolves once the child exits (or fails to start).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions, SpawnResult, SpawnUsage } from "./agent-registry.js";
import { setupWorktree } from "./worktree.js";

/** Cached path to the pi binary, resolved once. */
let cachedPiBinary: string | undefined;

/** Everything needed to launch the child, resolved up front. */
export interface BuiltSpawnArgs {
  args: string[];
  sessionId: string;
  piBinary: string;
  worktreePath?: string;
  tempDir?: string;
  tempFile?: string;
}

/** Mutable stream state filled in as the child emits JSONL on stdout/stderr. */
export interface SpawnStream {
  messages: unknown[];
  usage: SpawnUsage;
  stderr: string;
}

/** A running (or runnable) child process plus the state needed to collect it. */
export interface AgentProcessHandle {
  proc: ChildProcess;
  stream: SpawnStream;
  built: BuiltSpawnArgs;
  cleanup: () => void;
}

/**
 * Build the spawn arguments and temp artifacts for an agent run.
 *
 * Worktree setup, session-id fallback, argv construction, system-prompt temp
 * file, and pi-binary resolution all happen here so `launchAgentProcess` can
 * spawn synchronously.
 */
export function buildSpawnArgs(options: SpawnOptions): BuiltSpawnArgs {
  const { model, tools, systemPrompt, task, sessionName, cwd, worktree } = options;

  // If worktree isolation is requested, set it up before spawning
  let worktreePath: string | undefined;
  if (worktree) {
    const root = cwd ?? process.cwd();
    worktreePath = setupWorktree(root, worktree);
  }

  // Build pi CLI args — persist sessions with deterministic IDs (bd session naming)
  const effectiveSessionId =
    sessionName ??
    `belayd-unknown-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const args: string[] = [
    "--mode",
    "json",
    "--session-id",
    effectiveSessionId,
    "--name",
    sessionName ?? effectiveSessionId,
  ];
  args.push("--model", model);
  args.push("--tools", tools.join(","));

  // Write system prompt to a temp file so we don't hit shell arg limits
  let tmpDir: string | undefined;
  let tmpFile: string | undefined;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "belayd-agent-"));
    tmpFile = join(tmpDir, "system-prompt.md");
    writeFileSync(tmpFile, systemPrompt, "utf-8");
    args.push("--append-system-prompt", tmpFile);

    // Add the task as the prompt argument
    args.push(task);

    return {
      args,
      sessionId: effectiveSessionId,
      piBinary: resolvePiBinary(),
      worktreePath,
      tempDir: tmpDir,
      tempFile: tmpFile,
    };
  } catch (error) {
    // Don't leak a partially created temp dir when the prompt write fails.
    if (tmpFile !== undefined) {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
    if (tmpDir !== undefined) {
      try {
        rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
}

/**
 * Launch the child process and start streaming its output.
 *
 * Returns a handle synchronously; callers collect the final result with
 * `collectSpawnResult`. The remaining partial stdout buffer is flushed on
 * `close` here (before `collectSpawnResult` resolves) so the two stages share
 * one source of truth in `handle.stream`.
 */
export function launchAgentProcess(
  options: SpawnOptions,
  built: BuiltSpawnArgs,
): AgentProcessHandle {
  const stream: SpawnStream = {
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    stderr: "",
  };

  // We intentionally do NOT call proc.unref(): a background phase run must keep
  // the parent pi process alive until it completes, otherwise the run would be
  // killed when the tool-call turn finishes.
  const proc = spawn(built.piBinary, built.args, {
    cwd: built.worktreePath ?? options.cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: options.detached === true,
  });

  let buffer = "";
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

  proc.stdout.on("data", (data: Buffer) => {
    buffer = processChunk(data, buffer, stream.messages, stream.usage);
  });

  // Drain stderr to prevent deadlock
  proc.stderr.on("data", (data: Buffer) => {
    stream.stderr += data.toString();
  });

  proc.on("close", () => {
    // Clear SIGKILL backup timer if process exited normally
    if (sigkillTimer) clearTimeout(sigkillTimer);

    // Process remaining buffer before collectSpawnResult reads the stream
    flushBuffer(buffer, stream.messages, stream.usage);
  });

  // Handle abort signal
  if (options.signal) {
    if (options.signal.aborted) {
      proc.kill("SIGTERM");
    } else {
      options.signal.addEventListener(
        "abort",
        () => {
          proc.kill("SIGTERM");
          sigkillTimer = setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        },
        { once: true },
      );
    }
  }

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (built.tempFile !== undefined) {
      try {
        unlinkSync(built.tempFile);
      } catch {
        /* ignore */
      }
    }
    if (built.tempDir !== undefined) {
      try {
        rmdirSync(built.tempDir);
      } catch {
        /* ignore */
      }
    }
  };

  return { proc, stream, built, cleanup };
}

/**
 * Resolve once the launched process exits (or fails to start).
 *
 * The `close` listener registered by `launchAgentProcess` flushes any partial
 * stdout line before this promise resolves, so the stream is already final
 * here. Cleanup runs exactly once, on both success and failure.
 */
export function collectSpawnResult(handle: AgentProcessHandle): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    let settled = false;

    handle.proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn pi: ${err.message}`));
    });

    handle.proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;

      const messages = handle.stream.messages;
      const usedModel = extractFinalMessages(messages);
      const finalContent = extractFinalContent(messages);

      resolve({
        content: [{ type: "text" as const, text: finalContent || "(no output)" }],
        details: {
          messages,
          usage: handle.stream.usage,
          // A signal-killed child (e.g. aborted run) must read as a failure,
          // never as exitCode 0 success.
          exitCode: code ?? (signal ? 128 : 0),
          model: usedModel,
          stderr: handle.stream.stderr || undefined,
        },
        worktreePath: handle.built.worktreePath,
        sessionName: handle.built.sessionId,
      });
    });
  }).finally(() => {
    handle.cleanup();
  });
}

/**
 * Spawn an isolated pi process for an agent and return structured results.
 *
 * @param options - Agent configuration and task
 * @returns Structured result with content and usage details
 */
export async function spawnAgentProcess(options: SpawnOptions): Promise<SpawnResult> {
  const built = buildSpawnArgs(options);
  const handle = launchAgentProcess(options, built);
  return collectSpawnResult(handle);
}

/**
 * Process a chunk of JSONL data from a pi process stdout.
 * Returns the remaining partial buffer.
 */
function processChunk(
  data: Buffer,
  buffer: string,
  messages: unknown[],
  usage: SpawnUsage,
): string {
  let buf = buffer + data.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    trackEvent(event, messages, usage);
  }

  return buf;
}

/** Track usage from a pi JSON event. */
function trackEvent(event: Record<string, unknown>, messages: unknown[], usage: SpawnUsage): void {
  if (event.type === "message_end" && event.message) {
    const msg = event.message as Record<string, unknown>;
    messages.push(msg);

    if (msg.role === "assistant") {
      usage.turns++;
      const eventUsage = msg.usage as
        | {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            cost?: { total?: number };
            totalTokens?: number;
          }
        | undefined;
      if (eventUsage) {
        usage.input += eventUsage.input ?? 0;
        usage.output += eventUsage.output ?? 0;
        usage.cacheRead += eventUsage.cacheRead ?? 0;
        usage.cacheWrite += eventUsage.cacheWrite ?? 0;
        usage.cost += eventUsage.cost?.total ?? 0;
      }
    }
  }

  if (event.type === "tool_result_end" && event.message) {
    messages.push(event.message);
  }
}

/** Parse any remaining data in the buffer. */
function flushBuffer(buffer: string, messages: unknown[], usage: SpawnUsage): void {
  const trimmed = buffer.trim();
  if (!trimmed) return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  trackEvent(event, messages, usage);
}

/** Extract final assistant content from messages. */
function extractFinalContent(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as {
      role?: string;
      content?: string | Array<{ type: string; text: string }>;
    };
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((c) => c.type === "text").map((c) => c.text);
        if (textParts.length > 0) {
          return textParts.join("\n");
        }
      }
    }
  }
  return "";
}

/** Extract final messages and update usage. Returns the model name if found. */
function extractFinalMessages(messages: unknown[]): string | undefined {
  for (const msg of messages) {
    const m = msg as { role?: string; model?: string };
    if (m.role === "assistant") {
      if (m.model) return m.model;
    }
  }
  return undefined;
}

/** Resolve the pi binary path. */
function resolvePiBinary(): string {
  if (cachedPiBinary) return cachedPiBinary;

  // Try PATH first
  const piPath = process.env.PI_BINARY_PATH;
  if (piPath && existsSync(piPath)) {
    cachedPiBinary = piPath;
    return piPath;
  }

  // Try nix store
  const nixPi = "/run/current-system/sw/bin/pi";
  if (existsSync(nixPi)) {
    cachedPiBinary = nixPi;
    return nixPi;
  }

  // Try common install locations
  const candidates = [
    join(process.env.HOME ?? "/home", ".npm-global/bin/pi"),
    join(process.env.HOME ?? "/home", ".local/bin/pi"),
    join(process.env.HOME ?? "/home", "node_modules/.bin/pi"),
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedPiBinary = candidate;
      return candidate;
    }
  }

  cachedPiBinary = "pi";
  return "pi";
}
