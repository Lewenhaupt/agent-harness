/**
 * Beads actor identity (bd-150).
 *
 * Every write from every orchestrator and phase agent used to attribute to the
 * operator's git `user.name`, so the audit actor in `bd history <id> --events`
 * could not say which agent wrote what. Beads accepts a global `--actor <name>`
 * flag, and this module names the harness's two actor kinds and maps a pi session
 * name onto one of them.
 *
 * Two mechanisms deliver the actor, because one process-level env var cannot
 * cover both session kinds:
 *
 * - a pi-web orchestrator runs **in-process** in the session daemon, so it takes
 *   the actor as a `--actor` flag from the `bd` tool proxy;
 * - a phase agent is a real child process, so `spawn.ts` hands it
 *   `BEADS_ACTOR` and every raw `bash` `bd` call is attributed too.
 *
 * Everything here is pure: derivation only, no processes, no filesystem.
 */

import { z } from "zod";
import { isValidTaskId, parseSubagentSessionName } from "./session-naming.js";

/**
 * Prefix every harness-authored bd actor carries (bd-150).
 *
 * The single source of truth for "this write came from the harness": the answer
 * channel treats any comment author outside this prefix as a human, so a second
 * copy of the string would be a silent way to misclassify harness traffic.
 */
export const BELAYD_ACTOR_PREFIX = "belayd:";

/** Actor for a workflow's orchestrator session: `belayd:<taskId>:orchestrator`. */
export function orchestratorActor(taskId: string): string {
  return `${BELAYD_ACTOR_PREFIX}${taskId}:orchestrator`;
}

/** Actor for one phase agent: `belayd:<taskId>:<phase>`. */
export function phaseActor(taskId: string, phase: string): string {
  return `${BELAYD_ACTOR_PREFIX}${taskId}:${phase}`;
}

/** True when `value` names a harness actor rather than a human/other tool. */
export function isBelaydActor(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(BELAYD_ACTOR_PREFIX);
}

const ORCHESTRATOR_SESSION_PREFIX = "belayd-";

/**
 * The task id an orchestrator session name carries, or undefined when the name
 * is some other harness session.
 *
 * `belayd-<taskId>` is the whole shape, so the whole remainder must be a valid
 * task id: planning (`belayd-planning-…`), proof verifiers
 * (`belayd-proof-verifier-<runId>`) and suffixed names
 * (`belayd-bd-150-extra`) all fail the validator and stay unattributed.
 */
function orchestratorTaskId(sessionName: string): string | undefined {
  if (!sessionName.startsWith(ORCHESTRATOR_SESSION_PREFIX)) return undefined;
  const taskId = sessionName.slice(ORCHESTRATOR_SESSION_PREFIX.length);
  return isValidTaskId(taskId) ? taskId : undefined;
}

/**
 * Map a session name onto the actor that session's bead writes should carry.
 *
 * Phase sessions reuse `parseSubagentSessionName`, which already strips the
 * `-retry-N` / `-run-N` / `-fallback-N` epoch suffixes a resumed phase session
 * may carry, so a gate retry keeps the actor of the run it belongs to.
 *
 * Returns undefined for humans, absent names, and harness sessions that drive
 * no workflow (planning, proof verification).
 */
export function resolveBdActor(sessionName: string | undefined): string | undefined {
  if (typeof sessionName !== "string" || sessionName === "") return undefined;
  const phase = parseSubagentSessionName(sessionName);
  if (phase !== undefined) return phaseActor(phase.taskId, phase.phase);
  const taskId = orchestratorTaskId(sessionName);
  return taskId === undefined ? undefined : orchestratorActor(taskId);
}

/**
 * Insert `--actor <actor>` immediately after the subcommand.
 *
 * `--actor` is a global bd flag, so it is accepted both before and after the
 * subcommand. Index 1 is the placement that keeps `argv[0]` the subcommand
 * (read/write guards inspect it) and can never land after a `--` terminator. A
 * caller-supplied `--actor` later in argv still wins, because bd's last flag
 * wins.
 */
export function withActorArgv(argv: readonly string[], actor: string): readonly string[] {
  if (argv.length === 0) return [...argv];
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) return [...argv];
  return [subcommand, "--actor", actor, ...rest];
}

/**
 * Attribute argv to the session's actor, when it resolves to one.
 *
 * Left untouched for humans and for harness sessions with no workflow actor, so
 * their writes keep the git `user.name` / scotty's inherited `BEADS_ACTOR`.
 */
export function withActorForSession(
  argv: readonly string[],
  sessionName: string | undefined,
): readonly string[] {
  const actor = resolveBdActor(sessionName);
  return actor === undefined ? [...argv] : withActorArgv(argv, actor);
}

/**
 * argv that claims an unassigned bead for the workflow's driving actor.
 *
 * `--if-assignee ""` makes this a compare-and-set: bd refuses the write when
 * someone else already holds the bead, so a human's manual assignment is never
 * clobbered by a launch. The `--actor` names the workflow the claim is made for.
 */
export function setAssigneeArgv(options: { taskId: string; actor: string }): readonly string[] {
  return withActorArgv(
    ["update", "--if-assignee", "", "--assignee", options.actor, "--", options.taskId],
    options.actor,
  );
}

/** argv that releases a bead, guarded so it only clears the observed `holder`. */
export function clearAssigneeArgv(options: { taskId: string; holder: string }): readonly string[] {
  const argv = ["update", "--if-assignee", options.holder, "--assignee", "", "--", options.taskId];
  return isBelaydActor(options.holder) ? withActorArgv(argv, options.holder) : argv;
}

/**
 * One `bd show --json` record, which is all this module needs from bd.
 *
 * Untrusted CLI output, so it is validated at the boundary with zod rather than
 * cast (repo convention: `fleet-heartbeat.ts`, `fleet-run.ts`).
 */
const BeadRecordSchema = z.object({ assignee: z.string().optional() });

/** bd answers `show <id> --json` with one record; batched ids answer with an array. */
const BeadShowSchema = z.array(BeadRecordSchema).or(BeadRecordSchema);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The assignee recorded in `bd show <taskId> --json`, if any.
 *
 * Total by design: bd may answer with an array or a single record, may omit the
 * field, and may print something that is not JSON at all (a version-drift or
 * error banner). Every one of those means "no assignee we can act on", so the
 * caller treats the bead as unassigned-or-unknown and re-reads after a failure.
 */
export function parseAssignee(showJson: string): string | undefined {
  const parsed = BeadShowSchema.safeParse(parseJson(showJson));
  if (!parsed.success) return undefined;
  const record = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
  const assignee = record?.assignee;
  return typeof assignee === "string" && assignee !== "" ? assignee : undefined;
}
