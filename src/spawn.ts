/**
 * Agent process spawner.
 *
 * Spawns a separate pi process with the agent's configuration, streams JSON
 * events back to the caller, and tracks usage statistics.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions, SpawnResult, SpawnUsage } from "./agent-registry.js";
import { setupWorktree } from "./worktree.js";

/** Cached path to the pi binary, resolved once. */
let cachedPiBinary: string | undefined;

/**
 * Spawn an isolated pi process for an agent and return structured results.
 *
 * @param options - Agent configuration and task
 * @returns Structured result with content and usage details
 */
export async function spawnAgentProcess(options: SpawnOptions): Promise<SpawnResult> {
  const { model, tools, systemPrompt, task, sessionName, cwd, signal, worktree } = options;

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

    // Resolve pi binary
    const piBinary = resolvePiBinary();

    // Usage tracking
    const usage: SpawnUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    };
    const messages: unknown[] = [];
    let usedModel: string | undefined;

    // Spawn the process
    const result = await new Promise<SpawnResult>((resolve, reject) => {
      const proc = spawn(piBinary, args, {
        cwd: worktreePath ?? cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      let buffer = "";
      let stderr = "";
      let exitCode = 0;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      proc.stdout.on("data", (data: Buffer) => {
        buffer = processChunk(data, buffer, messages, usage);
      });

      // Drain stderr to prevent deadlock
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        // Clear SIGKILL backup timer if process exited normally
        if (sigkillTimer) clearTimeout(sigkillTimer);

        // Process remaining buffer
        flushBuffer(buffer, messages, usage);

        exitCode = code ?? 0;
        usedModel = extractFinalMessages(messages);

        const finalContent = extractFinalContent(messages);

        resolve({
          content: [{ type: "text" as const, text: finalContent || "(no output)" }],
          details: {
            messages,
            usage,
            exitCode,
            model: usedModel,
            stderr: stderr || undefined,
          },
          worktreePath,
          sessionName: effectiveSessionId,
        });
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn pi: ${err.message}`));
      });

      // Handle abort signal
      if (signal) {
        if (signal.aborted) {
          proc.kill("SIGTERM");
        } else {
          signal.addEventListener(
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
    });

    return result;
  } finally {
    // Clean up temp files
    if (tmpFile) {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
    if (tmpDir) {
      try {
        rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }
  }
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
