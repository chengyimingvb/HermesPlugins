"""git-ops core: discovery, status, commit, push, pull — all subprocess-based, no shell.

Every public function returns a dict; ``__init__`` wraps them in the tool JSON envelope.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterable, Optional

SKIP_DIRS = {"Library", "Temp", "obj", "node_modules", ".git", ".vs", "Builds", "Logs"}
GIT_TIMEOUT = {"status": 30, "commit": 120, "push": 300, "pull": 300, "scan": 120}
MAX_SCAN_DEPTH = 8
VALID_TYPES = ("feat", "fix", "docs", "style", "refactor", "perf", "test",
               "build", "ci", "chore", "revert")
HEADER_RE = re.compile(r"^(%s)(\([^)]+\))?!?: \S" % "|".join(VALID_TYPES))
SECRET_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key|token)\b\s*[=:]\s*\S+"),
)


class GitOpsError(Exception):
    pass


def git_path() -> Optional[str]:
    found = shutil.which("git")
    if found:
        return found
    for candidate in (r"C:\Program Files\Git\cmd\git.exe",
                      r"C:\Program Files\Git\bin\git.exe",
                      "/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"):
        if os.path.isfile(candidate):
            return candidate
    return None


GIT = git_path()


def _env() -> dict:
    env = dict(os.environ)
    env.update({
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_EDITOR": "true",
        "GIT_PAGER": "cat",
        "LC_ALL": "C",
        "LANG": "C",
    })
    return env


def _run(args: list, cwd: Optional[str] = None, timeout: int = 60) -> subprocess.CompletedProcess:
    if not GIT:
        raise GitOpsError("git executable not found")
    cmd = [GIT, *(["-C", cwd] if cwd else []), *args]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, env=_env())
    except subprocess.TimeoutExpired as exc:
        raise GitOpsError(f"git {args[0]} timed out after {timeout}s") from exc


def _ok(repo: str, *args, timeout: int = 60) -> str:
    proc = _run(list(args), cwd=repo, timeout=timeout)
    if proc.returncode != 0:
        raise GitOpsError((proc.stderr or proc.stdout or "").strip() or f"git {args[0]} failed")
    return proc.stdout


def toplevel(path: str) -> str:
    proc = _run(["rev-parse", "--show-toplevel"], cwd=path, timeout=20)
    if proc.returncode != 0:
        raise GitOpsError(f"not a git work tree: {path}")
    return proc.stdout.strip().replace("\\", "/")


# ── repo resolution ───────────────────────────────────────────────────────

def _scan_roots(roots: Iterable[str], depth: int = 6) -> list[str]:
    """Every .git (dir or file) under each root, pruned of heavy dirs."""
    hits: list[str] = []
    for root in roots:
        root = os.path.abspath(os.path.expanduser(root))
        if not os.path.isdir(root):
            continue
        base_depth = root.rstrip("/\\").count(os.sep)
        for dirpath, dirnames, filenames in os.walk(root, topdown=True):
            if dirpath.count(os.sep) - base_depth >= depth:
                dirnames[:] = []
                continue
            if ".git" in dirnames or ".git" in filenames:
                hits.append(dirpath)
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
    return hits


def scan(roots: Optional[list[str]], depth: int = 6, submodules: bool = True) -> dict:
    roots = [os.path.abspath(r) for r in (roots or [])]
    if not roots:
        raise GitOpsError("no roots to scan")
    hits = _scan_roots(roots, depth)
    repos: dict[str, dict] = {}
    for root in roots:  # a root inside a work tree still surfaces that repo
        try:
            top = toplevel(root)
        except GitOpsError:
            continue
        repos.setdefault(top, {"path": top, **_kind(top)})
    for hit in hits:
        try:
            top = toplevel(hit)
        except GitOpsError:
            continue
        if top in repos:
            continue
        repos[top] = {"path": top, **_kind(top)}
    items = []
    for top in sorted(repos):
        if not submodules and repos[top]["kind"] == "submodule":
            continue
        items.append({**repos[top], **_light_state(top)})
    return {"roots": roots, "count": len(items), "repos": items}


def _kind(top: str) -> dict:
    proc = _run(["rev-parse", "--show-superproject-working-tree"], cwd=top, timeout=20)
    parent = (proc.stdout or "").strip().replace("\\", "/") if proc.returncode == 0 else ""
    if parent:
        return {"kind": "submodule", "parent": parent}
    return {"kind": "main", "parent": ""}


def resolve_repo(repo: Optional[str], cwd: str) -> str:
    """Absolute path, path relative to cwd, or a short name found under cwd."""
    if not repo or repo == ".":
        return toplevel(cwd)
    candidate = repo if os.path.isabs(repo) else os.path.join(cwd, repo)
    if os.path.exists(candidate):
        return toplevel(os.path.abspath(candidate))
    wanted = repo.replace("\\", "/").strip("/")
    matches = [p for p in _scan_roots([cwd], MAX_SCAN_DEPTH)
               if p.replace("\\", "/").endswith("/" + wanted) or os.path.basename(p) == wanted]
    tops = sorted({toplevel(m) for m in matches})
    if not tops:
        raise GitOpsError(f"repo not found: {repo} (tried path under {cwd} and a scan of it)")
    if len(tops) > 1:
        raise GitOpsError(f"repo name {repo!r} is ambiguous: {', '.join(tops)}")
    return tops[0]


# ── state ────────────────────────────────────────────────────────────────

def _dirty(top: str) -> list[dict]:
    proc = _run(["status", "--porcelain=v1", "-z"], cwd=top, timeout=GIT_TIMEOUT["status"])
    if proc.returncode != 0:
        raise GitOpsError(proc.stderr.strip() or "git status failed")
    entries, tokens, i = [], proc.stdout.split("\0"), 0
    while i < len(tokens):
        token = tokens[i]
        if not token:
            i += 1
            continue
        code, path = token[:2], token[3:]
        entry = {"code": code, "path": path}
        if code[0] in "RC":
            entry["from"] = tokens[i + 1] if i + 1 < len(tokens) else ""
            i += 1
        entries.append(entry)
        i += 1
    return entries


def _counts(top: str) -> dict:
    proc = _run(["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd=top, timeout=30)
    if proc.returncode != 0:
        return {"ahead": None, "behind": None, "upstream": None, "gone": None}
    parts = proc.stdout.split()
    return {"ahead": int(parts[0]), "behind": int(parts[1])}


def _light_state(top: str) -> dict:
    branch = _run(["symbolic-ref", "--short", "-q", "HEAD"], cwd=top, timeout=20).stdout.strip()
    upstream = _run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
                    cwd=top, timeout=20).stdout.strip()
    counts = _counts(top) if upstream else {"ahead": None, "behind": None}
    return {
        "branch": branch or "DETACHED",
        "upstream": upstream or "",
        "ahead": counts["ahead"],
        "behind": counts["behind"],
        "dirty": len(_dirty(top)),
    }


def _lock(top: str) -> str:
    gitdir = _run(["rev-parse", "--git-dir"], cwd=top, timeout=20).stdout.strip()
    if not gitdir:
        return ""
    lock = Path(gitdir) if os.path.isabs(gitdir) else Path(top) / gitdir
    lock = lock / "index.lock"
    if not lock.exists():
        return ""
    return f"stale? {lock} ({lock.stat().st_size} bytes) — check for a running git process before removing"


def status(repo: str, cwd: str) -> dict:
    top = resolve_repo(repo, cwd)
    state = _light_state(top)
    gone = ""
    if state["branch"] != "DETACHED":
        gone = _run(["for-each-ref", "--format=%(upstream:track)",
                     f"refs/heads/{state['branch']}"], cwd=top, timeout=20).stdout.strip()
    files = _dirty(top)
    return {"path": top, **state, "gone": gone, "files": files, "lock": _lock(top),
            "head": _run(["rev-parse", "--short", "HEAD"], cwd=top, timeout=20).stdout.strip()}


# ── message validation ───────────────────────────────────────────────────

def validate_message(message: str) -> Optional[str]:
    lines = message.strip("\n").split("\n")
    header = lines[0].strip() if lines else ""
    if not header:
        return "empty commit message"
    if not HEADER_RE.match(header):
        return ("header must be '<type>(<scope>): <subject>' with type in "
                "%s" % "/".join(VALID_TYPES))
    if len(header) > 72:
        return f"header longer than 72 chars ({len(header)})"
    subject = header.split(": ", 1)[1] if ": " in header else ""
    if subject[:1].isupper():
        return "subject must start lowercase (lead with the native verb for non-Latin text)"
    if header.endswith("."):
        return "header must not end with a period"
    body = lines[1:]
    if body and body[0].strip():
        return "body must be separated from the header by a blank line"
    for line in body:
        if len(line) > 72:
            return f"body line longer than 72 chars: {line[:40]}…"
    return None


# ── commit ───────────────────────────────────────────────────────────────

def check_paths(top: str, paths: list[str]) -> None:
    if not paths:
        raise GitOpsError("paths is required: stage explicit paths (no 'add -A')")
    if any(p in ("-A", "--all", ".", "-u") for p in paths):
        raise GitOpsError("refusing sweeping pathspecs; pass explicit file paths")
    tracked = set(p for p in _run(["ls-files", "-z"], cwd=top).stdout.split("\0") if p)
    # A staged deletion is already out of the index, so "known to git" must include status paths.
    tracked.update(p for entry in _dirty(top)
                   for p in (entry["path"], entry.get("from", "")) if p)
    missing = [p for p in paths
               if not os.path.exists(os.path.join(top, p)) and p not in tracked]
    if missing:
        raise GitOpsError(f"path not present in work tree: {', '.join(missing)}")


def _stage(top: str, paths: list[str]) -> list[str]:
    check_paths(top, paths)
    _ok(top, "add", "--", *paths)
    staged = _run(["diff", "--cached", "--name-only", "-z"], cwd=top).stdout.split("\0")
    return [p for p in staged if p]


def commit(repo: str, paths: list[str], message: str, cwd: str) -> dict:
    top = resolve_repo(repo, cwd)
    if not message or not message.strip():
        raise GitOpsError("message is empty; call git_commit_info to generate one")
    problem = validate_message(message)
    if problem:
        raise GitOpsError(f"invalid commit message: {problem}")
    staged = _stage(top, paths)
    if not staged:
        raise GitOpsError("nothing staged after 'git add' — paths matched no change")
    handle = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8")
    try:
        handle.write(message.rstrip() + "\n")
        handle.close()
        _ok(top, "commit", "-F", handle.name, timeout=GIT_TIMEOUT["commit"])
    finally:
        os.unlink(handle.name)
    sha = _ok(top, "rev-parse", "HEAD").strip()
    header = _ok(top, "log", "-1", "--format=%s").strip()
    return {"path": top, "sha": sha, "short": sha[:8], "header": header, "files": staged}


# ── commit message generation ────────────────────────────────────────────

def _redact(text: str) -> tuple[str, int]:
    hits = 0
    for pattern in SECRET_PATTERNS:
        text, n = pattern.subn("***REDACTED***", text)
        hits += n
    return text, hits


def _in_scope(path: str, paths: list[str]) -> bool:
    """True when ``path`` is one of ``paths`` or lives under one of them (a listed directory)."""
    return any(path == p or path.startswith(p.rstrip("/") + "/") for p in paths)


def _diff(repo: str, paths: list[str]) -> tuple[str, list[str], bool]:
    """Every change the selected paths carry — staged, unstaged (edits and deletions), untracked."""
    scope = ["--", *paths] if paths else []
    chunks, files = [], []
    for base in (["diff", "--cached"], ["diff"]):
        chunk = _run(base + scope, cwd=repo, timeout=60).stdout
        if chunk.strip():
            chunks.append(chunk)
        files += [p for p in _run(base + ["--name-only"] + scope, cwd=repo, timeout=60).stdout.split() if p]
    diff = "\n".join(chunks)
    untracked = [p for p in _run(["ls-files", "--others", "--exclude-standard"], cwd=repo).stdout.split()
                 if not paths or _in_scope(p, paths)]
    for path in untracked[:10]:
        full = os.path.join(repo, path)
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                body = fh.read(4000)
        except OSError:
            continue
        diff += f"\n--- new file: {path}\n{body}"
    truncated = len(diff) > 12000
    return diff[:12000], list(dict.fromkeys(files + untracked)), truncated


def commit_info(repo: str, paths: list[str], cwd: str, llm) -> dict:
    top = resolve_repo(repo, cwd)
    if paths:
        check_paths(top, paths)
    diff, files, truncated = _diff(top, paths)
    if not diff.strip():
        raise GitOpsError("no changes to describe")
    diff, redactions = _redact(diff)
    history = _ok(top, "log", "-20", "--oneline", "--no-decorate").strip()
    instructions = (
        "Write one Git commit message for the diff below.\n"
        "Format: '<type>(<scope>): <subject>' then a blank line then an optional body wrapped at 72 chars.\n"
        f"type is one of: {', '.join(VALID_TYPES)}.\n"
        "subject: imperative, lowercase first letter, no trailing period, <= 72 chars total header.\n"
        "Match the language of the recent commit history (Chinese history -> Chinese subject).\n"
        "Output only the message, no code fences, no commentary."
    )
    prompt = (f"Recent history (language/style reference):\n{history or '(empty repo)'}\n\n"
              f"Files: {', '.join(files) or '(unknown)'}\n\nDiff:\n{diff}")
    result = llm.complete([
        {"role": "system", "content": instructions},
        {"role": "user", "content": prompt},
    ], max_tokens=400, timeout=60)
    message = (result.text or "").strip()
    message = re.sub(r"^```[a-zA-Z]*\n?|```$", "", message).strip()
    problem = validate_message(message)
    if problem:
        raise GitOpsError(f"generated message is invalid ({problem}); raw: {message[:200]}")
    header, _, body = message.partition("\n")
    return {"path": top, "header": header.strip(), "body": body.strip(), "message": message,
            "files": files, "truncated": truncated, "redactions": redactions,
            "model": getattr(result, "model", "")}


# ── push ─────────────────────────────────────────────────────────────────

def push(repo: str, cwd: str) -> dict:
    top = resolve_repo(repo, cwd)
    state = _light_state(top)
    if state["branch"] == "DETACHED":
        raise GitOpsError("detached HEAD: check out a branch before pushing")
    if not state["upstream"]:
        _ok(top, "push", "-u", "origin", state["branch"], timeout=GIT_TIMEOUT["push"])
    else:
        proc = _run(["push"], cwd=top, timeout=GIT_TIMEOUT["push"])
        if proc.returncode != 0:
            raise GitOpsError((proc.stderr or proc.stdout).strip() or "git push failed")
    head = _ok(top, "rev-parse", "HEAD").strip()
    upstream_sha = _run(["rev-parse", "@{u}"], cwd=top).stdout.strip()
    counts = _counts(top)
    verified = head == upstream_sha and counts.get("ahead") == 0
    return {"path": top, "branch": state["branch"], "upstream": state["upstream"] or "origin/" + state["branch"],
            "sha": head, "short": head[:8], "verified": verified,
            "ahead_after": counts.get("ahead")}


# ── pull ─────────────────────────────────────────────────────────────────

def pull(repo: str, cwd: str, mode: str = "ff", submodules: bool = True) -> dict:
    top = resolve_repo(repo, cwd)
    state = _light_state(top)
    if state["branch"] == "DETACHED":
        raise GitOpsError("detached HEAD: refuse to pull")
    if not state["upstream"]:
        raise GitOpsError("no upstream for this branch; set one with 'git branch -u <remote>/<branch>'")
    fetch = _run(["fetch", "--all", "--prune", "--tags"], cwd=top, timeout=GIT_TIMEOUT["pull"])
    if fetch.returncode != 0:
        raise GitOpsError((fetch.stderr or fetch.stdout).strip() or "git fetch failed")
    counts = _counts(top)
    ahead, behind = counts.get("ahead") or 0, counts.get("behind") or 0
    old = _ok(top, "rev-parse", "--short", "HEAD").strip()
    if behind == 0:
        return {"path": top, "branch": state["branch"], "pulled": 0, "old": old, "new": old,
                "ahead": ahead, "behind": 0, "note": "already up to date"}
    if ahead and behind:
        raise GitOpsError(f"diverged: ahead {ahead}, behind {behind} — resolve by hand "
                          "(rebase or merge), this tool does not create merge commits")
    if mode not in ("ff", "rebase"):
        raise GitOpsError("mode must be 'ff' or 'rebase'")
    proc = _run(["pull", "--ff-only" if mode == "ff" else "--rebase"], cwd=top,
                timeout=GIT_TIMEOUT["pull"])
    if proc.returncode != 0:
        raise GitOpsError((proc.stderr or proc.stdout).strip() or "git pull failed")
    new = _ok(top, "rev-parse", "--short", "HEAD").strip()
    result = {"path": top, "branch": state["branch"], "pulled": behind, "old": old, "new": new,
              "ahead": 0, "behind": 0, "submodules": None}
    if submodules and os.path.isfile(os.path.join(top, ".gitmodules")):
        _run(["submodule", "sync", "--recursive"], cwd=top, timeout=GIT_TIMEOUT["pull"])
        sub = _run(["submodule", "update", "--init", "--recursive"], cwd=top, timeout=GIT_TIMEOUT["pull"])
        if sub.returncode != 0:
            raise GitOpsError("pull landed but submodule update failed: "
                              + (sub.stderr or sub.stdout).strip())
        listing = _ok(top, "submodule", "status", "--recursive").strip().splitlines()
        result["submodules"] = {
            "count": len(listing),
            "needs_attention": [ln for ln in listing if ln[:1] in ("-", "U")],
        }
    return result


def envelope(fn, *args, **kwargs) -> str:
    try:
        return json.dumps({"ok": True, "data": fn(*args, **kwargs)}, ensure_ascii=False)
    except GitOpsError as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001 - tool handlers must never raise
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
