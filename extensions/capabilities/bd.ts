/**
 * bd (beads) capability: the `bd` CLI proxy tool (bd-179).
 *
 * Kept out of the composer so bead-tracker changes cannot touch workflow or
 * fleet state; the session-actor attribution seam is injected.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { bdCommandReadsStdin, validateBdCommand } from "../../src/bd-command.js";
import { emptyUsage, runBdCommand } from "./context.js";

/** Session-scoped seams the composer supplies. */
export interface BdToolDeps {
  /** Attribute a validated argv to this session's beads actor (bd-150). */
  attributeBdArgv: (argv: readonly string[], ctx: unknown) => readonly string[];
}

/**
 * Register the `bd` proxy tool; the composer supplies the actor seam.
 *
 * The process gate disables bash so editing tools cannot be abused, but task
 * tracking still needs the bd CLI: this proxies bd through a safe subcommand
 * allowlist so the orchestrator can manage beads without raw shell access.
 */
export function registerBdTool(pi: ExtensionAPI, deps: BdToolDeps): void {
  pi.registerTool({
    name: "bd",
    label: "Beads task tracker",
    description:
      "Run a beads (bd) CLI command for task tracking. Restricted to safe " +
      "subcommands (create, update, label, note, show, search, list, ready, " +
      "prime, remember, and similar). Cannot close, delete, or edit issues. " +
      "Multiline content is supported: quote arguments containing spaces or " +
      "newlines, or pass content via the `stdin` parameter together with " +
      "`--stdin` (recommended for long notes/descriptions).",
    parameters: Type.Object({
      command: Type.String({
        description:
          'Full bd command including subcommand and flags, e.g. "create --title=\\"Fix login\\" --type=bug" or "list --status=open"',
      }),
      stdin: Type.Optional(
        Type.String({
          description:
            "Content piped to bd's stdin. Pair with `--stdin` (or `--file -` / `--body-file -`) to write multiline notes, descriptions, or comments without shell quoting or argv length limits.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validation = validateBdCommand(params.command);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: validation.error }],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }

      const stdin = params.stdin;
      if (stdin !== undefined && stdin !== "" && !bdCommandReadsStdin(validation.argv)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "bd command received a `stdin` payload but has no flag that reads stdin. " +
                "Append `--stdin` (or `--file -` / `--body-file -`) so bd consumes it.",
            },
          ],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }

      const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      // Attribute the write to the workflow actor (bd-150). A caller-supplied
      // `--actor` still wins: this default sits at index 1 and bd's last flag
      // wins. `--claim` stays rejected above, which is what keeps assign legal.
      const argv = deps.attributeBdArgv(validation.argv, ctx);
      try {
        const { stdout, stderr } = await runBdCommand(argv, {
          cwd,
          stdin,
          timeoutInMs: 30_000,
          maxBufferInBytes: 1024 * 1024,
        });
        const text = stdout.trim() || stderr.trim() || "(no output)";
        return {
          content: [{ type: "text" as const, text }],
          details: {
            messages: [],
            usage: emptyUsage(),
            exitCode: 0,
            ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `bd command failed: ${message}` }],
          details: { messages: [], usage: emptyUsage(), exitCode: 1 },
        };
      }
    },
  });
}
