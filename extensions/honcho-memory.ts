/**
 * Honcho memory pi extension — standalone entry point for bundling.
 *
 * Reads agent memory from (and writes it back to) Honcho. When HONCHO_API_KEY
 * is absent the whole extension is a no-op, so this ships safely in the same
 * global + project-local configurations as stale-file-guard and degrades to
 * "no memory" rather than failing sessions.
 *
 * The read path hooks `before_agent_start` in the sub-agent's own extension
 * instance (not buildSpawnArgs) so the async Honcho round-trip never ripples
 * through the spawn pipeline. The write path hooks `agent_end` to capture the
 * sub-agent's final assistant text.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  buildMemoryQuery,
  createHonchoClient,
  createHonchoMemoryController,
  derivePhaseName,
  deriveSessionId,
  type HonchoMemoryController,
  type HonchoMessage,
  isBelaydSubAgentSession,
  readHonchoConfig,
} from "../src/index.js";

// The same guard ships globally (~/.pi/agent/extensions/belayd-honcho-memory.ts)
// and project-locally (.pi/settings.json). When both load in one process the
// event handlers would be registered twice. The process-wide marker dedupes:
// the first copy wins, the second returns before registering handlers.
const HONCHO_MEMORY_LOAD_MARKER = "__belayd_honcho_memory_loaded__";

function honchoMemoryAlreadyLoaded(): boolean {
  return (globalThis as Record<string, unknown>)[HONCHO_MEMORY_LOAD_MARKER] === true;
}

function markHonchoMemoryLoaded(): void {
  (globalThis as Record<string, unknown>)[HONCHO_MEMORY_LOAD_MARKER] = true;
}

// Skip trivial/no-op sub-agent answers so the memory store stays free of noise.
const MIN_RECORDED_OUTPUT_CHARS = 80;

type AgentEndMessage = AgentEndEvent["messages"][number];

/** Extract the visible text from one assistant message's content blocks. */
function textOfMessage(message: AgentEndMessage): string {
  if (message.role !== "assistant") return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim();
}

/** Extract the final assistant text from the agent_end message list. */
function extractFinalAssistantText(messages: AgentEndMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const text = textOfMessage(message);
    if (text !== "") return text;
  }
  return undefined;
}

/**
 * Resolve the before_agent_start result for one turn. Retrieval is
 * best-effort: any failure returns {} so the agent still starts.
 */
async function injectHonchoMemory(
  controller: HonchoMemoryController,
  config: { value: { peerId: string } },
  event: BeforeAgentStartEvent,
  ctx: {
    sessionManager: { getSessionName: () => string | undefined };
    model: { id: string } | undefined;
  },
): Promise<BeforeAgentStartEventResult> {
  try {
    const sessionName = ctx.sessionManager.getSessionName() ?? "";
    const agentName = ctx.model?.id ?? "";
    const query = buildMemoryQuery(event.prompt, agentName, sessionName);

    const memory = await controller.retrieve(
      deriveSessionId(sessionName),
      config.value.peerId,
      query,
    );

    if (memory !== undefined) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Project memory (Honcho)\n${memory}\n`,
      };
    }
  } catch {
    // Retrieval is best-effort: a failure must never block the agent.
  }
  return {};
}

/** Read the optional auth.json text for API-key resolution (mirrors llmgateway). */
function readAuthJsonText(): string | undefined {
  const authJsonPath = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(authJsonPath)) return undefined;
  try {
    return readFileSync(authJsonPath, "utf8");
  } catch {
    return undefined;
  }
}

export default function honchoMemoryExtension(pi: ExtensionAPI): void {
  if (honchoMemoryAlreadyLoaded()) return;
  markHonchoMemoryLoaded();

  const config = readHonchoConfig(process.env, {
    cwd: process.cwd(),
    authJsonText: readAuthJsonText(),
  });
  if (!config.ok) {
    // Only the missing-key case is worth a one-time warning; the explicit
    // kill switch (HONCHO_ENABLED=0) is intentional silence.
    if (config.reason === "missing_api_key") {
      console.warn(`[honcho-memory] ${config.message}`);
    }
    return;
  }

  const controller: HonchoMemoryController = createHonchoMemoryController(
    config.value,
    createHonchoClient(config.value, { fetch }),
  );

  // Relies on pi awaiting this handler and applying the returned systemPrompt
  // before the agent loop — the same contract extensions/index.ts already uses
  // to inject gate/planning context each turn, so it is verified, not assumed.
  pi.on("before_agent_start", async (event, ctx) =>
    injectHonchoMemory(controller, config, event, ctx),
  );

  pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
    try {
      const sessionName = ctx.sessionManager.getSessionName() ?? "";
      if (!isBelaydSubAgentSession(sessionName)) return;

      const text = extractFinalAssistantText(event.messages);
      if (text === undefined || text.length < MIN_RECORDED_OUTPUT_CHARS) return;

      const phase = derivePhaseName(sessionName);
      const taskId = deriveSessionId(sessionName);
      const message: HonchoMessage = {
        content: text,
        peerId: config.value.peerId,
        metadata: {
          source: "belayd",
          phase: phase ?? "",
          taskId,
          sessionName,
          agent: ctx.model?.id ?? "",
        },
      };

      await controller.record(deriveSessionId(sessionName), [message]);
    } catch {
      // Writes are best-effort: a Honcho outage must not fail the agent run.
    }
  });

  pi.on("session_shutdown", () => {
    controller.reset();
  });
}
