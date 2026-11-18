"""Fixture tests for git-ops. Run: python tests/test_gitops.py"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))
import importlib.util  # noqa: E402

import gitops  # noqa: E402

GIT = gitops.GIT


def load_plugin():
    """Load the plugin as a package (its dir name contains a hyphen, so not importable by name)."""
    name = "git_ops_plugin"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run(*args, cwd=None, check=True, env=None):
    proc = subprocess.run([GIT, *args], cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env or os.environ.copy())
    if check and proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {proc.stderr or proc.stdout}")
    return proc


class Fixture:
    """bare origin + clone (+ submodule origin/clone), all under one temp dir."""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="gitops-"))
        self.cfg = self.root / "empty.gitconfig"
        self.cfg.write_text("", encoding="utf-8")
        self.env = {**os.environ,
                    "GIT_CONFIG_GLOBAL": str(self.cfg),
                    "GIT_CONFIG_SYSTEM": str(self.cfg),
                    "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@example.com",
                    "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@example.com",
                    "GIT_TERMINAL_PROMPT": "0",
                    "GIT_CONFIG_COUNT": "1",
                    "GIT_CONFIG_KEY_0": "protocol.file.allow",
                    "GIT_CONFIG_VALUE_0": "always"}
        # Hand the sandbox to gitops through its own override hook: os.environ is global
        # state and mutating it here leaks into every other test in this process.
        self._saved_overrides = dict(gitops.ENV_OVERRIDES)
        gitops.ENV_OVERRIDES.update({
            key: value for key, value in self.env.items() if key.startswith("GIT_")
        })
        self.origin = self._bare("origin.git")
        self.work = self._clone(self.origin, "work")
        self._initial_commit(self.work, "readme.txt")

        self.sub_origin = self._bare("sub-origin.git")
        self.sub_work = self._clone(self.sub_origin, "sub-work")
        self._initial_commit(self.sub_work, "sub.txt")
        run("push", "origin", "HEAD", cwd=self.sub_work, env=self.env)

        sub = run("-c", "protocol.file.allow=always", "submodule", "add",
                  str(self.sub_origin), "subs/lib", cwd=self.work, env=self.env)
        assert sub.returncode == 0, sub.stderr
        run("commit", "-m", "chore: add submodule", cwd=self.work, env=self.env)
        run("push", "origin", "HEAD", cwd=self.work, env=self.env)

    def _bare(self, name):
        path = self.root / name
        run("init", "--bare", "-b", "main", str(path), env=self.env)
        return path

    def _clone(self, origin, name):
        path = self.root / name
        run("clone", str(origin), str(path), env=self.env)
        run("checkout", "-B", "main", cwd=path, env=self.env)
        return path

    def _initial_commit(self, repo, filename):
        (repo / filename).write_text("hello\n", encoding="utf-8")
        run("add", filename, cwd=repo, env=self.env)
        run("commit", "-m", "feat: initial commit", cwd=repo, env=self.env)

    def write(self, repo, name, text):
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return name

    def close(self):
        gitops.ENV_OVERRIDES.clear()
        gitops.ENV_OVERRIDES.update(self._saved_overrides)
        shutil.rmtree(self.root, ignore_errors=True)


class FakeLlm:
    def __init__(self, reply="fix(core): 修正空引用\n\n补充守卫，避免空指针。"):
        self.reply, self.prompt = reply, ""

    def complete(self, messages, **kwargs):
        self.prompt = messages[-1]["content"]
        return type("R", (), {"text": self.reply, "model": "fake"})()


class GitOpsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = Fixture()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_validate_message(self):
        ok = "feat(core): 增加跳过空引用的守卫"
        self.assertIsNone(gitops.validate_message(ok))
        self.assertIn("lowercase", gitops.validate_message("feat(core): Upper case subject"))
        self.assertIn("period", gitops.validate_message("feat: ends with period."))
        self.assertIn("type", gitops.validate_message("update: not a type"))
        self.assertIn("72", gitops.validate_message("feat: " + "x" * 80))
        self.assertIn("blank line", gitops.validate_message("feat: x\nbody right after"))

    def test_status(self):
        st = gitops.status(".", str(self.fx.work))
        self.assertEqual(st["branch"], "main")
        self.assertEqual(st["upstream"], "origin/main")
        # Parity with git itself: earlier tests leave local commits unpushed.
        expected = run("rev-list", "--left-right", "--count", "HEAD...@{u}",
                       cwd=self.fx.work, env=self.fx.env).stdout.split()
        self.assertEqual(st["ahead"], int(expected[0]))
        self.assertEqual(st["behind"], int(expected[1]))
        self.assertTrue(st["head"])
        self.fx.write(self.fx.work, "status-probe.txt", "p\n")
        codes = [f["path"] for f in gitops.status(".", str(self.fx.work))["files"]]
        self.assertIn("status-probe.txt", codes)
        os.remove(self.fx.work / "status-probe.txt")

    def test_status_costs_one_git_status_call(self):
        """One `status --porcelain=v2 --branch` supplies branch/upstream/ahead/behind/files."""
        calls = []
        real = gitops._run

        def spy(args, cwd=None, timeout=60):
            calls.append(args[0])
            return real(args, cwd, timeout)

        gitops._run = spy
        try:
            gitops.status(".", str(self.fx.work))
        finally:
            gitops._run = real
        self.assertEqual(calls.count("status"), 1, calls)
        self.assertNotIn("symbolic-ref", calls)
        self.assertNotIn("rev-list", calls)
        self.assertLessEqual(len(calls), 4, calls)

    def test_list_files_respects_gitignore(self):
        self.fx.write(self.fx.work, "tracked.py", "t\n")
        gitops.commit(".", ["tracked.py"], "feat: 增加 tracked 文件", str(self.fx.work))
        self.fx.write(self.fx.work, "untracked.md", "u\n")
        self.fx.write(self.fx.work, "my file.txt", "spaced\n")
        self.fx.write(self.fx.work, ".gitignore", "*.log\nignored.tmp\n")
        self.fx.write(self.fx.work, "ignored.tmp", "x\n")
        listing = gitops.list_files(".", str(self.fx.work))
        files = set(listing["files"])
        self.assertIn("tracked.py", files)
        self.assertIn("untracked.md", files)
        self.assertIn("my file.txt", files)   # -z keeps the space as one path
        self.assertNotIn("ignored.tmp", files)
        tracked_only = gitops.list_files(".", str(self.fx.work), include_untracked=False)
        self.assertIn("tracked.py", tracked_only["files"])
        self.assertNotIn("untracked.md", tracked_only["files"])
        for name in ("untracked.md", "my file.txt", "ignored.tmp", ".gitignore"):
            p = self.fx.work / name
            if p.exists():
                p.unlink()

    def test_scan_finds_submodule(self):
        listing = gitops.scan([str(self.fx.root)], 6, True)
        kinds = {Path(r["path"]).name: r["kind"] for r in listing["repos"]}
        self.assertEqual(kinds.get("work"), "main")
        self.assertEqual(kinds.get("lib"), "submodule")
        lib = next(r for r in listing["repos"] if r["path"].endswith("work/subs/lib"))
        self.assertEqual(lib["kind"], "submodule")
        self.assertTrue(lib["parent"].endswith("work"), lib)
        without = gitops.scan([str(self.fx.work)], 6, False)
        self.assertEqual([r["kind"] for r in without["repos"]], ["main"])

    def test_scan_from_subdir_finds_owning_repo(self):
        deep = self.fx.work / "subs"
        listing = gitops.scan([str(deep)], 6, True)
        paths = [r["path"] for r in listing["repos"]]
        self.assertIn(str(self.fx.work).replace("\\", "/"), [p.replace("\\", "/") for p in paths])

    def test_commit_rejects_bad_input(self):
        self.fx.write(self.fx.work, "a.txt", "a\n")
        with self.assertRaises(gitops.GitOpsError):
            gitops.commit(".", ["a.txt"], "bad message", str(self.fx.work))
        with self.assertRaises(gitops.GitOpsError):
            gitops.commit(".", ["."], "feat: ok", str(self.fx.work))
        with self.assertRaises(gitops.GitOpsError):
            gitops.commit(".", ["nope.txt"], "feat: ok", str(self.fx.work))

    def test_commit_refuses_unselected_staged_changes(self):
        """别的文件已经 staged 时不能顺手带上：报错而不是静默扩大提交范围。"""
        self.fx.write(self.fx.work, "staged-other.txt", "o\n")
        run("add", "staged-other.txt", cwd=self.fx.work, env=self.fx.env)
        self.fx.write(self.fx.work, "wanted.txt", "t\n")
        with self.assertRaises(gitops.GitOpsError) as ctx:
            gitops.commit(".", ["wanted.txt"], "feat: 只提交 wanted", str(self.fx.work))
        self.assertIn("staged-other.txt", str(ctx.exception))
        head_files = run("show", "--name-only", "--format=", "HEAD",
                         cwd=self.fx.work, env=self.fx.env).stdout
        self.assertNotIn("wanted.txt", head_files)
        run("restore", "--staged", "staged-other.txt", cwd=self.fx.work, env=self.fx.env)
        result = gitops.commit(".", ["wanted.txt"], "feat: 只提交 wanted", str(self.fx.work))
        self.assertEqual(result["files"], ["wanted.txt"])

    def test_commit_push_verified(self):
        self.fx.write(self.fx.work, "b.txt", "b\n")
        result = gitops.commit(".", ["b.txt"], "feat(core): 增加 b 文件\n\n说明。", str(self.fx.work))
        self.assertTrue(result["sha"])
        self.assertEqual(result["files"], ["b.txt"])
        pushed = gitops.push(".", str(self.fx.work))
        self.assertTrue(pushed["verified"], pushed)
        self.assertEqual(pushed["ahead_after"], 0)
        self.assertEqual(run("rev-parse", "HEAD", cwd=self.fx.work).stdout.strip(),
                         run("rev-parse", "@{u}", cwd=self.fx.work).stdout.strip())

    def test_commit_staged_deletion(self):
        """已 staged 的删除也要能提交：git add 对不存在于工作区的路径会 fatal。"""
        self.fx.write(self.fx.work, "gone.txt", "g\n")
        gitops.commit(".", ["gone.txt"], "feat: 增加 gone 文件", str(self.fx.work))
        run("rm", "-q", "gone.txt", cwd=self.fx.work)  # 删除已在索引中（等价 git rm）
        result = gitops.commit(".", ["gone.txt"], "chore: 删除 gone 文件", str(self.fx.work))
        self.assertEqual(result["files"], ["gone.txt"])
        self.assertEqual(run("ls-files", "--", "gone.txt", cwd=self.fx.work).stdout.strip(), "")

    def test_pull_ff_and_diverged(self):
        consumer = self.fx._clone(self.fx.origin, "consumer")
        self.fx.write(self.fx.work, "c.txt", "c\n")
        gitops.commit(".", ["c.txt"], "feat: 增加 c 文件", str(self.fx.work))
        gitops.push(".", str(self.fx.work))
        pulled = gitops.pull(".", str(consumer))
        self.assertGreaterEqual(pulled["pulled"], 1, pulled)
        self.assertNotEqual(pulled["old"], pulled["new"])
        self.assertEqual(pulled["behind"], 0)
        self.assertEqual(pulled["submodules"]["count"], 1)
        self.assertEqual(pulled["submodules"]["needs_attention"], [])

        # diverge: local commit on consumer, remote commit on work
        self.fx.write(consumer, "local.txt", "l\n")
        gitops.commit(".", ["local.txt"], "feat: 消费端本地提交", str(consumer))
        self.fx.write(self.fx.work, "remote.txt", "r\n")
        gitops.commit(".", ["remote.txt"], "feat: 远端提交", str(self.fx.work))
        gitops.push(".", str(self.fx.work))
        with self.assertRaises(gitops.GitOpsError) as ctx:
            gitops.pull(".", str(consumer))
        self.assertIn("diverged", str(ctx.exception))
        self.assertEqual(run("status", "--short", cwd=consumer,
                             env=self.fx.env).returncode, 0)

    def test_pull_up_to_date_still_syncs_submodules(self):
        self.fx.write(self.fx.work, "u.txt", "u\n")
        gitops.commit(".", ["u.txt"], "feat: 增加 u 文件", str(self.fx.work))
        gitops.push(".", str(self.fx.work))
        result = gitops.pull(".", str(self.fx.work))
        self.assertEqual(result["pulled"], 0)
        self.assertIsNotNone(result["submodules"], result)
        self.assertEqual(result["submodules"]["needs_attention"], [])

    def test_commit_info_redacts_secrets(self):
        self.fx.write(self.fx.work, "secret.txt", "token = ghp_" + "a" * 30 + "\n")
        llm = FakeLlm()
        info = gitops.commit_info(".", ["secret.txt"], str(self.fx.work), llm)
        self.assertNotIn("ghp_" + "a" * 10, llm.prompt)
        self.assertIn("REDACTED", llm.prompt)
        self.assertEqual(info["header"].split("(")[0].split(":")[0], "fix")
        self.assertIsNone(gitops.validate_message(info["message"]))
        os.remove(self.fx.work / "secret.txt")

    def test_auto_commit_without_message(self):
        self.fx.write(self.fx.work, "auto.txt", "auto\n")
        result = gitops.auto_commit(".", ["auto.txt"], "", str(self.fx.work), FakeLlm())
        self.assertTrue(result["sha"])
        header = run("log", "-1", "--format=%s", cwd=self.fx.work).stdout.strip()
        self.assertTrue(header.startswith("fix(core):"), header)

    def test_register_contract(self):
        plugin = load_plugin()
        calls = {}
        work = str(self.fx.work)

        class FakeCtx:
            llm = FakeLlm()

            def session_cwd(self):
                return work

            def register_tool(self, **kwargs):
                calls[kwargs["name"]] = kwargs

        plugin.register(FakeCtx())
        self.assertEqual(sorted(calls), sorted([
            "git_repos", "git_status", "git_diff", "git_log", "git_commit_info",
            "git_commit", "git_push", "git_pull", "git_discard"]))
        for name, kwargs in calls.items():
            self.assertEqual(kwargs["schema"]["name"], name)
            self.assertEqual(kwargs["toolset"], "git-ops")
            self.assertTrue(callable(kwargs["handler"]))
        import json
        payload = json.loads(calls["git_status"]["handler"]({"repo": "."}))
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["data"]["branch"], "main")
        resources = json.loads(calls["git_repos"]["handler"]({}))
        self.assertTrue(resources["ok"], resources)
        self.assertGreaterEqual(resources["data"]["count"], 1)

    def test_pull_many_ordering_and_status(self):
        out = gitops.pull_many([str(self.fx.root)], str(self.fx.root), "ff", False)
        self.assertEqual(out["scanned"], len(out["results"]))
        self.assertIn(out["status"], {"ok", "partial", "failed"})
        paths = [r["path"].replace("\\", "/") for r in out["results"]]
        sub = next(i for i, p in enumerate(paths) if p.endswith("work/subs/lib"))
        parent = paths.index(next(p for p in paths if p.endswith("/work")))
        self.assertLess(parent, sub, paths)

    def test_push_picks_the_configured_remote(self):
        """首次推送不能写死 origin：只有 upstream 远端时要推它，并报出真实上游。"""
        mirror = self.fx._bare("mirror.git")
        solo = self.fx.root / "solo"
        run("init", "-b", "main", str(solo), env=self.fx.env)
        run("remote", "add", "upstream", str(mirror), cwd=solo, env=self.fx.env)
        (solo / "x.txt").write_text("x\n", encoding="utf-8")
        gitops.commit(".", ["x.txt"], "feat: 增加 x 文件", str(solo))
        pushed = gitops.push(".", str(solo))
        self.assertTrue(pushed["verified"], pushed)
        self.assertEqual(pushed["upstream"], "upstream/main")
        self.assertEqual(run("rev-parse", "--abbrev-ref", "@{u}", cwd=solo,
                             env=self.fx.env).stdout.strip(), "upstream/main")

    def test_dirty_rename_shape(self):
        self.fx.write(self.fx.work, "old.txt", "x\n")
        gitops.commit(".", ["old.txt"], "feat: 增加待改名文件", str(self.fx.work))
        run("mv", "old.txt", "new.txt", cwd=self.fx.work)
        files = gitops.status(".", str(self.fx.work))["files"]
        moved = [f for f in files if f["code"].startswith("R")]
        self.assertTrue(moved, files)
        self.assertEqual(moved[0]["path"], "new.txt")
        self.assertEqual(moved[0]["from"], "old.txt")
        # Land the rename: a staged rename left behind would make every later test's
        # commit fail the "index holds nothing outside the selected paths" guard.
        gitops.commit(".", ["new.txt", "old.txt"], "chore: 重命名 old 为 new", str(self.fx.work))

    def test_path_with_spaces_is_one_path(self):
        """`--name-only` 输出按空白切分会把 "my file.txt" 拆成两项并丢掉正文（-z 才行）。"""
        self.fx.write(self.fx.work, "my file.txt", "hello\n")
        diff, files, _truncated = gitops._diff(str(self.fx.work), [])
        self.assertIn("my file.txt", files, files)
        self.assertNotIn("file.txt", files, files)
        self.assertIn("new file: my file.txt", diff)
        self.assertIn("hello", diff)
        os.remove(self.fx.work / "my file.txt")

    def test_text_diff_and_log(self):
        self.fx.write(self.fx.work, "prof.txt", "one\n")
        gitops.commit(".", ["prof.txt"], "feat: 增加 prof 文件", str(self.fx.work))
        self.fx.write(self.fx.work, "prof.txt", "two\n")
        walked = gitops.text_diff(".", ["prof.txt"], str(self.fx.work))
        self.assertIn("+two", walked["diff"])
        self.assertEqual(walked["files"], ["prof.txt"])
        self.assertFalse(walked["truncated"])
        commits = gitops.log(".", 3, str(self.fx.work))
        self.assertLessEqual(commits["count"], 3)
        self.assertTrue(commits["commits"][0]["subject"].startswith("feat: 增加 prof"))
        self.assertTrue(commits["commits"][0]["sha"])

    def test_discard(self):
        self.fx.write(self.fx.work, "keep.txt", "v1\n")
        gitops.commit(".", ["keep.txt"], "feat: 增加 keep 文件", str(self.fx.work))
        self.fx.write(self.fx.work, "keep.txt", "v2\n")
        result = gitops.discard(".", ["keep.txt"], str(self.fx.work))
        self.assertEqual(result["discarded"], ["keep.txt"])
        self.assertEqual(result["still_dirty"], [])
        self.assertEqual((self.fx.work / "keep.txt").read_text(encoding="utf-8"), "v1\n")
        # untracked is refused, never deleted
        self.fx.write(self.fx.work, "fresh.txt", "f\n")
        with self.assertRaises(gitops.GitOpsError) as ctx:
            gitops.discard(".", ["fresh.txt"], str(self.fx.work))
        self.assertIn("untracked", str(ctx.exception))
        self.assertTrue((self.fx.work / "fresh.txt").exists())
        os.remove(self.fx.work / "fresh.txt")


if __name__ == "__main__":
    unittest.main(verbosity=2)
