import json, os, pathlib, signal, time, datetime
root = pathlib.Path("/Users/leostera/Developer/github.com/leostera/git-twig/main/target/v05-real-macos-stability-2026-11-18")
controller, child = 78562, 14416
def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
while alive(child) and alive(controller):
    time.sleep(2)
if alive(controller):
    for _ in range(20):
        state = json.loads((root / "state.json").read_text())
        if state["phase"] != "running" and not state.get("childPid"):
            break
        time.sleep(0.5)
    else:
        raise RuntimeError("Refusing to stop controller while a worker may still be running")
    note = dict(schemaVersion=1, stoppedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                reason="Pause between complete attempts to extend APFS allocation settling from 3 seconds to 60 seconds without changing the three-identical-reading criterion or the published candidate.",
                controllerPid=controller, finishedWorkerPid=child, lastState=state)
    (root / "settling-window-transition.json").write_text(json.dumps(note, indent=2) + "\n")
    os.kill(controller, signal.SIGTERM)
