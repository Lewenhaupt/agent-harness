/**
 * bd (beads) capability: the `bd` CLI proxy tool (bd-179).
 *
 * Kept out of the composer so bead-tracker changes cannot touch workflow or
 * fleet state; the session-actor attribution seam is injected.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { bdCommandReadsStdin, parseBdCommand, validateBdCommand } from "../../src/bd-command.js";
import { classifyBdWriteForAuthority } from "../../src/github-append-policy.js";
import { emptyUsage, runBdCommand } from "./context.js";

/** Where the repo's authority landed, or why it could not be resolved. */
export type BdAuthorityResolution =
  | { ok: true; authority: "bd" | "github" }
  | { ok: false; error: string };

/** Session-scoped seams the composer supplies. */
export interface BdToolDeps {
  /** Attribute a validated argv to this session's beads actor (bd-150). */
  attributeBdArgv: (argv: readonly string[], ctx: unknown) => readonly string[];
  /** Resolve the repo's authority from session context (bd-180); absent means local mode. */
  resolveAuthority?: (ctx: unknown) => BdAuthorityResolution;
  /** True when this session is a phase sub-agent (bd-180 append-only policy). */
  isPhaseSession?: (ctx: unknown) => boolean;
}

/**
 * The refusal message for a phase sub-agent's write, or undefined when the write
 * is allowed. Kept out of `execute` so the tool callback stays readable.
 *
 * Only a phase session in a GitHub-primary repo is checked; the human-facing
 * orchestrator is exempt, and an ambiguous authority refuses rather than
 * narrowing to local mode.
 */
function phaseWriteRefusal(input: {
  argv: readonly string[];
  ctx: unknown;
  deps: BdToolDeps;
}): string | undefined {
  if (input.deps.isPhaseSession?.(input.ctx) !== true) return undefined;
  const resolved: BdAuthorityResolution = input.deps.resolveAuthority?.(input.ctx) ?? {
    ok: true,
    authority: "bd",
  };
  if (!resolved.ok) {
    return `bd write refused: ${resolved.error}`;
  }
  const policy = classifyBdWriteForAuthority({
    argv: input.argv,
    authority: resolved.authority,
  });
  return policy.verdict === "refused" ? `bd write refused: ${policy.message}` : undefined;
}

/**
 * Authority refusal for a command that bd's own validation already rejects.
 *
 * `close` never reaches the normal policy path because the bd tool's allowlist
 * rejects it first, which used to hide the authority-facing reason in a
 * GitHub-primary repo. Parsing the command here lets the policy name GitHub as
 * the owner while local/orchestrator sessions keep the original validation
 * error byte-for-byte.
 */
function authorityRefusalForCommand(
  command: string,
  ctx: unknown,
  deps: BdToolDeps,
): string | undefined {
  if (command.trim() === "" || command.includes("\u0000")) return undefined;
  const parsed = parseBdCommand(command);
  if (!parsed.ok || parsed.argv.length === 0) return undefined;
  return phaseWriteRefusal({ argv: parsed.argv, ctx, deps });
}

/** A tool result carrying a refusal, in the shape every error path uses. */
function toolError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { messages: [], usage: emptyUsage(), exitCode: 1 },
  };
}

/** The stdin-contract refusal, or undefined when the command may run. */
function stdinRefusal(stdin: string | undefined, argv: readonly string[]): string | undefined {
  if (stdin === undefined || stdin === "") return undefined;
  if (bdCommandReadsStdin(argv)) return undefined;
  return (
    "bd command received a `stdin` payload but has no flag that reads stdin. " +
    "Append `--stdin` (or `--file -` / `--body-file -`) so bd consumes it."
  );
}

/** A command that passed every pre-execution guard. */
type PreparedBdCommand =
  | { ok: true; argv: readonly string[]; stdin: string | undefined; cwd: string }
  | { ok: false; error: string };

/**
 * Validate, attribute and policy-check one bd command before it spawns.
 * Extracted from `execute` so the tool callback stays below the complexity
 * limit; the order is load-bearing: the authority reason overrides a generic
 * allowlist rejection only for a phase session in a GitHub-primary repo.
 */
function prepareBdCommand(
  params: { command: string; stdin?: string },
  ctx: unknown,
  deps: BdToolDeps,
): PreparedBdCommand {
  const validation = validateBdCommand(params.command);
  if (!validation.ok) {
    return {
      ok: false,
      error: authorityRefusalForCommand(params.command, ctx, deps) ?? validation.error,
    };
  }
  const stdin = params.stdin;
  const stdinError = stdinRefusal(stdin, validation.argv);
  if (stdinError !== undefined) return { ok: false, error: stdinError };
  const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
  const refusal = phaseWriteRefusal({ argv: validation.argv, ctx, deps });
  if (refusal !== undefined) return { ok: false, error: refusal };
  return { ok: true, argv: validation.argv, stdin, cwd };
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
      const prepared = prepareBdCommand(params, ctx, deps);
      if (!prepared.ok) return toolError(prepared.error);

      // Attribute the write to the workflow actor (bd-150). A caller-supplied
      // `--actor` still wins: this default sits at index 1 and bd's last flag
      // wins. `--claim` stays rejected above, which is what keeps assign legal.
      const argv = deps.attributeBdArgv(prepared.argv, ctx);
      try {
        const { stdout, stderr } = await runBdCommand(argv, {
          cwd: prepared.cwd,
          stdin: prepared.stdin,
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
