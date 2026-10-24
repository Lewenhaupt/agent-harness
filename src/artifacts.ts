/**
 * Per-phase artifacts (bd-141).
 *
 * A phase agent is a cold process: its workspace is the worktree and its input is
 * a prompt. Until now everything a phase learned left the system when its process
 * exited — the orchestrator could pass it on only by retyping it, which is the
 * "lossy relay" that makes scout's cheap findings invisible to implement.
 *
 * This module gives each phase one durable file in the worktree, written by the
 * harness (not the agent, so it cannot be forgotten) and named in the next phase's
 * prompt. The prompt carries a reference, not a payload: Anthropic's subagent
 * guidance puts a useful handoff at 1-2k tokens, and BMAD/Spec Kit both hand work
 * off through files rather than chat history.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Directory (worktree-relative) holding one artifact per phase. */
export const ARTIFACT_DIR = ".belayd/artifacts";

/**
 * Upper bound on one artifact, in characters.
 *
 * Large enough for a plan or a full review verdict, small enough that an agent
 * reading it cannot blow its own context: past this the value is in the files the
 * artifact names, not in more prose.
 */
export const MAX_ARTIFACT_CHARS = 20_000;

/** All phases the artifact bus knows about, in workflow order. */
export const ARTIFACT_PHASES = [
  "scout",
  "plan",
  "implement",
  "review",
  "test",
  "userguide",
  "proof",
  "commit",
] as const;

/** A phase whose artifact exists on disk. */
export interface PhaseArtifact {
  phase: string;
  /** Worktree-relative path, e.g. `.belayd/artifacts/review.md`. */
  path: string;
  chars: number;
}

/** Worktree-relative path of one phase's artifact. */
export function artifactPath(phase: string): string {
  return `${ARTIFACT_DIR}/${sanitizePhase(phase)}.md`;
}

/** Absolute path of one phase's artifact. */
export function artifactAbsPath(options: { cwd: string; phase: string }): string {
  return join(options.cwd, artifactPath(options.phase));
}

/** Result of writing an artifact. */
export type ArtifactWriteResult =
  | { ok: true; path: string; chars: number; truncated: boolean }
  | { ok: false; error: string };

/**
 * Write one phase artifact, bounded.
 *
 * Best effort: the caller is finishing a phase run, so a write failure is
 * reported and never thrown. A truncated artifact keeps its head *and* tail,
 * because a review verdict and a plan summary both live at the end.
 */
export function writePhaseArtifact(options: {
  cwd: string;
  phase: string;
  taskId: string;
  text: string;
  maxChars?: number;
}): ArtifactWriteResult {
  const relative = artifactPath(options.phase);
  const absolute = join(options.cwd, relative);
  const maxChars = options.maxChars ?? MAX_ARTIFACT_CHARS;
  const { body, truncated } = boundArtifact(options.text, maxChars);
  const header = [
    `# ${options.phase} artifact (${options.taskId})`,
    "",
    `Written by the harness when the ${options.phase} phase settled. Paths are relative to this worktree.`,
    truncated ? `\n> Truncated to ${maxChars} characters (head and tail kept).\n` : "",
  ].join("\n");
  try {
    mkdirSync(join(options.cwd, ARTIFACT_DIR), { recursive: true });
    writeFileSync(absolute, `${header}\n${body}`, "utf8");
    return { ok: true, path: relative, chars: body.length, truncated };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read one artifact back, or undefined when absent. */
export function readPhaseArtifact(options: { cwd: string; phase: string }): string | undefined {
  const absolute = artifactAbsPath(options);
  if (!existsSync(absolute)) return undefined;
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return undefined;
  }
}

/** List the artifacts present in a worktree, in workflow order. */
export function listPhaseArtifacts(cwd: string): PhaseArtifact[] {
  const found: PhaseArtifact[] = [];
  for (const phase of ARTIFACT_PHASES) {
    const absolute = artifactAbsPath({ cwd, phase });
    if (!existsSync(absolute)) continue;
    try {
      const stats = statSync(absolute);
      if (!stats.isFile()) continue;
      found.push({ phase, path: artifactPath(phase), chars: stats.size });
    } catch {}
  }
  return found;
}

/**
 * Prompt block naming the artifacts a phase should read before starting.
 *
 * Returns "" when nothing exists, so a first phase prompt stays unchanged. The
 * block deliberately carries paths and sizes only: the agent decides what to read,
 * which keeps the prompt small and lets it skip an artifact that is irrelevant.
 */
export function formatArtifactIndex(options: {
  cwd: string;
  /** Phase about to run; its own artifact is excluded (a re-run would read stale output). */
  forPhase?: string;
}): string {
  const artifacts = listPhaseArtifacts(options.cwd).filter(
    (artifact) => artifact.phase !== options.forPhase,
  );
  if (artifacts.length === 0) return "";
  const lines = [
    "## Prior phase artifacts",
    "",
    "Earlier phases in this workflow wrote these files in this worktree. Read the ones you need",
    "before exploring the repo from scratch; they are the cheapest context available.",
    "",
    ...artifacts.map((artifact) => {
      const kb = Math.max(1, Math.round(artifact.chars / 1024));
      return `- \`${artifact.path}\` (${kb} KB) — ${artifact.phase} phase output`;
    }),
  ];
  return lines.join("\n");
}

/** Hard cap from both ends, so a truncated artifact keeps its conclusion. */
function boundArtifact(text: string, maxChars: number): { body: string; truncated: boolean } {
  if (text.length <= maxChars) return { body: text, truncated: false };
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  return {
    body: `${head}\n\n[... ${text.length - maxChars} characters omitted ...]\n\n${tail}`,
    truncated: true,
  };
}

/** Keep a phase name filesystem-safe even if a workflow adds one later. */
function sanitizePhase(phase: string): string {
  return phase.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}
