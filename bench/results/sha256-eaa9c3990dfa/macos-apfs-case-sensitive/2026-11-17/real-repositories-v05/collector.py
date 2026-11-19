#!/usr/bin/env python3
"""Preserve a completed real-repository allocation campaign and audit its comparisons."""
import argparse
import csv
import hashlib
import json
import re
import shutil
import statistics
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect(source, output):
    manifest = json.loads((source / "manifest.json").read_text())
    state = json.loads((source / "state.json").read_text())
    require(state["phase"] == "completed", "campaign is not complete; retain partial evidence separately")
    require(len(state["completed"]) == len(manifest["jobs"]), "incomplete campaign")
    require(all(j["exitCode"] == 0 and not j["failures"] for j in state["completed"]),
            "failed campaign cannot certify comparisons")
    names = [j["name"] for j in manifest["jobs"]]
    require(len(set(names)) == len(names) and all(re.fullmatch(r"[a-z][a-z0-9-]*", n) for n in names),
            "unsafe or duplicate repository label")
    output.mkdir(parents=True, exist_ok=False)
    retained = ["manifest.json", "state.json", "run.ts", "shared-protocol.json", "controller.log"]
    observations, comparisons = [], []
    total = 0
    unstable = 0
    for job in manifest["jobs"]:
        name, count = job["name"], job["worktrees"]
        raw = json.loads((source / (name + ".json")).read_text())
        require(raw["schemaVersion"] == 4 and not raw["dirty"], "invalid/dirty result")
        require(raw["commit"] == manifest["harnessCheckoutCommit"], "harness checkout differs")
        require(raw["candidateSha256"] == manifest["binaries"]["git-twig"]["sha256"], "binary differs")
        require(raw["filesystem"] == manifest["config"]["filesystem"] and
                raw["imageSizeGib"] == manifest["config"]["imageGib"], "filesystem setup differs")
        require(raw["warmup"] and raw["requireNative"] and raw["selectedBackend"] is None,
                "unexpected backend/warmup policy")
        require(raw["gitVersion"] == manifest["gitVersion"], "Git version differs")
        require(raw["concurrency"] == 1 and raw["worktreesPerCohort"] == count and raw["repeats"] == 3,
                "batch configuration differs")
        require(not raw["failures"] and len(raw["cohorts"]) == 6, "failed/incomplete result")
        pairs = {(c["backend"], c["repeat"]) for c in raw["cohorts"]}
        require(pairs == {(b, r) for b in ("git", "twig") for r in range(3)}, "missing paired round")
        values = {"git": [], "twig": []}
        allocation_stable = True
        for cohort in raw["cohorts"]:
            require(cohort["repository"] == name and cohort["sourceCommit"] == job["revision"] and
                    cohort["targetCommit"] == job["revision"], "repository pin differs")
            require(cohort["failed"] == 0 and cohort["succeeded"] == count and
                    len(cohort["operations"]) == count, "incomplete cohort")
            require(cohort["sourceUnchanged"] and cohort["privateWriteTested"], "missing isolation checks")
            for op in cohort["operations"]:
                require(op["verified"] and op["exitCode"] == 0 and op["error"] is None,
                        "incorrect operation")
                if cohort["backend"] == "twig":
                    require(op["nativeCow"], "Twig did not use native CoW")
            total += count
            amount = cohort["growthAfterStatusBytes"]
            require(amount == cohort["afterStatus"]["allocatedBytes"] - cohort["before"]["allocatedBytes"],
                    "allocation delta differs")
            stable = cohort["before"]["stable"] and cohort["afterStatus"]["stable"]
            allocation_stable &= stable
            unstable += not stable
            values[cohort["backend"]].append(amount)
            observations.append(dict(repository=name, backend=cohort["backend"], repeat=cohort["repeat"],
                                     worktrees=count, verifiedCreates=count, allocationBytes=amount,
                                     allocationStable=stable, rawFile=name + ".json"))
        comparisons.append(dict(repository=name, worktrees=count, concurrency=1, pairedRounds=3,
                                verifiedCreates=count * 6, allocationStable=allocation_stable,
                                comparisonEligible=allocation_stable and min(values["git"] + values["twig"]) > 0,
                                gitMedianBytes=statistics.median(values["git"]),
                                twigMedianBytes=statistics.median(values["twig"]),
                                gitObservedBytes=values["git"], twigObservedBytes=values["twig"],
                                rawFile=name + ".json"))
        retained += [name + suffix for suffix in (".json", ".command.json", ".log")]
    summary = dict(schemaVersion=1, kind="real-repository-allocation-snapshot",
                   candidateSourceTag=manifest["candidateSourceTag"],
                   candidateSourceCommit=manifest["candidateSourceCommit"],
                   candidateSHA256=manifest["binaries"]["git-twig"]["sha256"],
                   manifestSHA256=digest(source / "manifest.json"),
                   verifiedCreates=total, failedCreates=0, unstableAllocationObservations=unstable,
                   completeComparisons=len(comparisons),
                   eligibleComparisons=sum(row["comparisonEligible"] for row in comparisons),
                   comparisons=comparisons,
                   notes=["All original observations are retained. No failed/unstable point was retried or replaced.",
                          "Medians for ineligible groups are diagnostic only, not an unqualified website comparison.",
                          "Case-sensitive APFS images on the recorded shared Mac. Additional allocation includes Git metadata after first status, not exclusive file allocation.",
                          "Repository pins and batch sizes match the historical v0.4 campaign; image capacities are not identical for every workload.",
                          "Raw timing observations remain archived but are not promoted as website measurements."])
    for name in retained:
        shutil.copyfile(source / name, output / name)
    shutil.copyfile(Path(__file__), output / "collector.py")
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    with (output / "observations.csv").open("x", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(observations[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(observations)
    artifacts = [dict(path=p.name, bytes=p.stat().st_size, sha256=digest(p))
                 for p in sorted(output.iterdir()) if p.is_file()]
    (output / "artifacts.json").write_text(json.dumps(dict(schemaVersion=1, artifacts=artifacts), indent=2) + "\n")
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(collect(args.campaign, args.output), indent=2))
