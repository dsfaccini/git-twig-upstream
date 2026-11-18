import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { report } from "../real-report.ts";
import { digest } from "../lib/results.ts";
const root = new URL("../../", import.meta.url);
test("Linux release data is complete, settled, byte-certified and display-safe", async () => {
  const capture = JSON.parse(
    await readFile(
      new URL("bench/results/v0.5.0-linux-stable.json", root),
      "utf8",
    ),
  );
  const result = await report("bench/results/v0.5.0-linux-stable.json", true);
  expect(result.creates).toBe(288);
  expect(result.cohorts).toBe(72);
  expect(result.interrupted).toBe(0);
  expect(capture.unmeasured).toEqual([]);
  expect(result.reported.length).toBe(12);
  expect(result.reported.every((r) => r.allocationComparable)).toBe(true);
  for (const target of ["linux-xfs", "linux-btrfs"])
    expect(
      result.reported
        .filter((r) => r.target === target)
        .map((r) => r.repository)
        .sort(),
    ).toEqual([
      "axo",
      "linux",
      "openclaw",
      "pulumi",
      "twig",
      "workers-starter",
    ]);
  for (const entry of capture.observations) {
    const raw = new URL(entry.file, root),
      derived = JSON.parse(
        await readFile(
          new URL(entry.file.replace(".json", ".report.json"), root),
          "utf8",
        ),
      );
    expect(await digest(raw.pathname)).toBe(entry.sha256);
    for (const display of derived.allocationDisplay) {
      expect(display.label).toMatch(
        /^-?[0-9][0-9,.]* (B|KiB|MiB|GiB|TiB|PiB)$/,
      );
      expect(display.label).not.toMatch(/^0\.0/);
    }
    const index = JSON.parse(
      await readFile(new URL("artifact-index.json", new URL(".", raw)), "utf8"),
    );
    for (const file of index.artifacts)
      expect(await digest(new URL(file.name, new URL(".", raw)).pathname)).toBe(
        file.sha256,
      );
  }
});
