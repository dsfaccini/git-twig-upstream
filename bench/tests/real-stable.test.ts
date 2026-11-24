import { expect, test } from "bun:test";
import { classifyAttempt } from "../real-stable.ts";
test("only the first complete stable paired job qualifies; only allocation may retry", () => {
  const success = {
    status: "completed",
    jobs: [{ status: "completed", verified: true, allocationComparable: true }],
  };
  expect(classifyAttempt(0, success)).toBe("accepted");
  const unstable = {
    status: "failed",
    stopReason: "Error: Allocation did not settle",
    jobs: [{ status: "failed", verified: true, allocationComparable: false }],
  };
  expect(classifyAttempt(1, unstable)).toBe("retry-allocation");
  expect(classifyAttempt(1, { ...unstable, status: "interrupted" })).toBe(
    "terminal",
  );
  expect(
    classifyAttempt(1, {
      ...unstable,
      stopReason: "Private write changed source bytes",
    }),
  ).toBe("terminal");
  expect(
    classifyAttempt(1, {
      ...unstable,
      jobs: [
        { status: "failed", verified: false, allocationComparable: false },
      ],
    }),
  ).toBe("terminal");
  expect(classifyAttempt(1, success)).toBe("terminal");
  expect(
    classifyAttempt(0, {
      ...success,
      jobs: [
        { status: "completed", verified: true, allocationComparable: false },
      ],
    }),
  ).toBe("terminal");
});
