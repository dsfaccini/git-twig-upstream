#!/usr/bin/env python3
"""Publish an existing tag's portable Linux rebuild without deleting old assets."""
import hashlib
import json
import os
import pathlib
import re
import subprocess


def run(*arguments):
    return subprocess.check_output(arguments, text=True)


def rename_plan(assets, names, run_id):
    if not re.fullmatch(r"[0-9]+", run_id):
        raise ValueError("expected a GitHub run ID")
    plan = []
    for name in names:
        matches = [asset for asset in assets if asset.get("name") == name]
        if len(matches) != 1 or type(matches[0].get("id")) is not int:
            raise ValueError("expected exactly one existing asset: " + name)
        preserved = f"pre-rebuild-{run_id}-{name}"
        if any(asset.get("name") == preserved for asset in assets):
            raise ValueError("refusing to overwrite preserved asset: " + preserved)
        plan.append({"id": matches[0]["id"], "original": name, "preserved": preserved})
    return plan


def main():
    tag = os.environ["TARGET_TAG"]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("expected a stable release tag")
    repository = os.environ["GITHUB_REPOSITORY"]
    run_id = os.environ["GITHUB_RUN_ID"]
    directory = pathlib.Path("dist")
    build = json.loads((directory / "build-info.json").read_text())
    if build["tag"] != tag or build["sourceCommit"] != run("git", "rev-parse", tag + "^{commit}").strip():
        raise ValueError("rebuilt archive does not match the unchanged release tag")
    linux = f"git-twig-{tag}-x86_64-unknown-linux-gnu.tar.gz"
    if not (directory / linux).is_file():
        raise ValueError("missing rebuilt Linux archive")
    endpoint = f"repos/{repository}/releases/tags/{tag}"
    release = json.loads(run("gh", "api", endpoint))
    plan = rename_plan(release["assets"], [linux, "SHA256SUMS", "git-twig.rb"], run_id)
    run("gh", "release", "download", tag, "--pattern", f"git-twig-{tag}-*-apple-darwin.tar.gz", "--dir", str(directory))
    archives = [directory / f"git-twig-{tag}-{target}.tar.gz" for target in [
        "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu",
    ]]
    checksums = "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path}\n" for path in archives)
    (directory / "SHA256SUMS").write_text(checksums)
    formula = run("python3", "scripts/release-formula.py", tag[1:], str(directory))
    (directory / "git-twig.rb").write_text(formula)
    # Preparation and provenance checks finish before any public asset changes.
    # Preserve every original by ID; uploads intentionally do not use --clobber.
    for asset in plan:
        print(f"Preserving {asset['original']} as {asset['preserved']}", flush=True)
        run("gh", "api", "--method", "PATCH", f"repos/{repository}/releases/assets/{asset['id']}",
            "-f", "name=" + asset["preserved"], "-f", "label=Superseded Linux-build metadata; retained for provenance")
    manifest = directory / f"linux-build-info-{run_id}.json"
    manifest.write_text(json.dumps({**build, "runId": run_id, "preservedAssets": plan}, indent=2) + "\n")
    run("gh", "release", "upload", tag, str(directory / linux), str(directory / "SHA256SUMS"),
        str(directory / "git-twig.rb"), str(manifest))
    pathlib.Path("Formula/git-twig.rb").write_text(formula)


if __name__ == "__main__":
    main()
