import { loadPreview } from "./preview.ts";
import type { PreviewDataset } from "./preview";

type Profile = PreviewDataset["profiles"][number];
type Measurement = Omit<
  NonNullable<Profile["measurements"]>[number],
  "backend"
> & { backend: "git" | "candidate" };
export type LatestDataset = Omit<PreviewDataset, "baseline" | "profiles"> & {
  profiles: {
    profile: string;
    label: string;
    measurements: [Measurement, Measurement] | null;
  }[];
};

export function loadBenchmarks(): { datasets: LatestDataset[] } {
  const { datasets } = loadPreview();
  return {
    datasets: datasets.map(({ baseline: _, profiles, ...dataset }) => ({
      ...dataset,
      profiles: profiles
        .filter((p) => p.profile !== "cross-revision")
        .map((p) => ({
          ...p,
          measurements: p.measurements
            ? [
                { ...p.measurements[0], backend: "git" },
                { ...p.measurements[2], backend: "candidate" },
              ]
            : null,
        })),
    })),
  };
}
