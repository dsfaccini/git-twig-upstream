import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { report } from "../real-report.ts";
import { digest } from "../lib/results.ts";
const root = new URL("../../", import.meta.url);
test("published v0.5 real capture preserves the agreed protocol and interruption", async () => {
  const file = "bench/results/v0.5.0-real.json";
  const capture = JSON.parse(await readFile(new URL(file, root), "utf8"));
  expect(capture.protocol).toMatchObject({
    rounds: 3,
    concurrency: 1,
    warmup: true,
  });
  expect(
    Object.fromEntries(
      capture.inputs.map((r: { label: string; worktrees: number }) => [
        r.label,
        r.worktrees,
      ]),
    ),
  ).toEqual({
    "workers-starter": 10,
    twig: 10,
    axo: 1,
    openclaw: 1,
    pulumi: 1,
    linux: 1,
  });
  expect(
    Object.fromEntries(
      capture.inputs.map((r: { label: string; revision: string }) => [
        r.label,
        r.revision,
      ]),
    ),
  ).toEqual({
    "workers-starter": "d0b1ee485dc1cf2bc0b2a3511cf8cf1057624d02",
    twig: "96c43950e4c0d8524de4ad53157c136eb222d39c",
    axo: "67af816be26633039e8507d93d577b2073d6f5fd",
    openclaw: "410c0dda40702e25263b49b8b7d0786a5e49e366",
    pulumi: "430261138aa08539cd598b9269bfe8f82fd49b78",
    linux: "23c62304dde29abe92013d85910d03a77dada35d",
  });
  const result = await report(file, true);
  expect(result.creates).toBe(408);
  expect(result.cohorts).toBe(84);
  expect(result.interrupted).toBe(1);
  expect(capture.unmeasured.length).toBe(8);
  const mac = result.reported.filter((r) =>
    String(r.target).startsWith("macos"),
  );
  expect(mac.length).toBe(11);
  expect(mac.reduce((n, r) => n + r.creates, 0)).toBe(282);
  const directories = new Set<string>();
  for (const item of capture.observations) {
    directories.add(new URL(".", new URL(item.file, root)).pathname);
    expect(await digest(new URL(item.file, root).pathname)).toBe(item.sha256);
  }
  for (const directory of directories) {
    const index = JSON.parse(
      await readFile(directory + "artifact-index.json", "utf8"),
    );
    for (const artifact of index.artifacts) {
      expect(artifact.name.includes("/")).toBe(false);
      expect(await digest(directory + artifact.name)).toBe(artifact.sha256);
    }
  }
});
