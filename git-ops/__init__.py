"""git-ops — deterministic git tools for Hermes.

Nine tools, one repo per call. Discovery (`git_repos`) lists every work tree under a
root including submodules; commit/push/pull/discard act on exactly the repo you name.
"""

from __future__ import annotations

import json
import logging
import os

from . import gitops

logger = logging.getLogger(__name__)

# ── change notifications ─────────────────────────────────────────────────
# The desktop pane acts on one repo at a time and polls its status with a backoff. An
# agent-side commit/push/pull/discard would otherwise sit unseen until that poll came
# round. Every mutating tool therefore pushes ``plugin.git-ops.<kind>`` onto the running
# session's event stream (``ctx.emit_to_session``); the pane subscribes with
# ``ctx.onEvent`` and refreshes at once. Fire-and-forget: no viewer, no authority or a
# dead socket is never a tool failure.

_EVENT_KEYS = ("sha", "short", "header", "branch", "upstream", "pulled", "status", "scanned")


def _session_id() -> str:
    """The runtime session id of the turn this tool call runs in, ``""`` outside one."""
    try:
        from gateway.session_context import get_session_env
        found = get_session_env("HERMES_SESSION_ID", "")
    except Exception:  # no gateway process (tests, CLI one-shot): env is the fallback
        found = ""
    return found or os.environ.get("HERMES_SESSION_ID", "")


def _notify(ctx, kind: str, data: dict) -> None:
    """Tell the session's viewers that one repo changed. Never raises."""
    payload = {"kind": kind, "repo": str(data.get("path") or "")}
    for key in _EVENT_KEYS:
        if data.get(key) is not None:
            payload[key] = data[key]
    session_id = _session_id()
    delivered = False
    if session_id:
        try:
            delivered = bool(ctx.emit_to_session(session_id, kind, payload))
        except Exception as exc:  # noqa: BLE001 - a lost frame is not a failed commit
            logger.debug("git-ops: %s event not delivered: %s", kind, exc)
    if not delivered:
        _broadcast(kind, payload)


def _broadcast(kind: str, payload: dict) -> None:
    """Fallback when the session door is unavailable: ``plugins.isolation: host`` leaves the
    plugin process without the turn's session id, and a call outside a desktop session has no
    stream to land on. Fanning out to every connected window is then the only way the pane
    hears about it; the pane itself drops frames for another repo."""
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
        broadcast_plugin_event("git-ops", kind, payload)
    except Exception as exc:  # noqa: BLE001 - no gateway in this process (tests, CLI tooling)
        logger.debug("git-ops: %s broadcast not delivered: %s", kind, exc)


def _notifying(ctx, kind: str, fn, *args, **kwargs) -> str:
    """``envelope`` for one mutating call, plus the change event when it succeeded."""
    text = gitops.envelope(fn, *args, **kwargs)
    try:
        answer = json.loads(text)
    except ValueError:
        return text
    if answer.get("ok"):
        data = answer.get("data")
        _notify(ctx, kind, data if isinstance(data, dict) else {})
    return text


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
                       "ahead/behind and dirty count; a work tree git cannot read comes back "
                       "with 'error' on the entry. Start here for multi-repo work.",
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
    ("git_diff", {
        "name": "git_diff",
        "description": "Unified diff of one repo (or of explicit paths). Read-only; truncated at "
                       "12000 chars. Use 'staged' for the index instead of the work tree.",
        "parameters": {"type": "object", "properties": {
            "repo": _REPO,
            "paths": _PATHS,
            "staged": {"type": "boolean", "description": "Diff the index against HEAD."},
        }},
    }, "🔍"),
    ("git_log", {
        "name": "git_log",
        "description": "Recent commits of one repo as {sha, date, subject}. Read-only; "
                       "the quickest way to read the house commit style.",
        "parameters": {"type": "object", "properties": {
            "repo": _REPO,
            "limit": {"type": "integer", "description": "How many commits (default 20, max 200)."},
        }},
    }, "📜"),
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
                       "(one extra model call). Message is validated before committing. Refuses when "
                       "the index already holds changes outside those paths. For a submodule change, "
                       "commit the submodule first, then the parent gitlink.",
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
                       "Picks the configured pushRemote on first push. Never forces.",
        "parameters": {"type": "object", "properties": {"repo": _REPO}},
    }, "⬆️"),
    ("git_pull", {
        "name": "git_pull",
        "description": "Fetch, then fast-forward (default) or rebase the current branch, then sync "
                       "submodule URLs and initialise missing/detached submodules. A submodule "
                       "checked out on a branch stays on it. A diverged branch is refused unless "
                       "mode='rebase', which replays the local commits onto the upstream.",
        "parameters": {"type": "object", "properties": {
            "repo": _REPO,
            "roots": {"type": "array", "items": {"type": "string"},
                      "description": "Batch mode: pull every repo found under these roots, "
                                     "one at a time, parents before their submodules."},
            "mode": {"type": "string", "enum": ["ff", "rebase"],
                     "description": "Default 'ff' (fast-forward only). 'rebase' also replays "
                                    "local commits when the branch has diverged."},
            "submodules": {"type": "boolean",
                                     "description": "Sync submodule URLs and init missing/detached ones; "
                                                    "on-branch submodules are left alone (default true)."},
        }},
    }, "⬇️"),
    ("git_discard", {
        "name": "git_discard",
        "description": "Throw away work-tree changes for explicit tracked paths (index and work tree "
                       "back to HEAD). Irreversible. A new file (untracked, or staged and never "
                       "committed) is never deleted — it is only unstaged and reported in 'skipped'; "
                       "a selected rename restores both sides, and 'still_dirty' lists whatever "
                       "stayed dirty.",
        "parameters": {"type": "object", "properties": {
            "repo": _REPO,
            "paths": _PATHS,
        }, "required": ["paths"]},
    }, "🧹"),
]


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

    def h_diff(args, **_kw):
        return gitops.envelope(gitops.text_diff, args.get("repo") or ".", args.get("paths") or [],
                               cwd(), bool(args.get("staged", False)))

    def h_log(args, **_kw):
        return gitops.envelope(gitops.log, args.get("repo") or ".", int(args.get("limit") or 20),
                               cwd())

    def h_info(args, **_kw):
        return gitops.envelope(gitops.commit_info, args.get("repo") or ".",
                               args.get("paths") or [], cwd(), ctx.llm)

    def h_commit(args, **_kw):
        return _notifying(ctx, "commit", gitops.auto_commit, args.get("repo") or ".",
                          args.get("paths") or [], args.get("message") or "", cwd(), ctx.llm)

    def h_push(args, **_kw):
        return _notifying(ctx, "push", gitops.push, args.get("repo") or ".", cwd())

    def h_pull(args, **_kw):
        mode = args.get("mode") or "ff"
        submodules = bool(args.get("submodules", True))
        if args.get("roots"):
            return _notifying(ctx, "pull", gitops.pull_many, args["roots"], cwd(), mode, submodules)
        return _notifying(ctx, "pull", gitops.pull, args.get("repo") or ".", cwd(), mode, submodules)

    def h_discard(args, **_kw):
        return _notifying(ctx, "discard", gitops.discard, args.get("repo") or ".",
                          args.get("paths") or [], cwd())

    handlers = {"git_repos": h_repos, "git_status": h_status, "git_diff": h_diff,
                "git_log": h_log, "git_commit_info": h_info, "git_commit": h_commit,
                "git_push": h_push, "git_pull": h_pull, "git_discard": h_discard}
    for name, schema, emoji in _TOOLS:
        ctx.register_tool(name=name, toolset="git-ops", schema=schema,
                          handler=handlers[name], check_fn=lambda: bool(gitops.GIT), emoji=emoji)
