"""Backend route tests for the git-ops dashboard half.

Run with any python that has fastapi installed:
  python tests/test_api.py

No Hermes install path and no model call are needed: the LLM door is stubbed, so this
file cannot drift onto one machine's install layout.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from test_gitops import Fixture, FakeLlm  # noqa: E402

BASE = "/api/plugins/git-ops"


def load_api():
    name = "hermes_gitops_api"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    api = load_api()
    api._llm = lambda: FakeLlm()  # never reach the real model/config here
    app = FastAPI()
    app.include_router(api.router, prefix=BASE)
    client = TestClient(app)
    fx = Fixture()
    failures = []

    def check(label, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + label + ("" if cond else f" :: {detail}"))
        if not cond:
            failures.append(label)

    try:
        work = str(fx.work)
        r = client.get(f"{BASE}/repos", params={"roots": str(fx.root), "cwd": work}).json()
        check("GET /repos ok", r.get("ok"), r)
        kinds = {Path(x["path"]).name: x["kind"] for x in r["data"]["repos"]}
        check("scan sees submodule", kinds.get("lib") == "submodule", kinds)
        check("scan lists each repo once",
              len(r["data"]["repos"]) == len({x["path"].lower() for x in r["data"]["repos"]}), kinds)

        r = client.get(f"{BASE}/status", params={"repo": ".", "cwd": work}).json()
        check("GET /status branch", r["ok"] and r["data"]["branch"] == "main", r)

        # 面板拉取靠这一条：plugin_api.py 只在挂载时 import 一次，所以两次请求之间
        # 修改 gitops.py 也必须生效，否则部署后仍跑旧代码直到 gateway 重启。
        probe = fx.root / "core-probe"
        probe.mkdir()
        core = probe / "gitops.py"
        core.write_text("VALUE = 'v1'\n", encoding="utf-8")
        check("core reload v1", api._load_gitops(core).VALUE == "v1")
        core.write_text("VALUE = 'v2'\n", encoding="utf-8")
        os.utime(core, (1, 1))  # 保证 mtime 与第一次不同
        check("core reload follows the file on disk", api._load_gitops(core).VALUE == "v2", core.stat().st_mtime_ns)

        r = client.get(f"{BASE}/status", params={"repo": ".", "cwd": ""}).json()
        check("GET /status without cwd does not scan $HOME", r.get("ok") is False or r["data"]["path"], r)

        r = client.get(f"{BASE}/files", params={"repo": ".", "cwd": work}).json()
        check("GET /files ok", r.get("ok") and r["data"]["count"] >= 1, r)
        fx.write(fx.work, "ignored-by-api.tmp", "x\n")
        r = client.get(f"{BASE}/files", params={"repo": ".", "cwd": work,
                                                "include_untracked": "false"}).json()
        check("GET /files include_untracked=false drops untracked",
              r.get("ok") and "ignored-by-api.tmp" not in r["data"]["files"], r)
        (fx.work / "ignored-by-api.tmp").unlink()

        fx.write(fx.work, "api.txt", "x\n")
        r = client.get(f"{BASE}/diff", params={"repo": ".", "path": "api.txt", "cwd": work}).json()
        check("GET /diff (new file)", r.get("ok") and "api.txt" in r["data"]["diff"], r)

        fx.write(fx.work, "api-fresh.txt", "fresh body\n")
        r = client.get(f"{BASE}/diff", params={"repo": ".", "path": "api-fresh.txt", "cwd": work,
                                              "untracked": "true"}).json()
        check("GET /diff untracked=true reads the file, no git call",
              r.get("ok") and "fresh body" in r["data"]["diff"], r)
        (fx.work / "api-fresh.txt").unlink()

        (fx.work / "readme.txt").write_text("hello\nchanged\n", encoding="utf-8")
        r = client.get(f"{BASE}/diff", params={"repo": ".", "path": "readme.txt", "cwd": work}).json()
        check("GET /diff (tracked) has +++ b/ header",
              r.get("ok") and "+++ b/readme.txt" in r["data"]["diff"], r)

        r = client.get(f"{BASE}/diff",
                       params={"repo": ".", "path": "../escape.txt", "cwd": work}).json()
        check("GET /diff refuses a path outside the repo",
              r.get("ok") is False and "escapes" in r["error"], r)

        fx.write(fx.work, "my file.txt", "spaced\n")
        r = client.get(f"{BASE}/diff", params={"repo": ".", "path": "my file.txt", "cwd": work}).json()
        check("GET /diff handles a path with a space",
              r.get("ok") and "my file.txt" in r["data"]["diff"] and "spaced" in r["data"]["diff"], r)

        r = client.post(f"{BASE}/commit-info",
                        json={"repo": ".", "paths": ["api.txt"], "cwd": work}).json()
        check("POST /commit-info", r.get("ok") and r["data"]["header"], r)
        message = r["data"]["message"] if r.get("ok") else ""

        r = client.post(f"{BASE}/commit",
                        json={"repo": ".", "paths": ["api.txt"], "message": message,
                              "cwd": work}).json()
        check("POST /commit", r.get("ok") and r["data"]["sha"], r)

        r = client.post(f"{BASE}/push", json={"repo": ".", "cwd": work}).json()
        check("POST /push verified", r.get("ok") and r["data"]["verified"], r)

        r = client.post(f"{BASE}/pull",
                        json={"repo": ".", "cwd": work, "submodules": False}).json()
        check("POST /pull no-op", r.get("ok") and r["data"]["behind"] == 0, r)

        r = client.post(f"{BASE}/commit",
                        json={"repo": ".", "paths": ["missing.txt"], "cwd": work}).json()
        check("POST /commit rejects bad path", r.get("ok") is False and "not present" in r["error"], r)

        r = client.get(f"{BASE}/commit", params={"repo": ".", "cwd": work})
        check("POST-only routes reject GET", r.status_code == 405, r.status_code)

        # discard: tracked file only, untracked refused
        (fx.work / "readme.txt").write_text("dirty\n", encoding="utf-8")
        r = client.post(f"{BASE}/discard", json={"repo": ".", "paths": ["readme.txt"],
                                                 "cwd": work}).json()
        check("POST /discard restores a tracked file",
              r.get("ok") and r["data"]["still_dirty"] == [], r)
        fx.write(fx.work, "api-untracked.txt", "u\n")
        r = client.post(f"{BASE}/discard", json={"repo": ".", "paths": ["api-untracked.txt"],
                                                 "cwd": work}).json()
        check("POST /discard refuses untracked",
              r.get("ok") is False and "untracked" in r["error"], r)
        (fx.work / "api-untracked.txt").unlink()

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
            r = client.post(f"{BASE}/tgit",
                            json={"repo": ".", "path": "readme.txt", "cwd": work}).json()
            check("POST /tgit launches", r.get("ok") and r["data"]["launched"], r)
            args = calls[0] if calls else []
            check("POST /tgit asks for /command:diff with an absolute path",
                  len(args) == 4 and args[1] == "/command:diff" and args[2].startswith("/path:")
                  and args[2].lower().replace("\\", "/").endswith("readme.txt"), args)
            check("GET /tgit is gone (no side effect on prefetch)",
                  client.get(f"{BASE}/tgit", params={"repo": ".", "path": "readme.txt"}).status_code == 405)

            fx.write(fx.work, "tgit-untracked.txt", "x\n")
            r = client.post(f"{BASE}/tgit",
                            json={"repo": ".", "path": "tgit-untracked.txt", "cwd": work}).json()
            check("POST /tgit refuses untracked", r.get("ok") is False and "untracked" in r["error"], r)

            r = client.post(f"{BASE}/tgit",
                            json={"repo": ".", "path": "../escape.txt", "cwd": work}).json()
            check("POST /tgit refuses a path outside the repo",
                  r.get("ok") is False and "escapes" in r["error"], r)

            api._tgit_exe = lambda: (_ for _ in ()).throw(api.gitops.GitOpsError("not installed"))
            r = client.post(f"{BASE}/tgit",
                            json={"repo": ".", "path": "readme.txt", "cwd": work}).json()
            check("POST /tgit reports a missing TortoiseGit",
                  r.get("ok") is False and "not installed" in r["error"], r)
        finally:
            api.subprocess, api._tgit_exe = real_subprocess, real_exe
    finally:
        fx.close()
    print(f"\nSUMMARY: {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
