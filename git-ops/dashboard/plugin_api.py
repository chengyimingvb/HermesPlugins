"""git-ops dashboard backend: mounted at /api/plugins/git-ops/.

Thin HTTP shell over the plugin's own ``gitops.py`` — one implementation, two doors
(agent tools and this UI). Every route answers ``{"ok": bool, "data"|"error": ...}``.

Mutating work (commit / push / pull / discard / launching TortoiseGit) is POST only: a
GET has to stay safe to prefetch, or a link preview can create a commit or pop a window.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Query

router = APIRouter()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def _load_gitops():
    """Import the plugin's gitops module by path (the plugin dir name has a hyphen)."""
    name = "hermes_gitops_core"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / "gitops.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


gitops = _load_gitops()


def _llm():
    from agent.plugin_llm import PluginLlm
    return PluginLlm(plugin_id="git-ops")


def _envelope(fn, *args, **kwargs) -> dict[str, Any]:
    try:
        return {"ok": True, "data": fn(*args, **kwargs)}
    except gitops.GitOpsError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - the UI shows whatever went wrong
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _base(cwd: str | None) -> str:
    """The UI always sends its workspace; without one, act on the server's own cwd (never $HOME)."""
    return cwd or os.getcwd()


def _inside(top: str, path: str) -> str:
    """An absolute target inside ``top``, or a GitOpsError — one guard for every route."""
    if not path:
        raise gitops.GitOpsError("path is required")
    target = os.path.normpath(os.path.join(top, path))
    if os.path.commonpath([os.path.normcase(top), os.path.normcase(target)]) != os.path.normcase(top):
        raise gitops.GitOpsError(f"path escapes the repository: {path}")
    return target


@router.get("/repos")
def repos(roots: str = Query("", description="Comma-separated roots"),
          depth: int = Query(6), submodules: bool = Query(True),
          cwd: str = Query("")) -> dict[str, Any]:
    root_list = [r.strip() for r in roots.split(",") if r.strip()] or [_base(cwd)]
    return _envelope(gitops.scan, root_list, depth, submodules)


@router.get("/status")
def status(repo: str = Query("."), cwd: str = Query("")) -> dict[str, Any]:
    return _envelope(gitops.status, repo, _base(cwd))


@router.get("/diff")
def diff(repo: str = Query("."), path: str = Query(""), cwd: str = Query("")) -> dict[str, Any]:
    def _one() -> dict[str, Any]:
        top = gitops.resolve_repo(repo, _base(cwd))
        _inside(top, path)
        text, _files, truncated = gitops._diff(top, [path])
        if not text.strip():
            raise gitops.GitOpsError(f"no diff for {path} (unchanged, or binary)")
        return {"path": path, "diff": text, "truncated": truncated}
    return _envelope(_one)


@router.post("/commit-info")
def commit_info(payload: dict = Body(...)) -> dict[str, Any]:
    repo = payload.get("repo") or "."
    paths = payload.get("paths") or []
    return _envelope(gitops.commit_info, repo, paths, _base(payload.get("cwd")), _llm())


@router.post("/commit")
def commit(payload: dict = Body(...)) -> dict[str, Any]:
    repo = payload.get("repo") or "."
    paths = payload.get("paths") or []
    message = payload.get("message") or ""
    return _envelope(gitops.auto_commit, repo, paths, message, _base(payload.get("cwd")), _llm())


@router.post("/push")
def push(payload: dict = Body(...)) -> dict[str, Any]:
    return _envelope(gitops.push, payload.get("repo") or ".", _base(payload.get("cwd")))


@router.post("/pull")
def pull(payload: dict = Body(...)) -> dict[str, Any]:
    mode = payload.get("mode") or "ff"
    submodules = bool(payload.get("submodules", True))
    cwd = _base(payload.get("cwd"))
    if payload.get("roots"):
        return _envelope(gitops.pull_many, payload["roots"], cwd, mode, submodules)
    return _envelope(gitops.pull, payload.get("repo") or ".", cwd, mode, submodules)


@router.post("/discard")
def discard(payload: dict = Body(...)) -> dict[str, Any]:
    """Throw away work-tree changes for the selected tracked paths (UI asks first)."""
    return _envelope(gitops.discard, payload.get("repo") or ".", payload.get("paths") or [],
                     _base(payload.get("cwd")))

# ── TortoiseGit bridge ───────────────────────────────────────────────────
# The desktop half can only hand the OS a URL (``ctx.os.openExternal`` admits web
# schemes), so opening TortoiseGit's own diff window has to happen here: this
# backend runs in the plugin-host process and can spawn a GUI child.


def _tgit_exe() -> str:
    """TortoiseGitProc.exe from PATH, else its default install locations."""
    found = shutil.which("TortoiseGitProc.exe")
    if found:
        return found
    for root in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                 os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
        if not root:
            continue
        candidate = os.path.join(root, "TortoiseGit", "bin", "TortoiseGitProc.exe")
        if os.path.isfile(candidate):
            return candidate
    raise gitops.GitOpsError("TortoiseGit not installed (TortoiseGitProc.exe not found)")


def _spawn_tgit_diff(exe: str, target: str) -> None:
    """Fire and forget: TortoiseGitProc owns its window and returns at once."""
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen([exe, "/command:diff", f"/path:{target}", "/closeonend:0"],
                     close_fds=True, creationflags=flags)


def launch_tgit_diff(repo: str, path: str, cwd: str) -> dict[str, Any]:
    """Open TortoiseGit's diff window for one tracked working-tree file."""
    if os.name != "nt":
        raise gitops.GitOpsError("TortoiseGit is a Windows-only client")
    top = gitops.resolve_repo(repo, cwd)
    target = _inside(top, path)
    if not os.path.exists(target):
        raise gitops.GitOpsError(f"no such file on disk: {path}")
    if gitops._run(["ls-files", "--error-unmatch", "--", path], cwd=top, timeout=20).returncode != 0:
        raise gitops.GitOpsError(f"untracked file, no diff to show: {path}")
    exe = _tgit_exe()
    _spawn_tgit_diff(exe, target)
    return {"launched": True, "exe": exe, "path": target}


@router.post("/tgit")
def tgit(payload: dict = Body(...)) -> dict[str, Any]:
    """Launch TortoiseGit's diff window. Any error here means the UI falls back to ``/diff``."""
    return _envelope(launch_tgit_diff, payload.get("repo") or ".", payload.get("path") or "",
                     _base(payload.get("cwd")))
