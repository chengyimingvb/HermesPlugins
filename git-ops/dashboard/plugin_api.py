"""git-ops dashboard backend: mounted at /api/plugins/git-ops/.

Thin HTTP shell over the plugin's own ``gitops.py`` — one implementation, two doors
(agent tools and this UI). Every route answers ``{"ok": bool, "data"|"error": ...}``.

Mutating work (commit / push / pull / discard / launching a GUI) is POST only: a
GET has to stay safe to prefetch, or a link preview can create a commit or pop a window.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Query

router = APIRouter()

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


_CORE_LOCK = threading.Lock()
_CORE_CACHE: dict[str, tuple[int, Any]] = {}


def _load_gitops(path: Path | None = None):
    """Import gitops.py by path, re-executing it whenever the file changed on disk.

    The plugin dir name carries a hyphen, so the core cannot be imported by name. Reloading
    on an mtime change is what keeps the dashboard half live after a plugin update: this file
    is imported ONCE, when its router mounts, so a cached import would pin the old core until
    the gateway restarts.
    """
    path = Path(path or PLUGIN_ROOT / "gitops.py")
    stamp = path.stat().st_mtime_ns
    cached = _CORE_CACHE.get(str(path))
    if cached and cached[0] == stamp:
        return cached[1]
    with _CORE_LOCK:
        cached = _CORE_CACHE.get(str(path))
        if cached and cached[0] == stamp:
            return cached[1]
        name = "hermes_gitops_core"
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        _CORE_CACHE[str(path)] = (stamp, module)
        return module


class _Core:
    """Every attribute resolves through the newest gitops module on disk."""

    def __getattr__(self, name):
        return getattr(_load_gitops(), name)


gitops = _Core()


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
    try:
        inside = (os.path.commonpath([os.path.normcase(top), os.path.normcase(target)])
                  == os.path.normcase(top))
    except ValueError:
        # commonpath refuses to compare paths on different drives (a C:\ path aimed at a
        # repo living on D:) — an escape like any other, never a crash.
        inside = False
    if not inside:
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


@router.get("/files")
def files(repo: str = Query("."), include_untracked: bool = Query(True),
          cwd: str = Query("")) -> dict[str, Any]:
    """Every non-ignored file in the repo, as paths relative to its root (read-only)."""
    return _envelope(gitops.list_files, repo, _base(cwd), include_untracked)


@router.get("/diff")
def diff(repo: str = Query("."), path: str = Query(""), untracked: bool = Query(False),
         cwd: str = Query("")) -> dict[str, Any]:
    def _one() -> dict[str, Any]:
        top = gitops.resolve_repo(repo, _base(cwd))
        _inside(top, path)
        # One git call, not the five `_diff` needs: the pane sends the porcelain code it
        # already has, so an untracked path costs no git process at all.
        text, truncated = gitops.file_diff(top, path, untracked)
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

# ── external GUI bridge (TortoiseGit / VS Code) ──────────────────────────
# The desktop half can only hand the OS a URL (``ctx.os.openExternal`` admits web
# schemes), so opening TortoiseGit's own diff window — or an editor — has to happen
# here: this backend runs in the plugin-host process and can spawn a GUI child.


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


def _raise_window_to_front(pid: int, timeout: float = 2.0) -> None:
    """Best effort: the GUI is already open, so a failed raise must not fail its door.

    pywin32 may be absent or SetForegroundWindow refused, and the caller has already
    spawned a working window by then — reporting an error there would have the UI fall
    through to the in-pane diff on top of a GUI that opened fine.
    """
    try:
        _raise_window_impl(pid, timeout)
    except Exception:  # noqa: BLE001 - cosmetic, see above
        pass


def _raise_window_impl(pid: int, timeout: float = 2.0) -> None:
    """Bring the spawned process's main window over Hermes once it appears.

    A DETACHED child builds its window in the background, so Hermes keeps the
    foreground and the diff opens behind it. While polling for the window we
    (a) attach to Hermes's foreground thread so SetForegroundWindow is allowed,
    (b) raise the window past every normal-height window via topmost-then-restore.
    """
    import ctypes
    import time

    import win32api
    import win32con
    import win32gui
    import win32process

    user32 = ctypes.windll.user32

    def _attach_input(src: int, dst: int, on: bool) -> bool:
        # AttachThreadInput is a User32 call pywin32 does not expose; route via ctypes.
        user32.AttachThreadInput.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_bool]
        user32.AttachThreadInput.restype = ctypes.c_bool
        return bool(user32.AttachThreadInput(src, dst, on))

    pid = int(pid)
    window = None
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = []

        def _windows(hwnd, _data):
            _t, wpid = win32process.GetWindowThreadProcessId(hwnd)
            if wpid == pid and win32gui.IsWindowVisible(hwnd):
                found.append(hwnd)
            return True

        win32gui.EnumWindows(_windows, None)
        if found:
            window = found[0]
            break
        time.sleep(0.05)
    if not window:
        return

    cur = win32api.GetCurrentThreadId()
    fg = win32gui.GetForegroundWindow()
    fg_thread = win32process.GetWindowThreadProcessId(fg)[0] if fg else 0
    attached = False
    if fg_thread and fg_thread != cur:
        attached = _attach_input(cur, fg_thread, True)
    try:
        win32gui.SetForegroundWindow(window)
        win32gui.SetWindowPos(window, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                              win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_SHOWWINDOW)
        win32gui.SetWindowPos(window, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                              win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
    finally:
        if attached:
            _attach_input(cur, fg_thread, False)


def _spawn_tgit_diff(exe: str, target: str) -> None:
    """Fire and forget: TortoiseGitProc owns its window and returns at once."""
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    proc = subprocess.Popen([exe, "/command:diff", f"/path:{target}", "/closeonend:0"],
                            close_fds=True, creationflags=flags)
    # Ensure the freshly opened window surfaces above Hermes (Windows-only path).
    pid = getattr(proc, "pid", None)
    if pid:
        _raise_window_to_front(pid)


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


def _code_exe() -> str:
    """VS Code's binary on Windows, where a bare ``code`` must not be trusted.

    A VS Code fork (Qoder, Cursor) usually owns the ``code`` name, so PATH would launch
    the wrong editor: the Microsoft installer's per-user registration is authoritative,
    and its default install dirs are the fallback.
    """
    if os.name != "nt":
        found = shutil.which("code") or shutil.which("code-insiders")
        if found:
            return found
        raise gitops.GitOpsError("VS Code CLI (code) not found on PATH")
    import winreg
    try:
        with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Code.exe") as key:
            candidate = winreg.QueryValueEx(key, "")[0]
        # The installer writes REG_SZ, but a REG_EXPAND_SZ value comes back unexpanded,
        # and CreateProcess would receive a literal %VAR%: hand back the expanded path.
        provider = os.path.expandvars(candidate)
        if os.path.isfile(provider):
            return provider
    except OSError:
        pass
    for root in (os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Programs"),
                 os.environ.get("ProgramFiles") or r"C:\Program Files",
                 os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)"):
        candidate = os.path.join(root, "Microsoft VS Code", "Code.exe")
        if os.path.isfile(candidate):
            return candidate
    raise gitops.GitOpsError("VS Code not installed (Code.exe not found)")


def _spawn_code(exe: str, target: str, cwd: str) -> None:
    """``-g`` opens the file itself; the editor's own gutter shows what changed."""
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    proc = subprocess.Popen([exe, "-g", target], cwd=cwd, close_fds=True, creationflags=flags)
    # A cold start builds its window behind Hermes; an already running VS Code is
    # reused and raises itself, so the poll below just finds no window and returns.
    # Windows-only: this helper imports pywin32, and the posix branch of _code_exe
    # must still report the launch it actually performed.
    pid = getattr(proc, "pid", None)
    if pid and os.name == "nt":
        _raise_window_to_front(pid)


def launch_vscode(repo: str, path: str, cwd: str) -> dict[str, Any]:
    """Open one work-tree file in VS Code — the fallback when there is no diff to show.

    No tracking check: this door exists for the paths TortoiseGit refuses (untracked,
    binary) and for files whose diff is empty. A deleted file has nothing on disk to
    open, so it stays an error and the UI shows the deletion diff instead.
    """
    top = gitops.resolve_repo(repo, cwd)
    target = _inside(top, path)
    if not os.path.isfile(target):
        raise gitops.GitOpsError(f"no such file on disk: {path}")
    exe = _code_exe()
    _spawn_code(exe, target, top)
    return {"launched": True, "exe": exe, "path": target}


@router.post("/vscode")
def vscode(payload: dict = Body(...)) -> dict[str, Any]:
    """Open the path in VS Code. Any error here means the UI falls back to ``/diff``."""
    return _envelope(launch_vscode, payload.get("repo") or ".", payload.get("path") or "",
                     _base(payload.get("cwd")))
