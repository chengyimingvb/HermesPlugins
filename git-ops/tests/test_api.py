"""Backend route tests for the git-ops dashboard half.

Run with the Hermes venv python:
  <install>/venv/Scripts/python.exe tests/test_api.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
HERMES_WORKSPACE = Path(os.environ.get("HERMES_WORKSPACE", r"C:\Users\as850\AppData\Local\hermes\installs"
                                       r"\4b4c15b9b806dbf1\environments\f4d4c5cb0f0e4ab7a803513ce3c4cefb\workspace"))
for extra in (str(HERMES_WORKSPACE),):
    if extra not in sys.path:
        sys.path.insert(0, extra)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from test_gitops import Fixture  # noqa: E402


def load_api():
    name = "hermes_gitops_api"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    api = load_api()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/git-ops")
    client = TestClient(app)
    fx = Fixture()
    failures = []

    def check(label, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + label + ("" if cond else f" :: {detail}"))
        if not cond:
            failures.append(label)

    try:
        work = str(fx.work)
        r = client.get("/api/plugins/git-ops/repos", params={"roots": str(fx.root), "cwd": work}).json()
        check("GET /repos ok", r.get("ok"), r)
        kinds = {Path(x["path"]).name: x["kind"] for x in r["data"]["repos"]}
        check("scan sees submodule", kinds.get("lib") == "submodule", kinds)

        r = client.get("/api/plugins/git-ops/status", params={"repo": ".", "cwd": work}).json()
        check("GET /status branch", r["ok"] and r["data"]["branch"] == "main", r)

        fx.write(fx.work, "api.txt", "x\n")
        r = client.get("/api/plugins/git-ops/diff",
                       params={"repo": ".", "path": "api.txt", "cwd": work}).json()
        check("GET /diff (new file)", r.get("ok") and "api.txt" in r["data"]["diff"], r)

        (fx.work / "readme.txt").write_text("hello\nchanged\n", encoding="utf-8")
        r = client.get("/api/plugins/git-ops/diff",
                       params={"repo": ".", "path": "readme.txt", "cwd": work}).json()
        check("GET /diff (tracked) has +++ b/ header",
              r.get("ok") and "+++ b/readme.txt" in r["data"]["diff"], r)

        r = client.post("/api/plugins/git-ops/commit-info",
                        json={"repo": ".", "paths": ["api.txt"], "cwd": work}).json()
        check("POST /commit-info", r.get("ok") and r["data"]["header"], r)
        message = r["data"]["message"] if r.get("ok") else ""

        r = client.post("/api/plugins/git-ops/commit",
                        json={"repo": ".", "paths": ["api.txt"], "message": message, "cwd": work}).json()
        check("POST /commit", r.get("ok") and r["data"]["sha"], r)

        r = client.post("/api/plugins/git-ops/push", json={"repo": ".", "cwd": work}).json()
        check("POST /push verified", r.get("ok") and r["data"]["verified"], r)

        r = client.post("/api/plugins/git-ops/pull",
                        json={"repo": ".", "cwd": work, "submodules": False}).json()
        check("POST /pull no-op", r.get("ok") and r["data"]["behind"] == 0, r)

        r = client.post("/api/plugins/git-ops/commit",
                        json={"repo": ".", "paths": ["missing.txt"], "cwd": work}).json()
        check("POST /commit rejects bad path", r.get("ok") is False and "not present" in r["error"], r)

        # TortoiseGit bridge: stub the process so no GUI window opens during the test.
        calls = []
        real_subprocess, real_exe = api.subprocess, api._tgit_exe

        class FakePopen:
            def __init__(self, args, **kwargs):
                calls.append(list(args))

        class FakeSubprocess:
            # Only the api module's binding is shadowed: gitops keeps the real
            # module, so its own git subprocesses still run.
            Popen = FakePopen
            DETACHED_PROCESS = getattr(real_subprocess, "DETACHED_PROCESS", 0)
            CREATE_NEW_PROCESS_GROUP = getattr(real_subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

        api.subprocess = FakeSubprocess
        api._tgit_exe = lambda: r"C:\Program Files\TortoiseGit\bin\TortoiseGitProc.exe"
        try:
            r = client.get("/api/plugins/git-ops/tgit",
                           params={"repo": ".", "path": "readme.txt", "cwd": work}).json()
            check("GET /tgit launches", r.get("ok") and r["data"]["launched"], r)
            args = calls[0] if calls else []
            check("GET /tgit asks for /command:diff with an absolute path",
                  len(args) == 4 and args[1] == "/command:diff" and args[2].startswith("/path:")
                  and args[2].lower().replace("\\", "/").endswith("readme.txt"), args)

            fx.write(fx.work, "tgit-untracked.txt", "x\n")
            r = client.get("/api/plugins/git-ops/tgit",
                           params={"repo": ".", "path": "tgit-untracked.txt", "cwd": work}).json()
            check("GET /tgit refuses untracked", r.get("ok") is False and "untracked" in r["error"], r)

            r = client.get("/api/plugins/git-ops/tgit",
                           params={"repo": ".", "path": "../escape.txt", "cwd": work}).json()
            check("GET /tgit refuses a path outside the repo",
                  r.get("ok") is False and "escapes" in r["error"], r)

            api._tgit_exe = lambda: (_ for _ in ()).throw(api.gitops.GitOpsError("not installed"))
            r = client.get("/api/plugins/git-ops/tgit",
                           params={"repo": ".", "path": "readme.txt", "cwd": work}).json()
            check("GET /tgit reports a missing TortoiseGit", r.get("ok") is False
                  and "not installed" in r["error"], r)
        finally:
            api.subprocess, api._tgit_exe = real_subprocess, real_exe
    finally:
        fx.close()
    print(f"\nSUMMARY: {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
