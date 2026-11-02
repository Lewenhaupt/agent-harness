import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AuthenticatableAuthority,
  DurableAgentConfig,
  DurableCommand,
} from "../durable-member/commands.js";
import { createDedupeLedger } from "../durable-member/dedupe.js";
import {
  createDurableDispatcher,
  type DurableSubmitInput,
  type DurableWriter,
} from "../durable-member/dispatch.js";
import {
  type ControlServerStart,
  ensureControlToken,
  isControlErrorCode,
  memberControlPortPath,
  memberControlSocketPath,
  memberControlTokenPath,
  readControlToken,
  readMemberControlTarget,
  sendControlCommand,
  sendMemberControlCommand,
  startControlServer,
} from "../durable-member/socket.js";
import { makeCommand, makeStateDir, removeStateDir, TEST_MEMBER_ID } from "./durable-fixtures.js";

const stateDirs: string[] = [];
const servers: ControlServerStart[] = [];

function stateDir(): string {
  const dir = makeStateDir();
  stateDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.ok) await server.close();
  }
  for (const dir of stateDirs.splice(0)) removeStateDir(dir);
});

interface RecordingWriter {
  readonly writer: DurableWriter;
  readonly submitted: DurableSubmitInput[];
  readonly aborts: string[];
  readonly configured: DurableAgentConfig[];
  readonly resets: { readonly keepHistory: boolean }[];
}

function writer(): RecordingWriter {
  const submitted: DurableSubmitInput[] = [];
  const aborts: string[] = [];
  const configured: DurableAgentConfig[] = [];
  const resets: { readonly keepHistory: boolean }[] = [];
  const recording: DurableWriter = {
    submit(input) {
      submitted.push(input);
      return { ok: true };
    },
    submission() {
      return null;
    },
    abort() {
      aborts.push("abort");
    },
    configure(config) {
      configured.push(config);
    },
    compact() {},
    reset(options) {
      resets.push(options);
    },
  };
  return { writer: recording, submitted, aborts, configured, resets };
}

interface Started {
  readonly server: Extract<ControlServerStart, { ok: true }>;
  readonly dir: string;
  readonly recorder: RecordingWriter;
}

async function startServer(
  options: {
    transport?: "unix" | "tcp";
    maxFrameBytes?: number;
    authorities?: readonly AuthenticatableAuthority[];
    /** Reuse a state dir to prove credential stability across a restart. */
    dir?: string;
  } = {},
): Promise<Started> {
  const dir = options.dir ?? stateDir();
  const recorder = writer();
  const authorities = options.authorities ?? ["panel-human"];
  const opened = createDedupeLedger({ stateDir: dir });
  if (!opened.ok) throw new Error(opened.error);
  const tiers = authorities.map((authority) => ({
    authority,
    dispatcher: createDurableDispatcher({
      memberId: TEST_MEMBER_ID,
      authority,
      writer: recorder.writer,
      ledger: opened.ledger,
    }),
  }));
  const server = await startControlServer({
    stateDir: dir,
    memberId: TEST_MEMBER_ID,
    tiers,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  });
  if (!server.ok) throw new Error(server.error);
  servers.push(server);
  return { server, dir, recorder };
}

function credentialFor(
  server: Extract<ControlServerStart, { ok: true }>,
  authority: AuthenticatableAuthority,
): string {
  const found = server.credentials.find((candidate) => candidate.authority === authority);
  if (found === undefined) throw new Error(`server issued no credential for ${authority}`);
  return found.token;
}

/** Send raw NDJSON frames and collect whatever the server writes back. */
function rawExchange(
  target: { path: string } | { host: string; port: number },
  frames: readonly string[],
  timeoutMs = 2_000,
): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buffer = "";
    const socket = createConnection(target);
    const done = (): void => {
      socket.destroy();
      resolve(lines);
    };
    const timer = setTimeout(done, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      for (const frame of frames) socket.write(frame);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const index = buffer.indexOf("\n");
        if (index === -1) break;
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      done();
    });
    socket.on("end", () => {
      clearTimeout(timer);
      done();
    });
  });
}

describe("member control socket credentials", () => {
  it("creates a 0600 credential only for the tiers the server serves", async () => {
    const { server, dir } = await startServer();
    expect(server.address.transport).toBe("unix");
    expect(statSync(memberControlTokenPath(dir, "panel-human")).mode & 0o777).toBe(0o600);
    expect(existsSync(memberControlTokenPath(dir, "fleet-supervisor"))).toBe(false);
    expect(existsSync(join(dir, "control.phase-subagent.token"))).toBe(false);
    expect(statSync(memberControlSocketPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readControlToken(dir, "panel-human")).toEqual({
      ok: true,
      token: credentialFor(server, "panel-human"),
    });
  });

  it("keeps each tier credential stable across a restart and serves both when configured", async () => {
    const first = await startServer({ authorities: ["panel-human", "fleet-supervisor"] });
    const panel = credentialFor(first.server, "panel-human");
    const supervisor = credentialFor(first.server, "fleet-supervisor");
    expect(panel).not.toBe(supervisor);
    await first.server.close();

    const restarted = await startServer({
      authorities: ["panel-human", "fleet-supervisor"],
      dir: first.dir,
    });
    expect(credentialFor(restarted.server, "panel-human")).toBe(panel);
    expect(credentialFor(restarted.server, "fleet-supervisor")).toBe(supervisor);
  });

  it("refuses to issue a credential for the non-authenticatable phase tier", async () => {
    const dir = stateDir();
    const opened = createDedupeLedger({ stateDir: dir });
    if (!opened.ok) throw new Error(opened.error);
    const recorder = writer();
    const dispatcher = createDurableDispatcher({
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      writer: recorder.writer,
      ledger: opened.ledger,
    });
    const server = await startControlServer({
      stateDir: dir,
      memberId: TEST_MEMBER_ID,
      tiers: [
        {
          authority: "phase-subagent" as unknown as AuthenticatableAuthority,
          dispatcher,
        },
      ],
    });
    expect(server).toMatchObject({ ok: false });
    if (server.ok) return;
    expect(server.error).toContain("phase-subagent");
    expect(existsSync(join(dir, "control.phase-subagent.token"))).toBe(false);
  });

  it("reuses an existing credential so a restart does not invalidate a queued command", () => {
    const dir = stateDir();
    const first = ensureControlToken(dir, "panel-human");
    const second = ensureControlToken(dir, "panel-human");
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    const other = ensureControlToken(dir, "fleet-supervisor");
    expect(other.ok).toBe(true);
    if (!first.ok || !other.ok) return;
    expect(other.token).not.toBe(first.token);
  });
});

/** "accepted" only if the TCP handshake completed; refusal and timeout both mean "not listened on". */
function connectOutcome(
  target: { readonly host: string; readonly port: number },
  timeoutMs: number,
): Promise<"accepted" | "refused"> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(target);
    const finish = (outcome: "accepted" | "refused"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("refused"), timeoutMs);
    socket.on("connect", () => finish("accepted"));
    socket.on("error", () => finish("refused"));
  });
}

/** Every non-internal IPv4 address of this host (family is a number on old Node, a string on new). */
function externalIPv4Addresses(): { readonly name: string; readonly address: string }[] {
  const found: { readonly name: string; readonly address: string }[] = [];
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (String(info.family) === "IPv4" && info.internal === false) {
        found.push({ name, address: info.address });
      }
    }
  }
  return found;
}

/**
 * Learn whether a routable address of this host can reach a 0.0.0.0 listener.
 *
 * Binding 0.0.0.0 here reproduces what a non-loopback control listener would do;
 * if this host cannot reach itself that way (firewall, network namespace), a
 * refusal on the control port proves nothing and the caller must skip loudly.
 */
async function reachesOwnWildcardListener(host: string): Promise<boolean> {
  const calibration: Server = createServer();
  const port = await new Promise<number>((resolve) => {
    calibration.once("error", () => resolve(0));
    calibration.listen({ host: "0.0.0.0", port: 0 }, () => {
      const address = calibration.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  const outcome = port === 0 ? "refused" : await connectOutcome({ host, port }, 2_000);
  await new Promise<void>((resolve) => {
    calibration.close(() => resolve());
  });
  return outcome === "accepted";
}

describe("member control socket", () => {
  it("applies a steer from the panel credential", async () => {
    const { server, recorder } = await startServer();
    const result = await sendControlCommand({
      target: server.address,
      token: credentialFor(server, "panel-human"),
      command: makeCommand("steer"),
    });

    expect(result).toEqual({ ok: true, requestId: "req-steer-1", duplicate: false });
    expect(recorder.submitted).toEqual([
      { type: "message", text: "steer the member", whenBusy: "steer" },
    ]);
  });

  it("applies a followup from the panel credential", async () => {
    const { server, recorder } = await startServer();
    const result = await sendControlCommand({
      target: server.address,
      token: credentialFor(server, "panel-human"),
      command: makeCommand("followup"),
    });

    expect(result.ok).toBe(true);
    expect(recorder.submitted).toEqual([
      { type: "message", text: "steer the member", whenBusy: "followup" },
    ]);
  });

  it("applies a panel abort", async () => {
    const { server, recorder } = await startServer();
    const result = await sendControlCommand({
      target: server.address,
      token: credentialFor(server, "panel-human"),
      command: makeCommand("abort"),
    });
    expect(result.ok).toBe(true);
    // Abort stops the conversation {and its tasks} through the writer's own
    // abort(); it must not become a second content path into the run.
    expect(recorder.aborts).toEqual(["abort"]);
    expect(recorder.submitted).toHaveLength(0);
  });

  it("delivers the same requestId once and reports the retry as a duplicate", async () => {
    const { server, recorder } = await startServer();
    const token = credentialFor(server, "panel-human");
    const command = makeCommand("steer");

    const first = await sendControlCommand({ target: server.address, token, command });
    const second = await sendControlCommand({ target: server.address, token, command });

    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(recorder.submitted).toHaveLength(1);
  });

  it("rejects a wrong credential before parsing any command frame", async () => {
    const { server, recorder } = await startServer();
    const result = await sendControlCommand({
      target: server.address,
      token: "not-the-token",
      command: makeCommand("steer"),
    });

    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
    expect(recorder.submitted).toHaveLength(0);
  });

  it("rejects a command frame that arrives before auth and closes the channel", async () => {
    const { server, recorder } = await startServer();
    const address = server.address;
    if (address.transport !== "unix") throw new Error("expected unix");

    const lines = await rawExchange({ path: address.path }, [
      `${JSON.stringify({ type: "command", command: makeCommand("steer") })}\n`,
      `${JSON.stringify({ type: "command", command: makeCommand("abort") })}\n`,
    ]);

    expect(lines).toHaveLength(1);
    // A command before auth is still a pre-auth failure, so it answers with the
    // same generic message as a wrong credential rather than naming the phase.
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "error",
      code: "unauthorized",
      error: "credential does not match any tier this surface serves",
    });
    expect(recorder.submitted).toHaveLength(0);
  });

  it("answers an oversized token with the same generic failure as a wrong credential", async () => {
    const { server, recorder } = await startServer();
    const address = server.address;
    if (address.transport !== "unix") throw new Error("expected unix");

    const wrong = await rawExchange({ path: address.path }, [
      `${JSON.stringify({ type: "auth", token: "not-the-token" })}\n`,
    ]);
    // The token-length bound is a DoS guard, not a diagnostic: over 1024 bytes
    // is rejected without admitting that the length check, not the credential,
    // decided it.
    const oversized = await rawExchange({ path: address.path }, [
      `${JSON.stringify({ type: "auth", token: "x".repeat(1025) })}\n`,
    ]);

    expect(wrong).toHaveLength(1);
    expect(oversized).toEqual(wrong);
    expect(JSON.parse(oversized[0] ?? "{}")).toMatchObject({
      type: "error",
      code: "unauthorized",
      error: "credential does not match any tier this surface serves",
    });
    expect(recorder.submitted).toHaveLength(0);
  });

  it("rejects a malformed first frame and closes the channel", async () => {
    const { server } = await startServer();
    const address = server.address;
    if (address.transport !== "unix") throw new Error("expected unix");

    const lines = await rawExchange({ path: address.path }, ["not-json\n"]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "error", code: "invalid-frame" });
  });

  it("refuses an oversized frame instead of buffering it", async () => {
    const { server } = await startServer({ maxFrameBytes: 64 });
    const address = server.address;
    if (address.transport !== "unix") throw new Error("expected unix");

    const lines = await rawExchange({ path: address.path }, ["x".repeat(200)]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "error",
      code: "frame-too-large",
    });
  });

  it("refuses a command addressed to another member", async () => {
    const { server, recorder } = await startServer();
    const result = await sendControlCommand({
      target: server.address,
      token: credentialFor(server, "panel-human"),
      command: makeCommand("steer", { memberId: "member-b" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("member-b");
    expect(recorder.submitted).toHaveLength(0);
  });

  it("refuses a supervisor credential on a panel-only surface before dispatch", async () => {
    const { server, dir, recorder } = await startServer();
    const supervisor = ensureControlToken(dir, "fleet-supervisor");
    if (!supervisor.ok) throw new Error(supervisor.error);

    const result = await sendControlCommand({
      target: server.address,
      token: supervisor.token,
      command: makeCommand("steer", { authority: "panel-human" }),
    });

    // The credential is not served at all, so it cannot even authenticate.
    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
    expect(recorder.submitted).toHaveLength(0);
  });

  it("derives the supervisor tier from its credential and refuses a content steer", async () => {
    const { server, recorder } = await startServer({
      authorities: ["panel-human", "fleet-supervisor"],
    });
    const supervisor = credentialFor(server, "fleet-supervisor");

    // The frame lies about its role; the credential still says supervisor, so
    // the claim is refused before the writer is reached.
    const mislabelled = await sendControlCommand({
      target: server.address,
      token: supervisor,
      command: makeCommand("steer", { authority: "panel-human" }),
    });
    expect(mislabelled).toMatchObject({ ok: false, code: "authority-mismatch" });

    // An honest supervisor claim is refused by the matrix instead. The wire
    // keeps its small error-code set, so the refusal reason is in the message.
    const honest = await sendControlCommand({
      target: server.address,
      token: supervisor,
      command: makeCommand("steer", { authority: "fleet-supervisor" }),
    });
    expect(honest.ok).toBe(false);
    if (honest.ok) return;
    expect(honest.error).toContain("fleet-supervisor may not send steer");
    expect(recorder.submitted).toHaveLength(0);
  });

  it("derives each served tier from its own credential when both are served", async () => {
    const { server, recorder } = await startServer({
      authorities: ["panel-human", "fleet-supervisor"],
    });

    // Every candidate credential is compared and the tier is picked after the
    // loop, so each served credential still derives its own tier.
    for (const authority of ["panel-human", "fleet-supervisor"] as const) {
      const result = await sendControlCommand({
        target: server.address,
        token: credentialFor(server, authority),
        command:
          authority === "panel-human"
            ? makeCommand("steer", { authority })
            : makeCommand("abort", { authority }),
      });
      expect(result).toMatchObject({ ok: true });
    }
    expect(recorder.submitted).toHaveLength(1);
    expect(recorder.aborts).toEqual(["abort"]);
  });

  it("refuses configure/reset as confirmation-required over the wire, then applies them with it", async () => {
    const { server, recorder } = await startServer();
    const token = credentialFor(server, "panel-human");

    for (const kind of ["configure", "reset"] as const) {
      // The dispatcher's refusal code is `confirmation-required`; the wire keeps
      // its small code set (`invalid-command`) and carries the reason in the
      // message, so the round-trip assertion checks both.
      const refused = await sendControlCommand({
        target: server.address,
        token,
        command: makeCommand(kind, { confirmation: undefined }),
      });
      expect(refused).toMatchObject({ ok: false, code: "invalid-command" });
      if (refused.ok) return;
      expect(refused.error).toContain("requires confirmation equal to the member id");
    }
    expect(recorder.configured).toHaveLength(0);
    expect(recorder.resets).toHaveLength(0);
    expect(recorder.submitted).toHaveLength(0);

    for (const kind of ["configure", "reset"] as const) {
      const applied = await sendControlCommand({
        target: server.address,
        token,
        command: makeCommand(kind, { confirmation: TEST_MEMBER_ID }),
      });
      expect(applied).toMatchObject({ ok: true });
    }
    expect(recorder.configured).toEqual([{ model: "anthropic/claude-sonnet" }]);
    expect(recorder.resets).toHaveLength(1);
    expect(recorder.submitted).toHaveLength(0);
  });

  it("refuses a supervisor credential for configure/reset even with confirmation", async () => {
    const { server, recorder } = await startServer({
      authorities: ["panel-human", "fleet-supervisor"],
    });
    const supervisor = credentialFor(server, "fleet-supervisor");

    for (const command of [
      makeCommand("configure", { authority: "fleet-supervisor" }),
      makeCommand("reset", { authority: "fleet-supervisor" }),
    ] as DurableCommand[]) {
      const result = await sendControlCommand({
        target: server.address,
        token: supervisor,
        command,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("fleet-supervisor");
      expect(result.error).toMatch(/may not send (configure|reset)/);
    }
    expect(recorder.submitted).toHaveLength(0);
    expect(recorder.aborts).toHaveLength(0);
  });

  it("lets a supervisor credential apply lifecycle abort", async () => {
    const { server, recorder } = await startServer({
      authorities: ["panel-human", "fleet-supervisor"],
    });
    const result = await sendControlCommand({
      target: server.address,
      token: credentialFor(server, "fleet-supervisor"),
      command: makeCommand("abort", { authority: "fleet-supervisor" }),
    });
    expect(result.ok).toBe(true);
    expect(recorder.aborts).toEqual(["abort"]);
  });

  it("derives the panel tier from the panel credential even when the frame claims supervisor", async () => {
    const { server, recorder } = await startServer({
      authorities: ["panel-human", "fleet-supervisor"],
    });
    const result = await sendControlCommand({
      target: server.address,
      token: credentialFor(server, "panel-human"),
      command: makeCommand("steer", { authority: "fleet-supervisor" }),
    });
    expect(result).toMatchObject({ ok: false, code: "authority-mismatch" });
    expect(recorder.submitted).toHaveLength(0);
  });

  it("recognises only known control error codes", () => {
    expect(isControlErrorCode("authority-mismatch")).toBe(true);
    expect(isControlErrorCode("unauthorized")).toBe(true);
    expect(isControlErrorCode("root")).toBe(false);
    expect(isControlErrorCode(42)).toBe(false);
  });

  it("publishes the owner-chosen TCP port and resolves the target from it", async () => {
    const { server, dir } = await startServer({ transport: "tcp" });
    if (server.address.transport !== "tcp") throw new Error("expected tcp");
    expect(readFileSync(memberControlPortPath(dir), "utf8").trim()).toBe(
      String(server.address.port),
    );
    expect(readMemberControlTarget(dir)).toEqual({
      transport: "tcp",
      host: "127.0.0.1",
      port: server.address.port,
    });

    const result = await sendMemberControlCommand({
      stateDir: dir,
      authority: "panel-human",
      command: makeCommand("steer"),
    });
    expect(result.ok).toBe(true);

    await server.close();
    expect(existsSync(memberControlPortPath(dir))).toBe(false);
  });

  it("binds the TCP fallback to loopback, not to a routable address", async (context) => {
    const { server } = await startServer({ transport: "tcp" });
    if (server.address.transport !== "tcp") throw new Error("expected tcp");
    const port = server.address.port;

    // "Loopback-only" is a claim about the bound interface, which a reported
    // host cannot prove: probe a routable address of this host and require the
    // connection to be refused. Calibrate first so a firewall cannot turn this
    // into a silent pass.
    let probe: { readonly name: string; readonly address: string } | undefined;
    for (const candidate of externalIPv4Addresses()) {
      if (await reachesOwnWildcardListener(candidate.address)) {
        probe = candidate;
        break;
      }
    }
    if (probe === undefined) {
      console.warn(
        "Skipping loopback-only assertion: this host has no non-loopback IPv4 address it can reach itself through",
      );
      context.skip();
      return;
    }

    const outcome = await connectOutcome({ host: probe.address, port }, 2_000);
    expect(
      outcome,
      `${probe.name} ${probe.address}:${String(port)} accepted a connection, so the control listener is not loopback-only`,
    ).toBe("refused");
  });

  it("resolves the unix target when no port file was published", async () => {
    const { dir } = await startServer();
    expect(readMemberControlTarget(dir)).toEqual({
      transport: "unix",
      path: memberControlSocketPath(dir),
    });
    expect(existsSync(memberControlPortPath(dir))).toBe(false);
  });

  it("removes the unix socket on close", async () => {
    const { server, dir } = await startServer();
    const path = memberControlSocketPath(dir);
    expect(existsSync(path)).toBe(true);
    await server.close();
    expect(existsSync(path)).toBe(false);
  });
});
