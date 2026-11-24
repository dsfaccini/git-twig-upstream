#!/usr/bin/env python3
"""Retain all allocation attempts and qualify final comparisons without altering raw data."""
import argparse
import hashlib
import json
import shutil
import statistics
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(path, manifest, job, require_stable=False):
    run = json.loads(path.read_text())
    require(run["schemaVersion"] == 4 and not run["dirty"] and not run["failures"], "invalid result")
    require(run["candidateSha256"] == manifest["binaries"]["git-twig"]["sha256"], "candidate differs")
    require(run["commit"] == manifest["harnessCheckoutCommit"], "checkout identity differs")
    require(run["filesystem"] == "case-sensitive-image" and run["imageSizeGib"] == 32,
            "filesystem layout differs")
    require(run["warmup"] and run["concurrency"] == 1 and run["worktreesPerCohort"] == job["worktrees"],
            "batch policy differs")
    cohorts = run["cohorts"]
    require(len(cohorts) == 6 and {(c["backend"], c["repeat"]) for c in cohorts} ==
            {(b, r) for b in ("git", "twig") for r in range(3)}, "incomplete pairs")
    unstable = 0
    values = {"git": [], "twig": []}
    for c in cohorts:
        require(c["sourceCommit"] == c["targetCommit"] == job["revision"], "repository pin differs")
        require(c["sourceUnchanged"] and c["privateWriteTested"], "isolation checks missing")
        require(c["failed"] == 0 and c["succeeded"] == job["worktrees"] and
                len(c["operations"]) == job["worktrees"], "incomplete cohort")
        for op in c["operations"]:
            require(op["verified"] and op["exitCode"] == 0 and op["error"] is None,
                    "incorrect operation")
            require(c["backend"] != "twig" or op["nativeCow"], "not native CoW")
        stable = c["before"]["stable"] and c["afterStatus"]["stable"]
        unstable += not stable
        if require_stable:
            require(stable, "selected comparison is not stable")
        amount = c["growthAfterStatusBytes"]
        require(amount == c["afterStatus"]["allocatedBytes"] - c["before"]["allocatedBytes"],
                "allocation delta differs")
        values[c["backend"]].append(amount)
    return dict(repository=job["name"], worktrees=job["worktrees"], concurrency=1, pairedRounds=3,
                verifiedCreates=job["worktrees"] * 6, unstableAllocationObservations=unstable,
                comparisonEligible=unstable == 0 and min(values["git"] + values["twig"]) > 0,
                gitMedianBytes=statistics.median(values["git"]),
                twigMedianBytes=statistics.median(values["twig"]),
                gitObservedBytes=values["git"], twigObservedBytes=values["twig"],
                rawSHA256=digest(path))


def copy_evidence(source, output):
    output.mkdir(parents=True, exist_ok=False)
    for path in sorted(source.rglob("*")):
        if not path.is_file() or path.suffix not in (".json", ".log", ".ts", ".py"):
            continue
        require(not path.is_symlink(), "evidence cannot be a symlink")
        destination = output / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)


def collect(original, short, settled, output):
    original_manifest = json.loads((original / "manifest.json").read_text())
    short_manifest = json.loads((short / "manifest.json").read_text())
    settled_manifest = json.loads((settled / "manifest.json").read_text())
    state = json.loads((settled / "state.json").read_text())
    require(state["phase"] == "completed" and set(state["qualified"]) == {"openclaw", "pulumi"},
            "settled campaign is incomplete")
    original_jobs = {j["name"]: j for j in original_manifest["jobs"]}
    require(original_manifest["binaries"]["git-twig"]["sha256"] ==
            short_manifest["binaries"]["git-twig"]["sha256"] ==
            settled_manifest["binaries"]["git-twig"]["sha256"], "candidate changed across attempts")
    selected, history = [], []
    total = unstable = 0
    for name, job in original_jobs.items():
        row = audit(original / (name + ".json"), original_manifest, job)
        row["campaign"] = "original"
        history.append(row)
        total += row["verifiedCreates"]
        unstable += row["unstableAllocationObservations"]
        if name not in state["qualified"]:
            require(row["comparisonEligible"], "original selected group is not stable")
            row = dict(row, rawFile=str(original / (name + ".json")))
            selected.append(row)
    for source, manifest, label in [(short, short_manifest, "three-second-followup"),
                                    (settled, settled_manifest, "sixty-second-followup")]:
        for path in sorted(source.glob("*-attempt-*/*.json")):
            if path.name in ("command.json", "assessment.json"):
                continue
            name = path.stem
            require(name in original_jobs, "unknown repository")
            row = audit(path, manifest, original_jobs[name])
            row.update(campaign=label, attempt=path.parent.name)
            history.append(row)
            total += row["verifiedCreates"]
            unstable += row["unstableAllocationObservations"]
            if label == "sixty-second-followup" and str(path.resolve()) == state["qualified"][name]:
                row = audit(path, manifest, original_jobs[name], require_stable=True)
                selected.append(dict(row, rawFile=str(Path("settled") / path.relative_to(source))))
    require(len(selected) == 6 and all(r["comparisonEligible"] for r in selected), "missing stable comparison")
    copy_evidence(short, output / "three-second-followup")
    copy_evidence(settled, output / "settled")
    summary = dict(schemaVersion=1, kind="qualified-real-repository-allocation",
                   candidateSourceTag=original_manifest["candidateSourceTag"],
                   candidateSourceCommit=original_manifest["candidateSourceCommit"],
                   candidateSHA256=original_manifest["binaries"]["git-twig"]["sha256"],
                   verifiedCreatesAcrossRetainedAttempts=total, failedCreates=0,
                   unstableAllocationObservationsRetained=unstable,
                   originalSnapshot=str(original),
                   comparisons=sorted(selected, key=lambda row: list(original_jobs).index(row["repository"])),
                   attempts=history,
                   notes=["Every original and follow-up attempt is retained, including unstable observations.",
                          "The unchanged published v0.5.0 binary is compared with stock Git on real repositories.",
                          "Only the macOS harness allocation-sampling budget changed from 3 to 60 seconds. The three-identical-consecutive-readings criterion and 250 ms interval did not change.",
                          "First fully stable complete three-round paired campaign was selected per rerun repository, by stability rather than measured savings.",
                          "Four original comparisons already met the same stability criterion; OpenClaw and Pulumi use the 60-second-budget follow-up.",
                          "Additional case-sensitive APFS allocation after first status includes metadata; not exclusive file allocation.",
                          "These were allocation-refresh campaigns, not a controlled host-latency refresh. Another independently launched campaign was discovered on the shared Mac during the original run; raw timings remain evidence, not automatically eligible speed claims."])
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    shutil.copyfile(Path(__file__), output / "collector.py")
    artifacts = [dict(path=str(p.relative_to(output)), bytes=p.stat().st_size, sha256=digest(p))
                 for p in sorted(output.rglob("*")) if p.is_file()]
    (output / "artifacts.json").write_text(json.dumps(dict(schemaVersion=1, artifacts=artifacts), indent=2) + "\n")
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", required=True, type=Path)
    parser.add_argument("--short", required=True, type=Path)
    parser.add_argument("--settled", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(collect(args.original, args.short, args.settled, args.output), indent=2))
