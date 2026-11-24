import type { DiskComparison } from "../scripts/benchmarks";

function disk(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MiB`;
}
export function DiskChart({ data }: { data: DiskComparison[] }) {
  const scale = Math.max(
    1,
    ...data.map((repo) => repo.twigBytes / repo.gitBytes),
  );
  return (
    <figure className="disk-chart">
      <figcaption>
        <h2>Disk use</h2>
        <span>Git = 100%</span>
      </figcaption>
      {data.map((repo) => {
        const saved = (1 - repo.twigBytes / repo.gitBytes) * 100;
        const rows = [
          { label: "git worktree", bytes: repo.gitBytes, kind: "git" },
          { label: "git twig", bytes: repo.twigBytes, kind: "twig" },
        ];
        return (
          <section className="repo-group" key={repo.name}>
            <div className="repo-heading">
              <h3>
                <a href={repo.source}>{repo.name}</a>
                {repo.worktrees > 1 && (
                  <small className="cohort-count" title={`${repo.worktrees} sequential worktrees`}>×{repo.worktrees}</small>
                )}
              </h3>
              <span className={saved >= 0 ? "less" : "more"}>
                {Math.abs(saved).toFixed(1)}% {saved >= 0 ? "less" : "more"}
              </span>
            </div>
            <p className="sr-only">
              {repo.worktrees} worktrees, {repo.concurrency} in flight.
              Additional filesystem allocation after first status; {repo.rounds} local
              rounds. Bar lengths are relative to Git for each repo, not
              absolute across repos.
            </p>
            <div className="bars">
              {rows.map(({ label, bytes, kind }) => (
                <div className="bar-row" key={label}>
                  <code>{label}</code>
                  <div className="bar-track">
                    <div
                      className={`bar ${kind}`}
                      style={{
                        width: `${(bytes / repo.gitBytes / scale) * 100}%`,
                      }}
                    />
                  </div>
                  <span>{disk(bytes)}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </figure>
  );
}
