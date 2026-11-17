import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "../lib/results.ts";

const root = new URL("../../", import.meta.url).pathname;
test("all historical artifacts retain their original byte hashes at unique canonical paths", async () => {
  const index = JSON.parse(
    await readFile(resolve(root, "bench/results/index.json"), "utf8"),
  );
  expect(index.schemaVersion).toBe(1);
  expect(index.artifacts.length).toBe(184);
  const originals = new Set<string>(),
    destinations = new Set<string>();
  for (const artifact of index.artifacts) {
    expect(originals.has(artifact.originalPath)).toBe(false);
    originals.add(artifact.originalPath);
    expect(destinations.has(artifact.path)).toBe(false);
    destinations.add(artifact.path);
    expect(artifact.path).toMatch(
      /^bench\/results\/[^/]+\/[^/]+\/\d{4}-\d{2}-\d{2}\//,
    );
    expect(await digest(resolve(root, artifact.path))).toBe(artifact.sha256);
  }
});
test("Linux campaign preserves all verified observations and interrupted diagnostics", async () => {
  const index = JSON.parse(
    await readFile(resolve(root, "bench/results/index.json"), "utf8"),
  );
  const artifact = index.artifacts.find((r: { originalPath: string }) =>
    r.originalPath.endsWith("2026-11-17-linux-coverage/snapshot.json"),
  );
  const snapshot = JSON.parse(
    await readFile(resolve(root, artifact.path), "utf8"),
  );
  expect(
    snapshot.manifest.points.filter((p: { verified: boolean }) => p.verified)
      .length,
  ).toBe(135);
  expect(snapshot.partialCreationProgress).not.toBeNull();
  expect(snapshot.runs.length).toBe(136);
});
