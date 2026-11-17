import { readFileSync } from "node:fs";
import { z } from "zod";

const revision = z.string().regex(/^[a-f0-9]{40}$/);
const identity = z.object({
  sourceCommit: revision,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const measurement = z
  .object({
    backend: z.enum(["git", "baseline", "candidate"]),
    timeMs: z.number().finite().positive(),
    bytes: z.number().finite(),
    minBytes: z.number().finite(),
    maxBytes: z.number().finite(),
  })
  .refine(
    (value) => value.minBytes <= value.bytes && value.bytes <= value.maxBytes,
    "Median must lie inside allocation range",
  );
const profile = z
  .object({
    profile: z.string(),
    label: z.string(),
    measurements: z.tuple([measurement, measurement, measurement]).nullable(),
  })
  .refine(
    (value) =>
      !value.measurements ||
      value.measurements.map((m) => m.backend).join(",") ===
        "git,baseline,candidate",
    "Need all three named backends in order",
  );
const dataset = z.object({
  label: z.string(),
  target: z.string(),
  snapshot: z
    .string()
    .startsWith("bench/results/")
    .refine((path) => !path.split("/").includes("..")),
  snapshotSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  candidate: identity,
  baseline: identity,
  status: z.enum(["completed", "failed", "stopped"]),
  verifiedCreates: z.number().int().nonnegative(),
  failedPoints: z.number().int().nonnegative(),
  unstablePoints: z.number().int().nonnegative(),
  rounds: z.number().int().min(3),
  worktrees: z.literal(2),
  concurrency: z.literal(1),
  profiles: z.array(profile).length(6),
});
export const previewSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("twig-checkout-preview"),
    datasets: z.array(dataset).length(4),
  })
  .refine(
    (value) => new Set(value.datasets.map((d) => d.target)).size === 4,
    "Duplicate target",
  )
  .refine(
    (value) =>
      new Set(value.datasets.map((d) => d.candidate.sourceCommit)).size === 1,
    "Mixed candidate source revisions",
  );

export type PreviewDataset = z.infer<typeof dataset>;
export const previewFile = new URL(
  "../../../bench/results/preview.json",
  import.meta.url,
);
export function loadPreview() {
  return previewSchema.parse(JSON.parse(readFileSync(previewFile, "utf8")));
}
