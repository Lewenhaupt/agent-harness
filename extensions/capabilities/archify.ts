/**
 * Archify capability: the `belayd_archify` consult tool (bd-179).
 *
 * Compiles a typed JSON IR into a self-contained interactive HTML diagram, plus
 * read-only guidance subcommands. Grouped here rather than in the composer so a
 * change to diagram generation cannot touch the workflow/fleet core.
 */
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_GUIDANCE_COMMANDS,
  ARCHIFY_QUALITY_PROFILES,
  ARCHIFY_TOOL_COMMANDS,
  type ArchifyCommand,
  type ArchifyDiagramType,
  type ArchifyQuality,
  type ArchifyTextResult,
  buildArchifyArgs,
  buildArchifyCheckArgs,
  buildArchifyGuideArgs,
  buildArchifyInspectArgs,
  formatArchifyIgnoredParamsNote,
  formatArchifyResult,
  ignoredArchifyParams,
  isArchifyDiagramType,
  isArchifyQuality,
  isArchifyToolCommand,
  listArchifyExamples,
  resolveArchifyHome,
  runArchify,
  runArchifyText,
} from "../../src/archify.js";
import { textToolResult } from "./context.js";

/** Raw `belayd_archify` parameters before validation/defaults. */
export interface ArchifyRawParams {
  type?: string;
  input?: string;
  output?: string;
  command?: string;
  quality?: string;
  repoRoot?: string;
  scenario?: string;
}

/**
 * A validated `belayd_archify` invocation, tagged by the work to perform.
 * `diagram` covers the original render/validate/deliver path; the rest are
 * read-only guidance commands. `inspect` is modeled with the literal
 * `architecture` type because archify only supports inspection of that IR.
 */
type ArchifyValidatedParams =
  | {
      kind: "diagram";
      command: ArchifyCommand;
      type: ArchifyDiagramType;
      quality: ArchifyQuality;
      input: string;
      output: string | undefined;
      repoRoot: string | undefined;
    }
  | { kind: "inspect"; type: "architecture"; input: string }
  | { kind: "check"; input: string }
  | { kind: "guide"; scenario: string | undefined }
  | { kind: "examples" };

type ArchifyParamValidation =
  | { ok: true; value: ArchifyValidatedParams }
  | { ok: false; error: string };

/** Validate render/validate/deliver params (the diagram-writing path). */
function validateDiagramParams(
  params: ArchifyRawParams,
  command: ArchifyCommand,
): ArchifyParamValidation {
  const type = params.type;
  if (type === undefined || !isArchifyDiagramType(type)) {
    return {
      ok: false,
      error: `Unknown diagram type: ${type ?? "(missing)"}. Supported types: ${ARCHIFY_DIAGRAM_TYPES.join(", ")}.`,
    };
  }

  const input = params.input;
  if (input === undefined || input === "") {
    return { ok: false, error: "input is required for render/validate/deliver commands." };
  }

  const quality = params.quality ?? "showcase";
  if (!isArchifyQuality(quality)) {
    return {
      ok: false,
      error: `Unknown quality profile: ${quality}. Supported profiles: ${ARCHIFY_QUALITY_PROFILES.join(", ")}.`,
    };
  }

  return {
    ok: true,
    value: {
      kind: "diagram",
      command,
      type,
      quality,
      input,
      output: params.output,
      repoRoot: params.repoRoot,
    },
  };
}

/** Validate `inspect`, which archify only exposes for architecture IRs. */
function validateInspectParams(params: ArchifyRawParams): ArchifyParamValidation {
  if (params.type !== "architecture") {
    return { ok: false, error: "inspect only supports the architecture type." };
  }
  const input = params.input;
  if (input === undefined || input === "") {
    return { ok: false, error: "input is required for command=inspect." };
  }
  return { ok: true, value: { kind: "inspect", type: "architecture", input } };
}

/** Validate `check`, which takes only the delivered artifact path. */
function validateCheckParams(params: ArchifyRawParams): ArchifyParamValidation {
  const input = params.input;
  if (input === undefined || input === "") {
    return { ok: false, error: "input is required for command=check." };
  }
  return { ok: true, value: { kind: "check", input } };
}

/**
 * Validate the raw `belayd_archify` params and apply command/quality defaults.
 *
 * Kept separate from the tool's `execute` so the rejection messages stay flat
 * (and the tool body stays under the cognitive-complexity budget). Per-command
 * rules live in small helpers dispatched from one switch.
 */
export function validateArchifyParams(params: ArchifyRawParams): ArchifyParamValidation {
  const command = params.command ?? "deliver";
  if (!isArchifyToolCommand(command)) {
    return {
      ok: false,
      error: `Unknown command: ${command}. Supported commands: ${ARCHIFY_TOOL_COMMANDS.join(", ")}.`,
    };
  }

  switch (command) {
    case "guide": {
      const scenario = params.scenario;
      // A leading `--` would be parsed by upstream as a flag, not a scenario.
      if (scenario?.startsWith("--")) {
        return {
          ok: false,
          error:
            "scenario must not start with `--` (archify would parse it as a flag); pass plain text.",
        };
      }
      return { ok: true, value: { kind: "guide", scenario } };
    }
    case "examples":
      return { ok: true, value: { kind: "examples" } };
    case "inspect":
      return validateInspectParams(params);
    case "check":
      return validateCheckParams(params);
    case "render":
    case "validate":
    case "deliver":
      return validateDiagramParams(params, command);
    default:
      return { ok: false, error: `Unknown command: ${command}.` };
  }
}

/** Shape a read-only guidance result (exit 1 on transport/parse failure). */
export function textResultFromRun(result: ArchifyTextResult, note: string) {
  const base = result.ok ? result.text : result.error;
  return textToolResult(`${base}${note}`, result.ok ? 0 : 1);
}

/** Exec options shared by every archify subcommand (renderer and guidance). */
export function archifyRunOptions(cwd: string) {
  return { cwd, timeoutInMs: 60_000, maxBufferInBytes: 8 * 1024 * 1024 };
}

/** Render/validate/deliver path: unchanged from bd-85. */
async function archifyDiagramToolResult(
  value: Extract<ArchifyValidatedParams, { kind: "diagram" }>,
  cwd: string,
) {
  const { type, command, quality, input, output, repoRoot } = value;
  const defaultOutput = join(cwd, "docs", "diagrams", `${type}.html`);

  // `validate` takes no output positional; only render/deliver write files.
  const args = buildArchifyArgs({
    command,
    type,
    input,
    output: command === "validate" ? undefined : (output ?? defaultOutput),
    quality,
    repoRoot,
  });

  const result = await runArchify(args, archifyRunOptions(cwd));
  const note =
    command === "validate" && output !== undefined
      ? "\n\nnote: `output` is ignored for `validate`; only render/deliver write files."
      : "";
  return textToolResult(
    `${formatArchifyResult(result)}${note}`,
    result.ok && result.receipt.ok ? 0 : 1,
  );
}

/**
 * Run one read-only guidance subcommand (`guide`/`inspect`/`check`/`examples`)
 * and shape its tool response. Split from `execute` so neither function
 * exceeds the cognitive-complexity budget.
 */
async function archifyGuidanceToolResult(
  value: Exclude<ArchifyValidatedParams, { kind: "diagram" }>,
  cwd: string,
  note: string,
) {
  switch (value.kind) {
    case "guide":
      return textResultFromRun(
        await runArchifyText(
          buildArchifyGuideArgs({ scenario: value.scenario }),
          archifyRunOptions(cwd),
        ),
        note,
      );
    case "inspect":
      return textResultFromRun(
        await runArchifyText(
          buildArchifyInspectArgs({ type: value.type, input: value.input }),
          archifyRunOptions(cwd),
        ),
        note,
      );
    case "check":
      return textResultFromRun(
        await runArchifyText(buildArchifyCheckArgs(value.input), archifyRunOptions(cwd)),
        note,
      );
    case "examples":
      return archifyExamplesToolResult(note);
  }
}

/**
 * `examples` lists the packaged IR files directly. Shelling out to
 * `archify examples` is not an option: it renders HTML into the read-only
 * Nix store at `$ARCHIFY_HOME/examples/`, which fails at runtime.
 */
export function archifyExamplesToolResult(note: string) {
  const home = resolveArchifyHome(process.env);
  if (!home.ok) return textToolResult(`${home.error}${note}`, 1);

  const listed = listArchifyExamples(home.home);
  if (!listed.ok) return textToolResult(`${listed.error}${note}`, 1);
  if (listed.examples.length === 0) {
    return textToolResult(`No example IRs found under ${home.home}/examples.${note}`, 0);
  }

  const lines = [
    `archify examples (${listed.examples.length}):`,
    ...listed.examples.map((path) => `  ${path}`),
  ];
  return textToolResult(`${lines.join("\n")}${note}`, 0);
}

/**
 * Register `belayd_archify`; the composer supplies the pi API.
 *
 * Archify compiles a typed JSON IR into one self-contained interactive HTML
 * diagram. It is opt-in (consult-callable) and non-phase, so it is listed in
 * GATED_TOOLS only to survive the process gate — never a required phase step,
 * and never in PLANNING_GATED_TOOLS. `visual-check` and `preview` are excluded
 * upstream subcommands.
 */
export function registerArchify(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "belayd_archify",
    label: "Archify diagram generator",
    description:
      "Compile a typed archify JSON IR into a self-contained interactive HTML " +
      `diagram. Types: ${ARCHIFY_DIAGRAM_TYPES.join(", ")}. Renderer commands: deliver ` +
      "(default: renders, validates, and writes), render, validate. Read-only guidance " +
      `commands: ${ARCHIFY_GUIDANCE_COMMANDS.join(", ")} — guide returns a recipe list, ` +
      "or a type/scenario recommendation when `scenario` is given; examples lists packaged " +
      "IRs, inspect dumps an architecture layout, check re-validates a delivered HTML. " +
      "Irrelevant params supplied to a guidance command are reported as ignored. " +
      "Authoring guidance lives in .agents/skills/archify/SKILL.md and `$ARCHIFY_HOME` " +
      "(SKILL.md, schemas/, examples/, references/). Output defaults to " +
      "<cwd>/docs/diagrams/<type>.html; committed diagrams live under docs/diagrams/.",
    parameters: Type.Object({
      type: Type.Optional(
        Type.Union(
          ARCHIFY_DIAGRAM_TYPES.map((diagramType) => Type.Literal(diagramType)),
          {
            description: `Diagram type: ${ARCHIFY_DIAGRAM_TYPES.join(", ")}`,
          },
        ),
      ),
      input: Type.Optional(
        Type.String({
          description: "Path to the archify JSON IR file (or an artifact for command=check)",
        }),
      ),
      output: Type.Optional(
        Type.String({
          description: "Output HTML path (default: <cwd>/docs/diagrams/<type>.html)",
        }),
      ),
      command: Type.Optional(
        Type.Union(
          ARCHIFY_TOOL_COMMANDS.map((archifyCommand) => Type.Literal(archifyCommand)),
          {
            description: `Archify command: deliver (default), render, validate, ${ARCHIFY_GUIDANCE_COMMANDS.join(", ")}`,
          },
        ),
      ),
      quality: Type.Optional(
        Type.Union(
          ARCHIFY_QUALITY_PROFILES.map((profile) => Type.Literal(profile)),
          {
            description: "Composition profile: showcase (default) or standard",
          },
        ),
      ),
      repoRoot: Type.Optional(
        Type.String({
          description:
            "Repository root for verified repository source evidence (supported for all five diagram types)",
        }),
      ),
      scenario: Type.Optional(Type.String({ description: "Scenario/question for command=guide" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validation = validateArchifyParams(params);
      if (!validation.ok) {
        return textToolResult(validation.error, 1);
      }

      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const value = validation.value;
      if (value.kind === "diagram") {
        return archifyDiagramToolResult(value, cwd);
      }

      const ignored = ignoredArchifyParams(value.kind, params);
      const note = formatArchifyIgnoredParamsNote(value.kind, ignored);
      return archifyGuidanceToolResult(value, cwd, note);
    },
  });
}
