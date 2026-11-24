"""git-ops core: discovery, status, commit, push, pull — all subprocess-based, no shell.

Every public function returns a dict; ``__init__`` wraps them in the tool JSON envelope.

Performance shape: one ``git status --porcelain=v2 --branch -z`` per repo supplies branch,
upstream, ahead/behind and the dirty list at once (4-8 calls collapsed into 1), and a scan
probes repositories through a thread pool (DgitWork, 48 repos: 19.2s -> ~1s of git time).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable, Optional

SKIP_DIRS = {
    "Library", "Temp", "obj", "node_modules", ".git", ".vs", "Builds", "Logs",
    ".venv", "venv", "__pycache__", ".idea", ".next", ".nuxt", ".pytest_cache",
    ".mypy_cache", "coverage", ".gradle", "DerivedData", "Pods", "dist", "target",
}
GIT_TIMEOUT = {"status": 30, "commit": 120, "push": 300, "pull": 300, "scan": 120}
MAX_SCAN_DEPTH = 8
SCAN_WORKERS = 16
DIFF_BUDGET = 12000
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
# Tests and embedders point git at a sandboxed config without touching os.environ.
ENV_OVERRIDES: dict[str, str] = {}
# Absolute path -> toplevel cache. Keyed by normcase so drive-letter case drift folds back
# to one spelling; a live .git check keeps a re-created repo from serving a stale answer.
_TOPLEVEL_CACHE: dict[str, str] = {}


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

# Windows-only: keep every git.exe from flashing a console window in the GUI host.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _env() -> dict:
    env = dict(os.environ)
    env.update({
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_EDITOR": "true",
        "GIT_PAGER": "cat",
        "LC_ALL": "C",
        "LANG": "C",
    })
    env.update(ENV_OVERRIDES)
    return env


def _run(args: list, cwd: Optional[str] = None, timeout: int = 60) -> subprocess.CompletedProcess:
    if not GIT:
        raise GitOpsError("git executable not found")
    cmd = [GIT, *(["-C", cwd] if cwd else []), *args]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, env=_env(),
                              # CREATE_NO_WINDOW: git.exe is a console program and the plugin
                              # host is a GUI process, so without it every call flashes a
                              # console window. stdio on /dev/null: a credential helper that
                              # still asks gets EOF instead of hanging out the full timeout.
                              stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired as exc:
        raise GitOpsError(f"git {args[0]} timed out after {timeout}s") from exc


def _ok(repo: str, *args, timeout: int = 60) -> str:
    proc = _run(list(args), cwd=repo, timeout=timeout)
    if proc.returncode != 0:
        raise GitOpsError((proc.stderr or proc.stdout or "").strip() or f"git {args[0]} failed")
    return proc.stdout


def toplevel(path: str) -> str:
    key = os.path.normcase(os.path.normpath(path))
    cached = _TOPLEVEL_CACHE.get(key)
    if cached and (os.path.isdir(os.path.join(cached, ".git"))
                   or os.path.isfile(os.path.join(cached, ".git"))):
        return cached
    proc = _run(["rev-parse", "--show-toplevel"], cwd=path, timeout=20)
    if proc.returncode != 0:
        raise GitOpsError(f"not a git work tree: {path}")
    top = proc.stdout.strip().replace("\\", "/")
    _TOPLEVEL_CACHE[key] = top
    return top


def _git_dir(top: str) -> Optional[Path]:
    """The repository's git dir, resolved without a subprocess (a dir, or a ``gitdir:`` file)."""
    dot = os.path.join(top, ".git")
    if os.path.isdir(dot):
        return Path(dot)
    if os.path.isfile(dot):
        try:
            with open(dot, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if line.startswith("gitdir:"):
                        target = line.split(":", 1)[1].strip()
                        found = Path(target) if os.path.isabs(target) else (Path(top) / target)
                        # A submodule's gitdir is written as ../../.git/modules/<name>:
                        # normalise so the parent work tree is readable off the prefix.
                        return Path(os.path.normpath(str(found)))
        except OSError:
            return None
    return None


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


def _kind(top: str) -> dict:
    """main/submodule + parent, decided from .git on disk (no subprocess)."""
    dot = os.path.join(top, ".git")
    if not os.path.isfile(dot):  # a real .git dir (or nothing): an ordinary work tree
        return {"kind": "main", "parent": ""}
    gitdir = _git_dir(top)
    text = str(gitdir).replace("\\", "/") if gitdir else ""
    if "/.git/modules/" in text:  # submodule: the parent work tree is the gitdir's prefix
        return {"kind": "submodule", "parent": text.split("/.git/modules/")[0]}
    return {"kind": "main", "parent": ""}  # a linked work tree keeps its own branch


def _probe(top: str) -> Optional[dict]:
    """One repo's light state: a single git call, plus a filesystem kind lookup."""
    try:
        state = _porcelain(top)
    except GitOpsError:
        return None
    return {
        "path": top.replace("\\", "/"),
        **_kind(top),
        "branch": state["branch"] or "DETACHED",
        "upstream": state["upstream"],
        "ahead": state["ahead"],
        "behind": state["behind"],
        "dirty": len(state["files"]),
    }


def _canon(path: str) -> str:
    """One spelling per repository: a scan hit and `rev-parse --show-toplevel` must not double-count."""
    return os.path.normpath(path).replace("\\", "/")


def scan(roots: Optional[list[str]], depth: int = 6, submodules: bool = True,
         workers: int = SCAN_WORKERS) -> dict:
    roots = [os.path.abspath(os.path.expanduser(r)) for r in (roots or [])]
    if not roots:
        raise GitOpsError("no roots to scan")
    tops: dict[str, str] = {}

    def add(path: str) -> None:
        tops.setdefault(os.path.normcase(_canon(path)), _canon(path))

    for hit in _scan_roots(roots, depth):
        add(hit)
    for root in roots:  # a root inside a work tree still surfaces that repo
        try:
            add(toplevel(root))
        except GitOpsError:
            continue
    ordered = sorted(tops.values())
    if len(ordered) <= 1:
        probed = [_probe(t) for t in ordered]
    else:
        with ThreadPoolExecutor(max_workers=max(1, min(workers, len(ordered)))) as pool:
            probed = list(pool.map(_probe, ordered))
    items = [item for item in probed
             if item and (submodules or item["kind"] != "submodule")]
    return {"roots": roots, "count": len(items), "repos": items}


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

def _porcelain(top: str, untracked: bool = True) -> dict:
    """branch / upstream / ahead / behind / files from one ``status --porcelain=v2 -z`` run.

    Record shapes (NUL-terminated, so a path with spaces stays one path):
      1 <XY> ... <path>              ordinary change
      2 <XY> ... <path> NUL <origin> rename/copy: the original path is its own token
      u <XY> ... <path>              unmerged
      ? <path> / ! <path>            untracked / ignored
    """
    args = ["status", "--porcelain=v2", "--branch", "-z"]
    if not untracked:
        args.append("-uno")  # push/pull only need the branch header; skip the untracked walk
    proc = _run(args, cwd=top, timeout=GIT_TIMEOUT["status"])
    if proc.returncode != 0:
        raise GitOpsError(proc.stderr.strip() or "git status failed")
    out = {"oid": "", "branch": "", "upstream": "", "ahead": None, "behind": None, "files": []}
    tokens = proc.stdout.split("\0")
    i = 0
    while i < len(tokens):
        token = tokens[i]
        i += 1
        if not token:
            continue
        kind = token[0]
        if kind == "#":
            key, _, value = token[2:].partition(" ")
            if key == "branch.oid":
                out["oid"] = "" if value.startswith("(") else value
            elif key == "branch.head":
                out["branch"] = "" if value.startswith("(") else value
            elif key == "branch.upstream":
                out["upstream"] = value
            elif key == "branch.ab":
                for part in value.split():
                    if part.startswith("+"):
                        out["ahead"] = int(part[1:] or 0)
                    elif part.startswith("-"):
                        out["behind"] = int(part[1:] or 0)
        elif kind == "1":
            fields = token.split(" ", 8)
            if len(fields) > 8:
                out["files"].append({"code": fields[1], "path": fields[8]})
        elif kind == "2":
            fields = token.split(" ", 9)
            origin = tokens[i] if i < len(tokens) else ""
            i += 1
            if len(fields) > 9:
                out["files"].append({"code": fields[1], "path": fields[9], "from": origin})
        elif kind == "u":
            fields = token.split(" ", 10)
            if len(fields) > 10:
                out["files"].append({"code": fields[1], "path": fields[10]})
        elif kind in ("?", "!"):
            out["files"].append({"code": "??" if kind == "?" else "!!", "path": token[2:]})
    return out


def _dirty(top: str) -> list[dict]:
    return _porcelain(top)["files"]


def _light_state(top: str) -> dict:
    state = _porcelain(top, untracked=False)
    return {
        "branch": state["branch"] or "DETACHED",
        "upstream": state["upstream"],
        "ahead": state["ahead"],
        "behind": state["behind"],
        "dirty": len(state["files"]),
    }


def _lock(top: str) -> str:
    gitdir = _git_dir(top)
    if not gitdir:
        return ""
    lock = gitdir / "index.lock"
    try:
        if not lock.exists():
            return ""
        return (f"stale? {lock} ({lock.stat().st_size} bytes) — "
                "check for a running git process before removing")
    except OSError:
        return ""


def status(repo: str, cwd: str) -> dict:
    top = resolve_repo(repo, cwd)
    state = _porcelain(top)
    branch = state["branch"] or "DETACHED"
    # One process, not two: `status --porcelain=v2 --branch` prints branch.upstream but no
    # branch.ab line when the upstream ref is missing (verified against a deleted remote
    # branch), so "upstream set + ahead unknown" IS the gone signal — no for-each-ref needed.
    gone = "[gone]" if (state["upstream"] and state["ahead"] is None) else ""
    return {"path": top, "branch": branch, "upstream": state["upstream"],
            "ahead": state["ahead"], "behind": state["behind"], "gone": gone,
            "files": state["files"], "lock": _lock(top),
            "head": state["oid"][:7] if state["oid"] else ""}


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
    subject = header.split(": ", 1)[1]
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


# ── paths / staging ──────────────────────────────────────────────────────

SWEEPING = {"-A", "--all", ".", "-u", "--update", ":/*"}


def _guard_paths(paths: list[str]) -> None:
    if not paths:
        raise GitOpsError("paths is required: stage explicit paths (no 'add -A')")
    if any(p in SWEEPING for p in paths):
        raise GitOpsError("refusing sweeping pathspecs; pass explicit file paths")


def _known_paths(top: str) -> tuple[set[str], list[dict]]:
    """Every path status mentions (both sides of a rename), from ONE status call.

    An `ls-files` index dump is not needed: status already reports every staged, unstaged and
    deleted path, and a tracked-but-unchanged path is never a commit target — `git add` on it
    stages nothing, so it can only end in "nothing staged". One process instead of two.
    """
    files = _dirty(top)
    known = {p for entry in files for p in (entry["path"], entry.get("from", "")) if p}
    return known, files


def check_paths(top: str, paths: list[str]) -> None:
    _guard_paths(paths)
    known, _files = _known_paths(top)
    missing = [p for p in paths
               if not os.path.exists(os.path.join(top, p)) and p not in known]
    if missing:
        raise GitOpsError(f"path not present in work tree: {', '.join(missing)}")


def _in_scope(path: str, paths: list[str]) -> bool:
    """True when ``path`` is one of ``paths`` or lives under one of them (a listed directory)."""
    return any(path == p or path.startswith(p.rstrip("/") + "/") for p in paths)


def _staged_paths(top: str) -> list[str]:
    return [p for p in _run(["diff", "--cached", "--name-only", "-z"],
                            cwd=top).stdout.split("\0") if p]


def _stage(top: str, paths: list[str]) -> list[str]:
    """Add the named paths and prove the index holds the changes asked for and nothing else.

    A path missing from the work tree can still be tracked: an unstaged deletion (`rm file`)
    is in the index and ``git add`` stages the removal, and a removed directory is known by
    the files the index still holds under it. A deletion that is ALREADY staged (`git rm`)
    is in neither the work tree nor the index and ``git add`` fatals on that pathspec — it
    needs no add. Any change staged by the user outside ``paths`` is an error, never folded
    into this commit; a selected path that carries a change the index did not take is also
    an error, never a silent half-commit.
    """
    _guard_paths(paths)
    known, files = _known_paths(top)
    missing = [p for p in paths if not os.path.exists(os.path.join(top, p))]
    # One index probe, and only when a selected path is gone: `ls-files` matches a path and
    # everything under it, so it answers both "an unstaged deletion" (the blob is still
    # indexed) and "a deleted directory" (its files are). Files whose deletion is already
    # staged are in neither place and need no add.
    indexed = ({p for p in _run(["ls-files", "-z", "--", *missing], cwd=top).stdout.split("\0")
                if p} if missing else set())
    gone = {p for p in missing if any(_in_scope(entry, [p]) for entry in indexed)}
    unknown = [p for p in missing if p not in known and p not in gone]
    if unknown:
        raise GitOpsError(f"path not present in work tree: {', '.join(unknown)}")
    addable = [p for p in paths if p not in missing or p in gone]
    if addable:
        _ok(top, "add", "--", *addable)
    staged = _staged_paths(top)
    if not staged:
        raise GitOpsError("nothing staged after 'git add' — paths matched no change")
    renamed = {entry["from"]: entry["path"] for entry in files if entry.get("from")}
    extras = [p for p in staged
              if not _in_scope(p, paths)
              and not (p in renamed and _in_scope(renamed[p], paths))]
    if extras:
        raise GitOpsError(
            "index already holds changes outside the selected paths: "
            + ", ".join(sorted(extras))
            + " — unstage them (git restore --staged <path>) or add them to paths")
    # The mirror of ``extras``: every selected path that carries a change of its own (the
    # target of a rename, never its source) must be in the index, so a selected path can
    # never be dropped from the commit without an error.
    carrying = {entry["path"] for entry in files}
    unstaged = [p for p in paths if p in carrying and not _in_scope(p, staged)]
    if unstaged:
        raise GitOpsError(
            "selected paths carry a change the index does not hold: "
            + ", ".join(sorted(unstaged)))
    return staged


def commit(repo: str, paths: list[str], message: str, cwd: str) -> dict:
    top = resolve_repo(repo, cwd)
    if not message or not message.strip():
        raise GitOpsError("message is empty; call git_commit_info to generate one")
    problem = validate_message(message)
    if problem:
        raise GitOpsError(f"invalid commit message: {problem}")
    staged = _stage(top, paths)
    handle = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8")
    try:
        handle.write(message.rstrip() + "\n")
        handle.close()
        _ok(top, "commit", "-F", handle.name, timeout=GIT_TIMEOUT["commit"])
    finally:
        os.unlink(handle.name)
    # One call for short+subject instead of rev-parse + log.
    meta = _ok(top, "log", "-1", "--format=%H%x1f%s").strip()
    sha, _, header = meta.partition("\x1f")
    return {"path": top, "sha": sha, "short": sha[:8], "header": header, "files": staged}


# ── commit message generation ────────────────────────────────────────────

def _redact(text: str) -> tuple[str, int]:
    hits = 0
    for pattern in SECRET_PATTERNS:
        text, n = pattern.subn("***REDACTED***", text)
        hits += n
    return text, hits


def _diff(repo: str, paths: list[str]) -> tuple[str, list[str], bool]:
    """Every change the selected paths carry — staged, unstaged (edits and deletions), untracked.

    ``-z`` throughout: splitting ``--name-only`` output on whitespace turns ``my file.txt``
    into two paths and silently drops its body from the diff handed to the model.
    """
    scope = ["--", *paths] if paths else []
    chunks, files = [], []
    for base in (["diff", "--cached"], ["diff"]):
        chunk = _run(base + scope, cwd=repo, timeout=60).stdout
        if chunk.strip():
            chunks.append(chunk)
        names = _run(base + ["--name-only", "-z"] + scope, cwd=repo, timeout=60).stdout
        files += [p for p in names.split("\0") if p]
    tracked = "\n".join(chunks)
    untracked = [p for p in _run(["ls-files", "--others", "--exclude-standard", "-z"],
                                 cwd=repo).stdout.split("\0")
                 if p and (not paths or _in_scope(p, paths))]
    body = tracked[:int(DIFF_BUDGET * 0.75)]
    truncated = len(tracked) > len(body)
    room = DIFF_BUDGET - len(body)
    for path in untracked[:10]:
        try:
            with open(os.path.join(repo, path), "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read(4000)
        except OSError:
            continue
        if "\x00" in content:  # binary: the text would be noise
            continue
        piece = f"\n--- new file: {path}\n{content}"
        if len(piece) > room:
            truncated = True
            break
        body += piece
        room -= len(piece)
    if len(untracked) > 10:
        truncated = True
    return body, list(dict.fromkeys(files + untracked)), truncated


def file_diff(top: str, path: str, untracked: bool = False) -> tuple[str, bool]:
    """One path's net change against HEAD, in ONE git call — the pane's per-row click.

    ``_diff`` runs four diff invocations because commit-message generation wants staged and
    unstaged bodies separately; a viewer only needs the net change, and ``diff HEAD`` already
    folds staged into unstaged. ``untracked`` comes from the porcelain code the pane already
    holds: an untracked path has no diff at all, so read the file instead of asking git.
    """
    if not untracked:
        text = _run(["diff", "HEAD", "--", path], cwd=top, timeout=60).stdout
        if text.strip():
            return text[:DIFF_BUDGET], len(text) > DIFF_BUDGET
        # Empty against HEAD: unchanged, binary-free no-op, or a path git never tracked.
        if _run(["ls-files", "--error-unmatch", "-z", "--", path], cwd=top).returncode == 0:
            return "", False
    try:
        with open(os.path.join(top, path), "r", encoding="utf-8", errors="replace") as fh:
            content = fh.read(DIFF_BUDGET + 1)
    except OSError:
        return "", False
    if "\x00" in content:  # binary: the text would be noise
        return "", False
    body = f"--- new file: {path}\n{content}"
    return body[:DIFF_BUDGET], len(body) > DIFF_BUDGET


def commit_info(repo: str, paths: list[str], cwd: str, llm) -> dict:
    top = resolve_repo(repo, cwd)
    if paths:
        check_paths(top, paths)
    diff, files, truncated = _diff(top, paths)
    if not diff.strip():
        raise GitOpsError("no changes to describe")
    diff, redactions = _redact(diff)
    history = _ok(top, "log", "-20", "--oneline", "--no-decorate").strip()
    history, history_hits = _redact(history)
    redactions += history_hits
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


def auto_commit(repo: str, paths: list[str], message: str, cwd: str, llm) -> dict:
    """Commit with the given message, or with one generated from the selected diff."""
    if not (message or "").strip():
        message = commit_info(repo, paths, cwd, llm)["message"]
    return commit(repo, paths, message, cwd)


# ── read-only helpers ────────────────────────────────────────────────────

def text_diff(repo: str, paths: Optional[list[str]] = None, cwd: str = ".",
              staged: bool = False) -> dict:
    """The unified diff of the selected paths (work tree, or the index when ``staged``)."""
    top = resolve_repo(repo, cwd)
    scope = ["--", *paths] if paths else []
    base = ["diff", "--cached"] if staged else ["diff"]
    text = _run(base + scope, cwd=top, timeout=60).stdout
    names = [p for p in _run(base + ["--name-only", "-z"] + scope,
                             cwd=top, timeout=60).stdout.split("\0") if p]
    body = text[:DIFF_BUDGET]
    return {"path": top, "files": names, "diff": body,
            "truncated": len(text) > len(body), "staged": staged}


def log(repo: str, limit: int = 20, cwd: str = ".") -> dict:
    """Recent commits as {sha, date, subject}."""
    top = resolve_repo(repo, cwd)
    limit = max(1, min(int(limit or 20), 200))
    out = _ok(top, "log", f"-{limit}", "--date=short", "--format=%h%x1f%ad%x1f%s")
    commits = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 3:
            commits.append({"sha": parts[0], "date": parts[1], "subject": parts[2]})
    return {"path": top, "count": len(commits), "commits": commits}


def list_files(repo: str, cwd: str, include_untracked: bool = True) -> dict:
    """Every non-ignored file in the work tree, as paths relative to the repo root.

    Ignore filtering is git's own job: tracked files can never be ignored, and
    ``--exclude-standard`` applies .gitignore (plus core.excludesfile and
    $GIT_DIR/info/exclude) to the untracked set. ``-z`` keeps a path with spaces
    whole, matching the rest of this module.

    ``--cached`` and ``--others`` ride ONE invocation (tracked first, then untracked):
    a second process here costs ~100ms on a 20k-file repo for no extra information.
    """
    top = resolve_repo(repo, cwd)
    args = ["ls-files", "-z", "--exclude-standard"]
    args += ["--cached", "--others"] if include_untracked else ["--cached"]
    files = list(dict.fromkeys(
        p for p in _run(args, cwd=top, timeout=60).stdout.split("\0") if p))
    return {"path": top, "count": len(files), "files": files}


def discard(repo: str, paths: list[str], cwd: str) -> dict:
    """Throw work-tree changes away for tracked paths (index and work tree back to HEAD).

    Untracked paths are never deleted, and they no longer fail the call either: they come
    back in ``skipped``, so one new file picked next to real edits cannot block the rest.
    A path counts as discardable when git's own status names it — both sides of a rename,
    and either column of a staged change: an index dump would misread a staged deletion
    (gone from the index, still in HEAD) as untracked and refuse a restore git handles fine.

    ``discarded`` lists the paths that are clean once this returns, so a restore that did
    nothing (no commit yet to restore from) reports ``discarded: []`` with the path in
    ``still_dirty`` instead of claiming work it never performed.
    """
    top = resolve_repo(repo, cwd)
    _guard_paths(paths)
    entries = _dirty(top)
    known = {p for entry in entries for p in (entry["path"], entry.get("from", "")) if p}
    untracked = {entry["path"] for entry in entries if entry["code"] == "??"}
    tracked = [p for p in paths if p in known and p not in untracked]
    if tracked:
        try:
            _ok(top, "restore", "--source=HEAD", "--staged", "--worktree", "--", *tracked,
                timeout=GIT_TIMEOUT["commit"])
        except GitOpsError:
            # A file absent from HEAD cannot be restored from it: unstage, then check out.
            _run(["restore", "--staged", "--", *tracked], cwd=top, timeout=GIT_TIMEOUT["commit"])
            _ok(top, "checkout", "--", *tracked, timeout=GIT_TIMEOUT["commit"])
    dirty_after = {f["path"] for f in _dirty(top)}
    skipped = {p for p in paths if p not in set(tracked)}
    return {"path": top,
            "discarded": [p for p in tracked if p not in dirty_after],
            "skipped": [p for p in paths if p in skipped],
            "still_dirty": [p for p in tracked if p in dirty_after]}


# ── push ─────────────────────────────────────────────────────────────────

def _remote_for(top: str, branch: str) -> str:
    """branch.<name>.pushRemote, then remote.pushDefault, then branch.<name>.remote, then a guess."""
    for key in (f"branch.{branch}.pushRemote", "remote.pushDefault", f"branch.{branch}.remote"):
        proc = _run(["config", "--get", key], cwd=top, timeout=20)
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    remotes = [r for r in _run(["remote"], cwd=top, timeout=20).stdout.split() if r]
    if "origin" in remotes:
        return "origin"
    if len(remotes) == 1:
        return remotes[0]
    if not remotes:
        raise GitOpsError("no remote configured; add one with 'git remote add origin <url>'")
    raise GitOpsError(f"cannot pick a remote among {', '.join(remotes)}; "
                      "set branch.<name>.remote or an upstream first")


def push(repo: str, cwd: str) -> dict:
    top = resolve_repo(repo, cwd)
    state = _light_state(top)
    if state["branch"] == "DETACHED":
        raise GitOpsError("detached HEAD: check out a branch before pushing")
    if not state["upstream"]:
        remote = _remote_for(top, state["branch"])
        _ok(top, "push", "-u", remote, state["branch"], timeout=GIT_TIMEOUT["push"])
    else:
        proc = _run(["push"], cwd=top, timeout=GIT_TIMEOUT["push"])
        if proc.returncode != 0:
            raise GitOpsError((proc.stderr or proc.stdout).strip() or "git push failed")
    after = _porcelain(top, untracked=False)  # only oid/branch/upstream/ahead are read here
    head = after["oid"] or _ok(top, "rev-parse", "HEAD").strip()
    upstream_sha = _run(["rev-parse", "@{u}"], cwd=top).stdout.strip()
    verified = head == upstream_sha and after["ahead"] == 0
    return {"path": top, "branch": after["branch"] or state["branch"],
            "upstream": after["upstream"] or state["upstream"],
            "sha": head, "short": head[:8], "verified": verified,
            "ahead_after": after["ahead"]}


# ── pull ─────────────────────────────────────────────────────────────────

def _submodule_branches(top: str) -> dict[str, str]:
    """Submodule path -> checked-out branch, or 'DETACHED'. One git call for the whole tree."""
    proc = _run(["submodule", "foreach", "--quiet",
                 'printf "%s|%s\\n" "$displaypath" "$(git symbolic-ref -q --short HEAD || echo DETACHED)"'],
                cwd=top, timeout=GIT_TIMEOUT["pull"])
    branches: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        path, _, branch = line.partition("|")
        if path.strip():
            branches[path.strip().replace("\\", "/")] = branch.strip() or "DETACHED"
    return branches


def _submodule_paths(top: str) -> list[str]:
    """Every submodule path in .gitmodules (-z: git must not quote a path holding spaces)."""
    proc = _run(["config", "-z", "--file", os.path.join(top, ".gitmodules"),
                 "--get-regexp", r"^submodule\..*\.path$"], cwd=top,
                timeout=GIT_TIMEOUT["pull"])
    paths: list[str] = []
    for entry in proc.stdout.split("\0"):
        _, _, path = entry.strip().partition("\n")
        if path:
            paths.append(path.strip().replace("\\", "/"))
    return paths


def _sync_submodules(top: str) -> Optional[dict]:
    """Sync submodule URLs, then check out only where there is no branch to lose.

    ``git submodule update`` resets a submodule to the parent's recorded gitlink, which
    detaches a submodule sitting on a branch and hides that branch's commits. So it runs
    only for submodules that are not cloned yet and for detached ones; a submodule on a
    branch is left alone and reported (``on_branch`` / ``needs_attention``).
    """
    if not os.path.isfile(os.path.join(top, ".gitmodules")):
        return None
    _run(["submodule", "sync", "--recursive"], cwd=top, timeout=GIT_TIMEOUT["pull"])
    branches = _submodule_branches(top)
    targets = [p for p in _submodule_paths(top)
               if branches.get(p) == "DETACHED"
               or not os.path.exists(os.path.join(top, p, ".git"))]
    if targets:
        sub = _run(["submodule", "update", "--init", "--recursive", "--", *targets],
                   cwd=top, timeout=GIT_TIMEOUT["pull"])
        if sub.returncode != 0:
            raise GitOpsError("pull landed but submodule update failed: "
                              + (sub.stderr or sub.stdout).strip())
    after = _ok(top, "submodule", "status", "--recursive").strip().splitlines()
    return {"count": len(after),
            # '+' = the submodule is ahead/behind its gitlink: expected on a kept branch.
            "needs_attention": [ln for ln in after if ln[:1] in ("-", "U", "+")],
            "on_branch": sorted(p for p, b in branches.items() if b != "DETACHED")}


def pull(repo: str, cwd: str, mode: str = "ff", submodules: bool = True) -> dict:
    top = resolve_repo(repo, cwd)
    state = _light_state(top)
    if state["branch"] == "DETACHED":
        raise GitOpsError("detached HEAD: refuse to pull")
    if not state["upstream"]:
        raise GitOpsError("no upstream for this branch; set one with 'git branch -u <remote>/<branch>'")
    remote = state["upstream"].split("/", 1)[0] if state["upstream"] else None
    fetch = _run(["fetch", "--prune", "--tags", remote]
                 if remote else ["fetch", "--all", "--prune", "--tags"],
                 cwd=top, timeout=GIT_TIMEOUT["pull"])
    if fetch.returncode != 0 and remote:
        # A remote name containing a slash defeats the first-segment guess: fall back to all.
        fetch = _run(["fetch", "--all", "--prune", "--tags"], cwd=top, timeout=GIT_TIMEOUT["pull"])
    if fetch.returncode != 0:
        raise GitOpsError((fetch.stderr or fetch.stdout).strip() or "git fetch failed")
    counts = _porcelain(top, untracked=False)  # ahead/behind/oid only: skip the untracked walk
    ahead, behind = counts["ahead"] or 0, counts["behind"] or 0
    old = (counts["oid"] or _ok(top, "rev-parse", "HEAD").strip())[:7]
    if behind == 0:
        return {"path": top, "branch": state["branch"], "pulled": 0, "old": old, "new": old,
                "ahead": ahead, "behind": 0,
                "submodules": _sync_submodules(top) if submodules else None,
                "note": "already up to date"}
    if ahead and behind:
        raise GitOpsError(f"diverged: ahead {ahead}, behind {behind} — resolve by hand "
                          "(rebase or merge), this tool does not create merge commits")
    if mode not in ("ff", "rebase"):
        raise GitOpsError("mode must be 'ff' or 'rebase'")
    # The fetch above already moved @{u}, so merge/rebase it directly: a second `git pull`
    # would repeat the network round trip and widen the race window for nothing.
    command = ["merge", "--ff-only", "@{u}"] if mode == "ff" else ["rebase", "@{u}"]
    proc = _run(command, cwd=top, timeout=GIT_TIMEOUT["pull"])
    if proc.returncode != 0:
        raise GitOpsError((proc.stderr or proc.stdout).strip()
                          or f"git {command[0]} failed after fetch")
    final = _porcelain(top, untracked=False)
    new = (final["oid"] or _ok(top, "rev-parse", "HEAD").strip())[:7]
    return {"path": top, "branch": state["branch"], "pulled": behind, "old": old, "new": new,
            "ahead": final["ahead"] or 0, "behind": final["behind"] or 0,
            "submodules": _sync_submodules(top) if submodules else None}


def pull_many(roots: list[str], cwd: str, mode: str = "ff", submodules: bool = True) -> dict:
    """Pull every repo under the roots, parents before their submodules."""
    listing = scan(roots, 6, True)["repos"]
    mains = {r["path"] for r in listing if r["kind"] == "main"}
    subs = {r["path"] for r in listing if r["kind"] == "submodule"}
    order = sorted(mains) + sorted(subs)  # a submodule pull can collide with its parent's update
    results: list[dict[str, Any]] = []
    for path in order:
        entry: dict[str, Any] = {"kind": "submodule" if path in subs else "main"}
        try:
            entry.update(pull(path, cwd, mode, submodules))
        except GitOpsError as exc:
            entry.update({"path": path, "error": str(exc)})
        results.append(entry)
    failed = [r for r in results if "error" in r]
    state = "failed" if failed and len(failed) == len(results) else "partial" if failed else "ok"
    return {"status": state, "scanned": len(results), "results": results}


def envelope(fn, *args, **kwargs) -> str:
    try:
        return json.dumps({"ok": True, "data": fn(*args, **kwargs)}, ensure_ascii=False)
    except GitOpsError as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001 - tool handlers must never raise
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
