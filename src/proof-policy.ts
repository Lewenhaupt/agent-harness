/**
 * Repo proof-artifact policy (bd-276) — which proof content a repository permits
 * in a payload it publishes into itself.
 *
 * The publish gate refuses proof artifacts by default (bd-181): proof uploads to
 * the reviewing platform and the workflow keeps a receipt instead of files. bd-181
 * deliberately left repositories with committed proof dirs "not migrated, only
 * stopped", which for a repository whose own policy keeps *text* evidence in git
 * (proof-of-work-reviewing-platform: `docs/PROOF-ARTIFACTS.md`, `pnpm
 * check:proof-hygiene`) refuses every member forever — with a refusal an operator
 * cannot tell apart from a member that committed junk.
 *
 * So the repository declares the policy and the harness defers to it:
 *
 *     { "proof": { "artifacts": "in-tree" } }   // .belayd/config.json
 *
 * - `forbid` (the default, and what an absent or broken declaration resolves to):
 *   proof content in the payload is refused.
 * - `in-tree`: proof content is ordinary content for the local merge drain. Every
 *   other publish-gate predicate still applies (harness-local paths, absolute,
 *   traversal, non-ASCII lookalikes), so declaring this narrows nothing else.
 *
 * Read live at drain time, never frozen into the intent: this is a statement about
 * what the repository *is*, so the repo's current config is the truth and a
 * declaration made mid-run must apply to work already in flight.
 *
 * A broken declaration is a warning plus the strict default, never a launch abort
 * — the convention the publish contract reader already uses. The file read is
 * shared with that reader (`readRepoConfigObject`) so the two cannot disagree
 * about the same bytes.
 */

import { join } from "node:path";
import { z } from "zod";
import type { FleetPublishFsSeam } from "./fleet-publish.js";
import { readRepoConfigObject } from "./fleet-publish.js";

/** Accepted values of `.belayd/config.json` `proof.artifacts`. */
export const PROOF_ARTIFACT_POLICIES = ["forbid", "in-tree"] as const;

/** Which proof content a repo permits: refused payload, or ordinary content. */
export type ProofArtifactPolicy = (typeof PROOF_ARTIFACT_POLICIES)[number];

/** Strict default: the gate refuses proof content unless the repo says otherwise. */
export const DEFAULT_PROOF_ARTIFACT_POLICY: ProofArtifactPolicy = "forbid";

/**
 * `strict` on purpose: a misspelled key (`artifact`, `proofArtifacts`) must warn
 * and fall back to the strict policy rather than read as "no declaration".
 */
const ProofPolicySchema = z.object({ artifacts: z.enum(PROOF_ARTIFACT_POLICIES) }).strict();

/** The resolved policy and whether the repo declared it. */
export interface RepoProofArtifactPolicy {
  policy: ProofArtifactPolicy;
  /** True when the repo declared it, false when this is the default. */
  declared: boolean;
  warnings: readonly string[];
}

/** Bounded zod-issue rendering, matching the readers of the same config file. */
function describeIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Read `.belayd/config.json` `proof.artifacts`; never throws and never guesses.
 *
 * An absent file or absent key is "no declaration" (the strict default, with no
 * warning — that is every repository today). A declaration that does not parse is
 * a warning plus the strict default.
 */
export function readRepoProofPolicy(options: {
  repoRoot: string;
  fs?: FleetPublishFsSeam;
}): RepoProofArtifactPolicy {
  const read = readRepoConfigObject(options);
  const warnings = [...read.warnings];
  if (read.config === undefined) {
    return { policy: DEFAULT_PROOF_ARTIFACT_POLICY, declared: false, warnings };
  }
  const raw = read.config.proof;
  if (raw === undefined) {
    return { policy: DEFAULT_PROOF_ARTIFACT_POLICY, declared: false, warnings };
  }
  const parsed = ProofPolicySchema.safeParse(raw);
  if (!parsed.success) {
    warnings.push(
      `${join(options.repoRoot, ".belayd", "config.json")}: invalid proof policy ` +
        `(${describeIssues(parsed.error.issues)}); assuming "${DEFAULT_PROOF_ARTIFACT_POLICY}"`,
    );
    return { policy: DEFAULT_PROOF_ARTIFACT_POLICY, declared: false, warnings };
  }
  return { policy: parsed.data.artifacts, declared: true, warnings };
}
