import datetime, hashlib, json, os, pathlib, shutil, subprocess, time
root = pathlib.Path("/Users/leostera/Developer/github.com/leostera/git-twig/main/target/v05-real-macos-settled-2026-11-18")
prior = pathlib.Path("/Users/leostera/Developer/github.com/leostera/git-twig/main/target/v05-real-macos-2026-11-17")
transition = pathlib.Path("/Users/leostera/Developer/github.com/leostera/git-twig/main/target/v05-real-macos-stability-2026-11-18/settling-window-transition.json")
worktree = pathlib.Path("/Users/leostera/Developer/github.com/leostera/git-twig/bench-apfs-allocation-settling")
target = pathlib.Path("/Users/leostera/Developer/github.com/leostera/git-twig/feat-integrate-adopt/target/build")
def status(phase, **extra):
    p=root/"launch.json"; temp=root/"launch.tmp"
    temp.write_text(json.dumps(dict(phase=phase, pid=os.getpid(), updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), **extra), indent=2)+"\n")
    temp.replace(p)
def workers():
    r=subprocess.run(["pgrep","-x","twig-real-bench"],capture_output=True,text=True)
    return [int(x) for x in r.stdout.split()]
try:
    while not transition.exists() or workers():
        status("waiting-for-complete-prior-attempt", otherWorkerPids=workers())
        time.sleep(10)
    sha=subprocess.check_output(["git","rev-parse","HEAD"],cwd=worktree,text=True).strip()
    assert sha.startswith("7ead6c9")
    assert not subprocess.check_output(["git","status","--porcelain"],cwd=worktree,text=True).strip()
    status("building-sampler-only")
    env=dict(os.environ, CARGO_TARGET_DIR=str(target))
    with (root/"build.log").open("x") as log:
        subprocess.run([str(pathlib.Path.home()/".cargo/bin/cargo"),"build","-p","twig-bench","--bin","twig-real-bench","--release","--locked"],cwd=worktree,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
    (root/"bin").mkdir(exist_ok=True)
    originals=json.loads((prior/"manifest.json").read_text())
    binaries={}
    for name in ["git-twig","git","twig-real-bench"]:
        source=target/"release/twig-real-bench" if name=="twig-real-bench" else pathlib.Path(originals["binaries"][name]["path"])
        dest=root/"bin"/name
        shutil.copy2(source,dest)
        digest=hashlib.sha256(dest.read_bytes()).hexdigest()
        if name!="twig-real-bench":assert digest==originals["binaries"][name]["sha256"]
        binaries[name]=dict(path=str(dest),sha256=digest)
    (root/"frozen-binaries.json").write_text(json.dumps(binaries,indent=2)+"\n")
    (root/"harness-build.json").write_text(json.dumps(dict(sourceCommit=sha,sourceDirty=False,candidateUnchanged=True,oldSamplingBudgetSeconds=3,newSamplingBudgetSeconds=60,intervalMs=250,identicalConsecutiveReadings=3),indent=2)+"\n")
    with (root/"controller.log").open("x") as log:
        child=subprocess.Popen(["/opt/homebrew/bin/bun",str(root/"run.ts")],cwd=worktree,stdout=log,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL)
        status("running",supervisorPid=child.pid,workerSourceCommit=sha)
        result=child.wait()
        status("controller-exited",supervisorPid=child.pid,exitCode=result)
except Exception as exc:
    status("failed",error=str(exc))
    raise
