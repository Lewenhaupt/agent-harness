/**
 * unslop capability (bd-253): the ad-hoc `belayd_unslop` UI-design tool.
 *
 * The unslop skill needs two things a bare session cannot guarantee: a rendered
 * screenshot of the screen and a vision read of it. This tool spawns a child
 * with `unslop-snapshot` on PATH and `describe_image` in its allowlist, so the
 * audit is always grounded in what actually rendered.
 *
 * The spawn is blocking (`detached: false`), like the proof verifier: the
 * orchestrator must be able to show the audit and the direction lines to the
 * human in the same turn, because pass 2 cannot start without that answer.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { UNSLOP_AGENT, UNSLOP_TOOLS } from "../../src/agent-registry.js";
import type { CapacityCache } from "../../src/capacity-cache.js";
import { resolveModelSpec } from "../../src/model-classes.js";
import type { ModelCooldownStore } from "../../src/model-cooldown.js";
import type { ModelTelemetryStore } from "../../src/model-telemetry.js";
import { generateShortRunId } from "../../src/session-naming.js";
import type { SpawnWithFallbackOptions } from "../../src/spawn-with-fallback.js";
import { missingWorkingDirectoryError, textToolResult } from "./context.js";

/** Model-routing seams the composer owns (bd-116 session state). */
export interface UnslopModelRouting {
  cooldownStore: ModelCooldownStore;
  enabled: boolean;
  telemetry: ModelTelemetryStore;
  capacity: CapacityCache;
}

/** Everything the unslop capability needs from the composer. */
export interface UnslopDeps {
  /** Injected because the extension test suite swaps it through the barrel mock. */
  spawnAgentWithFallback: (options: SpawnWithFallbackOptions) => Promise<{
    result: { content?: readonly { text?: string }[] };
  }>;
  modelRouting: UnslopModelRouting;
}

/**
 * The child's task.
 *
 * The steer is passed through verbatim: the tool cannot know which pass a run is
 * in, so "audit only" or "apply the confirmed direction" is the caller's job. The
 * two-pass contract in the system prompt is what keeps pass 1 from editing.
 */
export function buildUnslopTask(options: { task: string; cwd: string }): string {
  return ["## Task", "", options.task, "", `Working directory: ${options.cwd}`].join("\n");
}

/**
 * Run the unslop agent; every path returns text.
 *
 * A failed spawn is reported as values rather than thrown: the orchestrator shows
 * the human the audit, and "the agent could not run" must reach the same place,
 * not abort the turn — but it must stay distinguishable from a real audit, which
 * is what the failure arm carries into the tool's exit code.
 */
export async function runUnslop(options: {
  deps: UnslopDeps;
  task: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const { deps } = options;
  const model = resolveModelSpec(UNSLOP_AGENT);
  try {
    const result = await deps.spawnAgentWithFallback({
      model: model.model,
      modelClass: UNSLOP_AGENT.modelClass,
      tools: UNSLOP_TOOLS,
      systemPrompt: UNSLOP_AGENT.systemPrompt,
      task: buildUnslopTask({ task: options.task, cwd: options.cwd }),
      sessionName: `belayd-unslop-${generateShortRunId()}`,
      cwd: options.cwd,
      signal: options.signal,
      // Blocking on purpose: the audit and the direction must be in this turn.
      detached: false,
      cooldownStore: deps.modelRouting.cooldownStore,
      enabled: deps.modelRouting.enabled,
      phase: "unslop",
      telemetry: deps.modelRouting.telemetry,
      capacity: deps.modelRouting.capacity,
    });
    return {
      ok: true,
      text: result.result.content?.[0]?.text ?? "The unslop agent produced no output.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unslop agent could not run: ${message}` };
  }
}

/** Register `belayd_unslop`; the composer supplies the pi API and spawn seam. */
export function registerUnslop(pi: ExtensionAPI, deps: UnslopDeps): void {
  pi.registerTool({
    name: "belayd_unslop",
    label: "unslop UI design",
    description:
      "Remove AI-generated UI tells from ONE named screen and give it a product-owned direction. " +
      "Pass 1 renders the screen, audits it and returns ## Audit + ## Direction for a human to " +
      "confirm; call again with the confirmed direction to apply the passes. Blocks until the " +
      "child returns.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The screen to work on (file path or URL) plus any steer, e.g. which pass to run or " +
          "the confirmed direction.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      if (cwd === undefined || cwd === "") {
        return textToolResult(missingWorkingDirectoryError("belayd_unslop"), 1);
      }
      const result = await runUnslop({ deps, task: params.task, cwd, signal });
      return result.ok ? textToolResult(result.text, 0) : textToolResult(result.error, 1);
    },
  });
}
