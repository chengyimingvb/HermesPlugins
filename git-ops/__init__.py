"""git-ops — deterministic git tools for Hermes.

Six tools, one repo per call. Discovery (`git_repos`) lists every work tree under a
root including submodules; commit/push/pull act on exactly the repo you name.
"""

from __future__ import annotations

import logging

from . import gitops

logger = logging.getLogger(__name__)

_REPO = {"type": "string",
         "description": "Repo: absolute path, path relative to the session cwd, or a short name "
                        "findable under the session cwd. Omit to use the cwd's own work tree."}
_PATHS = {"type": "array", "items": {"type": "string"},
          "description": "Explicit paths relative to the repo root. No '.', '-A' or globs."}

_TOOLS = [
    ("git_repos", {
        "name": "git_repos",
        "description": "List every git work tree under one or more roots, submodules included. "
                       "Each entry reports kind (main/submodule), parent, branch, upstream, "
                       "ahead/behind and dirty count. Start here for multi-repo work.",
        "parameters": {"type": "object", "properties": {
            "roots": {"type": "array", "items": {"type": "string"},
                      "description": "Directories to scan. Omit to scan the session cwd."},
            "depth": {"type": "integer", "description": "Max depth below each root (default 6)."},
            "submodules": {"type": "boolean", "description": "Include submodule work trees (default true)."},
        }},
    }, "📂"),
    ("git_status", {
        "name": "git_status",
        "description": "State of one repo: branch, detached flag, upstream, ahead/behind, gone "
                       "upstream, dirty files, index.lock. Read-only.",
        "parameters": {"type": "object", "properties": {"repo": _REPO}},
    }, "📊"),
    ("git_commit_info", {
        "name": "git_commit_info",
        "description": "Generate a Conventional Commits message from the selected diff, using the "
                       "user's own model. Nothing is staged or committed. Returns header/body/message.",
        "parameters": {"type": "object", "properties": {
            "repo": _REPO,
            "paths": _PATHS,
        }, "required": ["paths"]},
    }, "✍️"),
    ("git_commit", {
        "name": "git_commit",
        "description": "Stage explicit paths and commit. Omit 'message' to generate one automatically "
                       "(one extra model call). Message is validated before committing. For a "
                       "submodule change, commit the submodule first, then the parent gitlink.",
        "parameters": {"type": "object", "properties": {
            "repo": _REPO,
            "paths": _PATHS,
            "message": {"type": "string",
                        "description": "Full Conventional Commits message. Omit to auto-generate."},
        }, "required": ["paths"]},
    }, "✅"),
    ("git_push", {
        "name": "git_push",
        "description": "Push the current branch and prove it landed (HEAD == @{u}, ahead == 0). "
                       "Sets upstream with -u origin <branch> on first push. Never forces.",
        "parameters": {"type": "object", "properties": {"repo": _REPO}},
    }, "⬆️"),
    ("git_pull", {
        "name": "git_pull",
        "description": "Fetch, then fast-forward (default) or rebase the current branch, then sync "
                       "and update submodules recursively. Diverged branches are refused, not merged.",
        "parameters": {"type": "object", "properties": {
            "repo": _REPO,
            "roots": {"type": "array", "items": {"type": "string"},
                      "description": "Batch mode: pull every repo found under these roots, "
                                     "one at a time, parents before their submodules."},
            "mode": {"type": "string", "enum": ["ff", "rebase"], "description": "Default 'ff'."},
            "submodules": {"type": "boolean", "description": "Sync + update submodules (default true)."},
        }},
    }, "⬇️"),
]


def _auto_commit(repo: str, paths: list[str], message: str, cwd: str, llm) -> dict:
    if not message.strip():
        message = gitops.commit_info(repo, paths, cwd, llm)["message"]
    return gitops.commit(repo, paths, message, cwd)


def _pull_many(roots: list[str], cwd: str, mode: str, submodules: bool) -> dict:
    listing = gitops.scan(roots, 6, True)["repos"]
    mains = [r["path"] for r in listing if r["kind"] == "main"]
    subs = [r["path"] for r in listing if r["kind"] == "submodule"]
    results = []
    for path in mains + subs:  # parents first: a submodule pull can collide with the parent's update
        try:
            results.append(gitops.pull(path, cwd, mode, submodules))
        except gitops.GitOpsError as exc:
            results.append({"path": path, "error": str(exc)})
    failed = [r for r in results if "error" in r]
    state = "failed" if failed and len(failed) == len(results) else "partial" if failed else "ok"
    return {"status": state, "scanned": len(results), "results": results}


def register(ctx) -> None:
    if not gitops.GIT:
        logger.warning("git-ops: git executable not found; tools not registered")
        return

    def cwd() -> str:
        return ctx.session_cwd()

    def h_repos(args, **_kw):
        roots = args.get("roots") or [cwd()]
        return gitops.envelope(gitops.scan, roots, int(args.get("depth") or 6),
                               bool(args.get("submodules", True)))

    def h_status(args, **_kw):
        return gitops.envelope(gitops.status, args.get("repo") or ".", cwd())

    def h_info(args, **_kw):
        return gitops.envelope(gitops.commit_info, args.get("repo") or ".",
                               args.get("paths") or [], cwd(), ctx.llm)

    def h_commit(args, **_kw):
        return gitops.envelope(_auto_commit, args.get("repo") or ".", args.get("paths") or [],
                               args.get("message") or "", cwd(), ctx.llm)

    def h_push(args, **_kw):
        return gitops.envelope(gitops.push, args.get("repo") or ".", cwd())

    def h_pull(args, **_kw):
        mode = args.get("mode") or "ff"
        submodules = bool(args.get("submodules", True))
        if args.get("roots"):
            return gitops.envelope(_pull_many, args["roots"], cwd(), mode, submodules)
        return gitops.envelope(gitops.pull, args.get("repo") or ".", cwd(), mode, submodules)

    handlers = {"git_repos": h_repos, "git_status": h_status, "git_commit_info": h_info,
                "git_commit": h_commit, "git_push": h_push, "git_pull": h_pull}
    for name, schema, emoji in _TOOLS:
        ctx.register_tool(name=name, toolset="git-ops", schema=schema,
                          handler=handlers[name], check_fn=lambda: bool(gitops.GIT), emoji=emoji)
