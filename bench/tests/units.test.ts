import { expect, test } from "bun:test";
import { formatBytes } from "../lib/units.ts";
test("sizes retain honest readable units and never conflate missing with zero", () => {
  for (const [bytes, label] of [
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1 KiB"],
    [1536, "1.5 KiB"],
    [1024 ** 2 - 1, "1 MiB"],
    [1024 ** 2, "1 MiB"],
    [1024 ** 3, "1 GiB"],
    [-4096, "-4 KiB"],
    [null, "Unavailable"],
  ] as const)
    expect(formatBytes(bytes)).toBe(label);
  for (const bytes of [0.001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => formatBytes(bytes)).toThrow();
});
