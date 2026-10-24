import { describe, expect, it } from "vitest";

import {
  BELAYD_PI_BINARY_ENV,
  PI_BINARY_PATH_ENV,
  piBinaryCandidates,
  piBinaryNotice,
  resolvePiBinaryPath,
  SYSTEM_PI_BINARY,
} from "../pi-binary.js";

const noPath = (): string | undefined => undefined;

describe("piBinaryCandidates", () => {
  it("orders explicit override, harness override, system, path", () => {
    const candidates = piBinaryCandidates({
      env: {
        [BELAYD_PI_BINARY_ENV]: "/opt/explicit/pi",
        [PI_BINARY_PATH_ENV]: "/repo/bin/pi",
      },
      pathLookup: () => "/usr/bin/pi",
    });

    expect(candidates.map((candidate) => candidate.source)).toEqual([
      "explicit",
      "harness-env",
      "system",
      "path",
    ]);
    expect(candidates.map((candidate) => candidate.binary)).toEqual([
      "/opt/explicit/pi",
      "/repo/bin/pi",
      SYSTEM_PI_BINARY,
      "/usr/bin/pi",
    ]);
  });

  it("treats a blank override as unset", () => {
    const candidates = piBinaryCandidates({
      env: { [BELAYD_PI_BINARY_ENV]: "   ", [PI_BINARY_PATH_ENV]: "" },
      pathLookup: noPath,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toHaveProperty("source", "system");
  });

  it("omits the path candidate when the lookup finds nothing", () => {
    const candidates = piBinaryCandidates({ env: {}, pathLookup: noPath });

    expect(candidates.map((candidate) => candidate.source)).toEqual(["system"]);
  });
});

describe("resolvePiBinaryPath", () => {
  it("uses an explicit override and does not report a fallback", () => {
    const resolution = resolvePiBinaryPath({
      env: { [BELAYD_PI_BINARY_ENV]: "/opt/explicit/pi" },
      exists: (path) => path === "/opt/explicit/pi",
      pathLookup: noPath,
    });

    expect(resolution).toHaveProperty("binary", "/opt/explicit/pi");
    expect(resolution).toHaveProperty("source", "explicit");
    expect(resolution).toHaveProperty("fellBack", false);
    expect(piBinaryNotice(resolution)).toBeUndefined();
  });

  it("prefers the harness override when both overrides are set", () => {
    const resolution = resolvePiBinaryPath({
      env: {
        [BELAYD_PI_BINARY_ENV]: "/opt/explicit/pi",
        [PI_BINARY_PATH_ENV]: "/repo/bin/pi",
      },
      exists: () => true,
      pathLookup: noPath,
    });

    expect(resolution).toHaveProperty("binary", "/opt/explicit/pi");
  });

  it("falls back to the system binary and reports it", () => {
    const resolution = resolvePiBinaryPath({
      env: {},
      exists: (path) => path === SYSTEM_PI_BINARY,
      pathLookup: noPath,
    });

    expect(resolution).toHaveProperty("binary", SYSTEM_PI_BINARY);
    expect(resolution).toHaveProperty("source", "system");
    expect(resolution).toHaveProperty("fellBack", true);
    const notice = piBinaryNotice(resolution);
    expect(notice).toBeDefined();
    expect(String(notice)).toContain("Spawned agents inherit that binary's extension set");
    expect(String(notice)).toContain(BELAYD_PI_BINARY_ENV);
  });

  it("reports unresolved when no candidate exists", () => {
    const resolution = resolvePiBinaryPath({ env: {}, exists: () => false, pathLookup: noPath });

    expect(resolution).toHaveProperty("binary", undefined);
    expect(resolution).toHaveProperty("source", "unresolved");
    expect(resolution).toHaveProperty("fellBack", true);
    expect(String(piBinaryNotice(resolution))).toContain("no pi binary found");
  });
});
