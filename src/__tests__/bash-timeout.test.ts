import { describe, expect, it } from "vitest";
import {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  resolveBashTimeout,
} from "../bash-timeout.js";

describe("resolveBashTimeout", () => {
  it("uses the documented 600s default and 1800s cap", () => {
    expect(BASH_DEFAULT_TIMEOUT_SECONDS).toBe(600);
    expect(BASH_MAX_TIMEOUT_SECONDS).toBe(1800);
  });

  const cases: Array<{ name: string; timeout: unknown; expected: number }> = [
    { name: "missing timeout falls back to the default", timeout: undefined, expected: 600 },
    { name: "in-range value is preserved", timeout: 60, expected: 60 },
    { name: "the cap itself is preserved", timeout: 1800, expected: 1800 },
    { name: "above the cap is clamped", timeout: 3600, expected: 1800 },
    { name: "zero falls back to the default", timeout: 0, expected: 600 },
    { name: "negative falls back to the default", timeout: -30, expected: 600 },
    { name: "NaN falls back to the default", timeout: Number.NaN, expected: 600 },
    {
      name: "Infinity falls back to the default",
      timeout: Number.POSITIVE_INFINITY,
      expected: 600,
    },
    { name: "non-number falls back to the default", timeout: "120", expected: 600 },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveBashTimeout({ timeout: testCase.timeout })).toBe(testCase.expected);
    });
  }
});
