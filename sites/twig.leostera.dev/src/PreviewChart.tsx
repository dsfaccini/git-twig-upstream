import { useState } from "react";
import type { LatestDataset } from "../scripts/benchmarks";

export function disk(bytes: number): string {
  const magnitude = Math.abs(bytes);
  const unit =
    magnitude >= 2 ** 30
      ? ([2 ** 30, "GiB"] as const)
      : magnitude >= 2 ** 20
        ? ([2 ** 20, "MiB"] as const)
        : ([2 ** 10, "KiB"] as const);
  return `${(bytes / unit[0]).toFixed(2)} ${unit[1]}`;
}
function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}
const backendLabels = {
  git: "stock Git",
  candidate: "git twig",
};
const source = (path: string) =>
  `https://github.com/leostera/git-twig/blob/main/${path}`;

export function PreviewChart({ datasets }: { datasets: LatestDataset[] }) {
  const [target, setTarget] = useState(
    () =>
      new URLSearchParams(location.search).get("filesystem") ??
      datasets[0]!.target,
  );
  const [metric, setMetric] = useState<"bytes" | "timeMs">("bytes");
  const data = datasets.find((d) => d.target === target) ?? datasets[0]!;
  const values = data.profiles.flatMap(
    (p) => p.measurements?.map((m) => m[metric]) ?? [],
  );
  const lower = Math.min(0, ...values);
  const upper = Math.max(1, ...values);
  const scale = (value: number) => ((value - lower) / (upper - lower)) * 100;
  const format = metric === "bytes" ? disk : duration;
  function select(next: string) {
    setTarget(next);
    const url = new URL(location.href);
    url.searchParams.set("filesystem", next);
    history.replaceState(null, "", url);
  }
  return (
    <figure className="disk-chart preview-chart">
      <figcaption>
        <h2>{metric === "bytes" ? "Disk use" : "Creation time"}</h2>
        <span>v0.5 preview · unreleased</span>
      </figcaption>
      <div className="chart-controls" aria-label="Filesystem">
        {datasets.map((d) => (
          <button
            key={d.target}
            aria-pressed={d.target === data.target}
            onClick={() => select(d.target)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="chart-controls metric-controls" aria-label="Measurement">
        <button
          aria-pressed={metric === "bytes"}
          onClick={() => setMetric("bytes")}
        >
          Disk allocation
        </button>
        <button
          aria-pressed={metric === "timeMs"}
          onClick={() => setMetric("timeMs")}
        >
          Creation time
        </button>
        <span>lower is better</span>
      </div>
      <p className="chart-scale">
        Shared linear scale: {format(lower)} – {format(upper)}
      </p>
      <div className="preview-profiles">
        {data.profiles.map((profile) => (
          <section className="repo-group" key={profile.profile}>
            <div className="repo-heading">
              <h3>{profile.label}</h3>
            </div>
            {profile.measurements ? (
              profile.measurements.map((value) => (
                <div className="bar-row" key={value.backend}>
                  <code>{backendLabels[value.backend]}</code>
                  <div className="bar-track" aria-hidden="true">
                    <div
                      className={`bar ${value.backend}`}
                      style={{
                        left: `${Math.min(scale(0), scale(value[metric]))}%`,
                        width: `${(Math.abs(value[metric]) / (upper - lower)) * 100}%`,
                      }}
                    />
                  </div>
                  <span
                    title={
                      metric === "bytes"
                        ? `Observed range: ${disk(value.minBytes)} – ${disk(value.maxBytes)}`
                        : undefined
                    }
                  >
                    {format(value[metric])}
                  </span>
                </div>
              ))
            ) : (
              <p className="not-compared">
                Not compared: incomplete or unstable paired group.
              </p>
            )}
          </section>
        ))}
      </div>
      <p className="chart-notes">
        Median of {data.rounds} batches × {data.worktrees} sequential creates.
        Warm cache. Allocation includes Git metadata after first status.
      </p>
      <p
        className={`chart-health ${data.failedPoints || data.unstablePoints ? "has-issues" : ""}`}
      >
        {data.verifiedCreates} verified creates across all levels ·{" "}
        {data.failedPoints} failed{" "}
        {data.failedPoints === 1 ? "point" : "points"}
        {" · "}
        {data.unstablePoints} unstable observations retained.
        Incomplete/unstable groups are not compared.
      </p>
      <p className="chart-links">
        <a href={source(data.snapshot)}>Raw results</a>
        {" · "}
        <a href={source("bench/preview.md")}>Method & limitations</a>
        {" · "}
        <span>Synthetic workloads</span>
      </p>
    </figure>
  );
}
