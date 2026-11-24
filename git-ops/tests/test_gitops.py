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

    def test_submodule_paths_keep_spaces(self):
        """.gitmodules 里带空格的路径不能被 git config 输出拆开或加引号。"""
        probe = self.fx.root / "paths-probe"
        probe.mkdir()
        (probe / ".gitmodules").write_text(
            '[submodule "a"]\n\tpath = subs/my lib\n\turl = ../s.git\n', encoding="utf-8")
        self.assertEqual(gitops._submodule_paths(str(probe)), ["subs/my lib"])

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
        """One `status --porcelain=v2 --branch` supplies branch/upstream/ahead/behind/files/gone."""
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
        self.assertNotIn("symbolic-ref", calls)
        self.assertNotIn("rev-list", calls)
        self.assertNotIn("for-each-ref", calls)  # gone is derived from the status header
        self.assertEqual(calls.count("status"), 1, calls)
        self.assertLessEqual(len(calls), 2, calls)  # + a cold rev-parse for the toplevel

    def test_gone_upstream_needs_no_second_process(self):
        """上流被删时 status 只打 branch.upstream、不打 branch.ab：gone 由它推出。"""
        root = Path(tempfile.mkdtemp(prefix="gitops-gone-"))
        try:
            env = self.fx.env
            bare, work = root / "o.git", root / "w"
            run("init", "--bare", "-b", "main", str(bare), env=env)
            run("clone", str(bare), str(work), env=env)
            (work / "a.txt").write_text("a\n", encoding="utf-8")
            run("add", "a.txt", cwd=work, env=env)
            run("commit", "-m", "feat: a", cwd=work, env=env)
            run("push", "-u", "origin", "main", cwd=work, env=env)
            run("checkout", "-b", "side", cwd=work, env=env)
            run("push", "-u", "origin", "side", cwd=work, env=env)
            run("push", "origin", "--delete", "side", cwd=work, env=env)
            calls = []
            real = gitops._run

            def spy(args, cwd=None, timeout=60):
                calls.append(args[0])
                return real(args, cwd, timeout)

            gitops._run = spy
            try:
                st = gitops.status(".", str(work))
            finally:
                gitops._run = real
            self.assertEqual(st["upstream"], "origin/side")
            self.assertEqual(st["gone"], "[gone]")
            self.assertNotIn("for-each-ref", calls, calls)
            self.assertEqual(calls.count("status"), 1, calls)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_file_diff_costs_one_git_call(self):
        """面板点一行：1 次 git；未跟踪文件 0 次（直接读文件），不是 _diff 的 5 次。"""
        work = str(self.fx.work)
        top = gitops.toplevel(work)
        self.fx.write(self.fx.work, "fd-clean.txt", "keep\n")
        self.fx.write(self.fx.work, "fd-tracked.txt", "one\n")
        gitops.commit(".", ["fd-clean.txt", "fd-tracked.txt"], "feat: 增加 fd 文件", work)
        calls = []
        real = gitops._run

        def spy(args, cwd=None, timeout=60):
            calls.append(args[0])
            return real(args, cwd, timeout)

        self.fx.write(self.fx.work, "fd-tracked.txt", "two\n")
        gitops._run = spy
        try:
            text, truncated = gitops.file_diff(top, "fd-tracked.txt")
            self.assertIn("+two", text)
            self.assertFalse(truncated)
            self.assertEqual(calls, ["diff"], calls)
            # staged + unstaged fold into the one `diff HEAD`
            run("add", "fd-tracked.txt", cwd=self.fx.work, env=self.fx.env)
            self.fx.write(self.fx.work, "fd-tracked.txt", "three\n")
            staged, _ = gitops.file_diff(top, "fd-tracked.txt")
            self.assertIn("+three", staged)
            self.assertEqual(len(calls), 2, calls)
            # untracked: the pane already knows, so no git process at all
            del calls[:]
            self.fx.write(self.fx.work, "fd-new.txt", "brand new\n")
            fresh, _ = gitops.file_diff(top, "fd-new.txt", untracked=True)
            self.assertIn("brand new", fresh)
            self.assertIn("new file: fd-new.txt", fresh)
            self.assertEqual(calls, [], calls)
            # tracked and unchanged → empty, so the route can say "no diff"
            clean, _ = gitops.file_diff(top, "fd-clean.txt")
            self.assertEqual(clean.strip(), "")
            self.assertEqual(calls, ["diff", "ls-files"], calls)
        finally:
            gitops._run = real
            run("restore", "--staged", "fd-tracked.txt", cwd=self.fx.work, env=self.fx.env)
            run("restore", "fd-tracked.txt", cwd=self.fx.work, env=self.fx.env)
            os.remove(self.fx.work / "fd-new.txt")

    def test_push_and_pull_skip_the_untracked_walk(self):
        """push/pull 只读分支头与 oid：每次 status 都必须带 -uno。"""
        work = str(self.fx.work)
        self.fx.write(self.fx.work, "uno.txt", "u\n")
        gitops.commit(".", ["uno.txt"], "feat: 增加 uno 文件", work)
        seen = []
        real = gitops._run

        def spy(args, cwd=None, timeout=60):
            if args[0] == "status":
                seen.append(list(args))
            return real(args, cwd, timeout)

        gitops._run = spy
        try:
            gitops.push(".", work)
            gitops.pull(".", work, "ff", False)
        finally:
            gitops._run = real
        self.assertTrue(seen, "no status calls recorded")
        for args in seen:
            self.assertIn("-uno", args, args)

    def test_commit_reuses_one_status_for_known_paths(self):
        """commit 不再额外 dump 索引：known 路径全部来自那一次 status。"""
        work = str(self.fx.work)
        self.fx.write(self.fx.work, "kp.txt", "k\n")
        calls = []
        real = gitops._run

        def spy(args, cwd=None, timeout=60):
            calls.append(args[0])
            return real(args, cwd, timeout)

        gitops._run = spy
        try:
            result = gitops.commit(".", ["kp.txt"], "feat: 增加 kp 文件", work)
        finally:
            gitops._run = real
        self.assertEqual(result["files"], ["kp.txt"])
        self.assertNotIn("ls-files", calls, calls)
        self.assertEqual(calls.count("status"), 1, calls)
        self.assertLessEqual(len(calls), 6, calls)

    def test_list_files_is_one_git_call(self):
        """--cached 与 --others 同一次调用：20k 文件的仓库省一整次 ls-files。"""
        self.fx.write(self.fx.work, "lf-untracked.txt", "u\n")
        calls = []
        real = gitops._run

        def spy(args, cwd=None, timeout=60):
            calls.append(args[0])
            return real(args, cwd, timeout)

        gitops._run = spy
        try:
            full = gitops.list_files(".", str(self.fx.work))
            self.assertIn("lf-untracked.txt", full["files"])
            self.assertIn("readme.txt", full["files"])
            self.assertEqual(calls, ["ls-files"], calls)
            del calls[:]
            tracked_only = gitops.list_files(".", str(self.fx.work), include_untracked=False)
            self.assertNotIn("lf-untracked.txt", tracked_only["files"])
            self.assertEqual(calls, ["ls-files"], calls)
        finally:
            gitops._run = real
            os.remove(self.fx.work / "lf-untracked.txt")

    def test_run_never_reads_stdin_or_flashes_a_console(self):
        """GUI 宿主里每次 git 都不能等 stdin，Windows 上也不许弹控制台窗。"""
        seen = {}
        real = subprocess.run

        def capture(*a, **kw):
            seen.update(kw)
            return real(*a, **kw)

        subprocess.run = capture
        try:
            gitops._run(["rev-parse", "--git-dir"], cwd=str(self.fx.work))
        finally:
            subprocess.run = real
        self.assertIs(seen.get("stdin"), subprocess.DEVNULL)
        self.assertEqual(seen.get("creationflags"), gitops.NO_WINDOW)
        if os.name == "nt":
            self.assertNotEqual(gitops.NO_WINDOW, 0)

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

    def test_commit_unstaged_deletion(self):
        """工作区里直接删掉的文件（未暂存）也要能提交：索引里还有它，git add 暂存这次删除。"""
        self.fx.write(self.fx.work, "deep/rm-me.txt", "r\n")
        gitops.commit(".", ["deep/rm-me.txt"], "feat: 增加 rm-me 文件", str(self.fx.work))
        os.remove(self.fx.work / "deep/rm-me.txt")
        result = gitops.commit(".", ["deep/rm-me.txt"], "chore: 删除 rm-me 文件", str(self.fx.work))
        self.assertEqual(result["files"], ["deep/rm-me.txt"])
        self.assertEqual(run("ls-files", "--", "deep/rm-me.txt",
                             cwd=self.fx.work, env=self.fx.env).stdout.strip(), "")
        landed = run("show", "--name-status", "--format=", "HEAD",
                     cwd=self.fx.work, env=self.fx.env).stdout
        self.assertIn("D\tdeep/rm-me.txt", landed)

    def test_commit_unstaged_deletion_of_a_whole_directory(self):
        """整个目录被删（未暂存）时传目录路径也要能提交：索引里还有它下面的文件。"""
        self.fx.write(self.fx.work, "deep-dir/a.txt", "a\n")
        self.fx.write(self.fx.work, "deep-dir/nested/b.txt", "b\n")
        gitops.commit(".", ["deep-dir"], "feat: 增加 deep-dir 目录", str(self.fx.work))
        shutil.rmtree(self.fx.work / "deep-dir")
        result = gitops.commit(".", ["deep-dir"], "chore: 删除 deep-dir 目录", str(self.fx.work))
        self.assertEqual(sorted(result["files"]), ["deep-dir/a.txt", "deep-dir/nested/b.txt"])
        landed = run("show", "--name-status", "--format=", "HEAD",
                     cwd=self.fx.work, env=self.fx.env).stdout
        self.assertIn("D\tdeep-dir/a.txt", landed)
        self.assertIn("D\tdeep-dir/nested/b.txt", landed)

    def test_commit_deletion_is_not_dropped_when_batched_with_an_edit(self):
        """删除与修改同选：两条都要进这次提交，不能静默只提交一半。"""
        self.fx.write(self.fx.work, "batch-gone.txt", "g\n")
        self.fx.write(self.fx.work, "batch-keep.txt", "k\n")
        gitops.commit(".", ["batch-gone.txt", "batch-keep.txt"],
                      "feat: 增加批量用例文件", str(self.fx.work))
        os.remove(self.fx.work / "batch-gone.txt")
        self.fx.write(self.fx.work, "batch-keep.txt", "k2\n")
        result = gitops.commit(".", ["batch-gone.txt", "batch-keep.txt"],
                               "chore: 批量删除与修改", str(self.fx.work))
        self.assertEqual(sorted(result["files"]), ["batch-gone.txt", "batch-keep.txt"])
        landed = run("show", "--name-status", "--format=", "HEAD",
                     cwd=self.fx.work, env=self.fx.env).stdout
        self.assertIn("D\tbatch-gone.txt", landed)
        self.assertIn("M\tbatch-keep.txt", landed)
    def test_status_lists_untracked_files_inside_a_new_directory(self):
        """新建目录不能塌成一个 ``dir/``：那样的路径在面板里是空名字，提交也对不上。"""
        self.fx.write(self.fx.work, "fresh-dir/a.txt", "a\n")
        self.fx.write(self.fx.work, "fresh-dir/nested/b.txt", "b\n")
        try:
            files = gitops.status(".", str(self.fx.work))["files"]
            fresh = sorted(f["path"] for f in files if f["path"].startswith("fresh-dir"))
            self.assertEqual(fresh, ["fresh-dir/a.txt", "fresh-dir/nested/b.txt"])
            self.assertFalse([p for p in fresh if p.endswith("/")], fresh)
        finally:
            shutil.rmtree(self.fx.work / "fresh-dir", ignore_errors=True)

    def test_commit_stages_the_files_of_a_new_directory(self):
        """面板勾选的就是 status 给的文件路径：提交必须落地，不能报 index 不一致。"""
        self.fx.write(self.fx.work, "pick-dir/a.txt", "a\n")
        self.fx.write(self.fx.work, "pick-dir/nested/b.txt", "b\n")
        picked = [f["path"] for f in gitops.status(".", str(self.fx.work))["files"]
                  if f["path"].startswith("pick-dir")]
        result = gitops.commit(".", picked, "feat: 增加 pick-dir 目录", str(self.fx.work))
        self.assertEqual(sorted(result["files"]), ["pick-dir/a.txt", "pick-dir/nested/b.txt"])

    def test_commit_accepts_a_directory_pathspec_with_a_trailing_slash(self):
        """``dir/``（git 自己的写法）与 ``dir`` 等价：整目录提交两种写法都要能过。"""
        for spelling, name in (("spell-a", "spell-a"), ("spell-b/", "spell-b")):
            self.fx.write(self.fx.work, f"{name}/inner/c.txt", "c\n")
            result = gitops.commit(".", [spelling], "feat: 新增 " + name + " 目录",
                                   str(self.fx.work))
            self.assertEqual(result["files"], [f"{name}/inner/c.txt"], spelling)

    def test_pull_advances_detached_submodule_to_its_gitlink(self):
        """detached 的子模块仍跟父级 gitlink 前进：修复不能削弱原来的建树语义。"""
        consumer = self.fx._clone(self.fx.origin, "consumer-detached")
        run("submodule", "update", "--init", "--recursive", cwd=consumer, env=self.fx.env)
        lib = consumer / "subs/lib"
        before = run("rev-parse", "HEAD", cwd=lib, env=self.fx.env).stdout.strip()

        sub = self.fx.sub_work
        self.fx.write(sub, "next.txt", "n\n")
        run("add", "next.txt", cwd=sub, env=self.fx.env)
        run("commit", "-m", "feat: 子模块新提交", cwd=sub, env=self.fx.env)
        run("push", "origin", "HEAD", cwd=sub, env=self.fx.env)
        target = run("rev-parse", "HEAD", cwd=sub, env=self.fx.env).stdout.strip()

        work_lib = self.fx.work / "subs/lib"
        run("fetch", "origin", cwd=work_lib, env=self.fx.env)
        run("checkout", target, cwd=work_lib, env=self.fx.env)
        run("add", "subs/lib", cwd=self.fx.work, env=self.fx.env)
        run("commit", "-m", "chore: 提升子模块指针", cwd=self.fx.work, env=self.fx.env)
        run("push", "origin", "HEAD", cwd=self.fx.work, env=self.fx.env)

        result = gitops.pull(".", str(consumer))
        self.assertNotEqual(before, target)
        self.assertEqual(result["submodules"]["needs_attention"], [], result)
        self.assertEqual(run("rev-parse", "HEAD", cwd=lib,
                             env=self.fx.env).stdout.strip(), target)
        self.assertEqual(run("symbolic-ref", "-q", "--short", "HEAD", cwd=lib,
                             env=self.fx.env, check=False).returncode, 1)  # 仍然 detached

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

    def test_pull_keeps_submodule_on_its_branch(self):
        """父仓库 pull 不能把在分支上的子模块 reset 到 gitlink：那会 detach 并藏掉它的提交。"""
        consumer = self.fx._clone(self.fx.origin, "consumer-branch")
        run("submodule", "update", "--init", "--recursive", cwd=consumer, env=self.fx.env)
        lib = consumer / "subs/lib"
        run("checkout", "-B", "main", cwd=lib, env=self.fx.env)
        self.fx.write(lib, "wip.txt", "w\n")
        run("add", "wip.txt", cwd=lib, env=self.fx.env)
        run("commit", "-m", "feat: 子模块本地提交", cwd=lib, env=self.fx.env)
        local = run("rev-parse", "HEAD", cwd=lib, env=self.fx.env).stdout.strip()

        self.fx.write(self.fx.work, "after.txt", "a\n")
        gitops.commit(".", ["after.txt"], "feat: 父仓库提交", str(self.fx.work))
        gitops.push(".", str(self.fx.work))
        result = gitops.pull(".", str(consumer))

        self.assertGreaterEqual(result["pulled"], 1, result)
        self.assertEqual(run("symbolic-ref", "--short", "HEAD", cwd=lib,
                             env=self.fx.env).stdout.strip(), "main")
        self.assertEqual(run("rev-parse", "HEAD", cwd=lib,
                             env=self.fx.env).stdout.strip(), local)
        self.assertIn("subs/lib", result["submodules"]["on_branch"], result)

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

    def test_mutating_tool_emits_change_event(self):
        """commit/push/pull/discard 成功后要往会话事件流推 plugin.git-ops.<kind>。"""
        import json
        plugin = load_plugin()
        work = str(self.fx.work)
        events, calls = [], {}

        class FakeCtx:
            llm = FakeLlm()

            def session_cwd(self):
                return work

            def register_tool(self, **kwargs):
                calls[kwargs["name"]] = kwargs

            def emit_to_session(self, session_id, event, payload=None):
                events.append((session_id, event, payload))
                return True

        plugin.register(FakeCtx())
        saved = os.environ.get("HERMES_SESSION_ID")
        os.environ["HERMES_SESSION_ID"] = "session-under-test"
        try:
            self.fx.write(self.fx.work, "ev.txt", "e\n")
            answer = json.loads(calls["git_commit"]["handler"](
                {"repo": work, "paths": ["ev.txt"], "message": "feat: 增加 ev 文件"}))
            self.assertTrue(answer["ok"], answer)
            self.assertEqual(len(events), 1, events)
            session_id, event, payload = events[0]
            self.assertEqual(session_id, "session-under-test")
            self.assertEqual(event, "commit")
            self.assertEqual(payload["kind"], "commit")
            self.assertEqual(payload["repo"], gitops.resolve_repo(work, work))
            self.assertEqual(payload["sha"], answer["data"]["sha"])
            # A failed call must stay silent, or the pane refreshes on nothing. A sweeping
            # pathspec is the cheapest real refusal (an untracked path is no longer one: it
            # now succeeds with a 'skipped' list), and it touches no file.
            events.clear()
            failed = json.loads(calls["git_discard"]["handler"](
                {"repo": work, "paths": ["."]}))
            self.assertFalse(failed["ok"], failed)
            self.assertEqual(events, [])
        finally:
            if saved is None:
                os.environ.pop("HERMES_SESSION_ID", None)
            else:
                os.environ["HERMES_SESSION_ID"] = saved

    def test_change_event_falls_back_to_broadcast(self):
        """会话门不通（isolation: host 无 session id）时退化成全局广播，面板照样刷新。"""
        import json
        plugin = load_plugin()
        work = str(self.fx.work)
        events, calls, broadcasts = [], {}, []
        original = getattr(plugin, "_broadcast")
        setattr(plugin, "_broadcast", lambda kind, payload: broadcasts.append((kind, payload)))

        class FakeCtx:
            llm = FakeLlm()

            def session_cwd(self):
                return work

            def register_tool(self, **kwargs):
                calls[kwargs["name"]] = kwargs

            def emit_to_session(self, session_id, event, payload=None):
                events.append((session_id, event, payload))
                return False  # no live viewer on that session stream

        saved = os.environ.pop("HERMES_SESSION_ID", None)
        try:
            plugin.register(FakeCtx())
            self.fx.write(self.fx.work, "bc.txt", "b\n")
            answer = json.loads(calls["git_commit"]["handler"](
                {"repo": work, "paths": ["bc.txt"], "message": "feat: 增加 bc 文件"}))
            self.assertTrue(answer["ok"], answer)
            self.assertEqual(events, [], "no session id -> the session door is skipped")
            self.assertEqual(len(broadcasts), 1, broadcasts)
            self.assertEqual(broadcasts[0][0], "commit")
            self.assertEqual(broadcasts[0][1]["repo"], gitops.resolve_repo(work, work))
        finally:
            setattr(plugin, "_broadcast", original)
            if saved is not None:
                os.environ["HERMES_SESSION_ID"] = saved

    def test_discard(self):
        self.fx.write(self.fx.work, "keep.txt", "v1\n")
        gitops.commit(".", ["keep.txt"], "feat: 增加 keep 文件", str(self.fx.work))
        self.fx.write(self.fx.work, "keep.txt", "v2\n")
        result = gitops.discard(".", ["keep.txt"], str(self.fx.work))
        self.assertEqual(result["discarded"], ["keep.txt"])
        self.assertEqual(result["still_dirty"], [])
        self.assertEqual(result["skipped"], [])
        self.assertEqual((self.fx.work / "keep.txt").read_text(encoding="utf-8"), "v1\n")
        # An untracked path is never deleted and never blocks the tracked paths beside it.
        self.fx.write(self.fx.work, "fresh.txt", "f\n")
        self.fx.write(self.fx.work, "keep.txt", "v3\n")
        result = gitops.discard(".", ["keep.txt", "fresh.txt"], str(self.fx.work))
        self.assertEqual(result["discarded"], ["keep.txt"])
        self.assertEqual(result["skipped"], ["fresh.txt"])
        self.assertEqual(result["still_dirty"], [])
        self.assertEqual((self.fx.work / "keep.txt").read_text(encoding="utf-8"), "v1\n")
        self.assertTrue((self.fx.work / "fresh.txt").exists())
        # ... and an untracked-only selection is an empty result, not a failure.
        result = gitops.discard(".", ["fresh.txt"], str(self.fx.work))
        self.assertEqual(result["discarded"], [])
        self.assertEqual(result["skipped"], ["fresh.txt"])
        self.assertTrue((self.fx.work / "fresh.txt").exists())
        # A staged deletion is tracked (it is gone from the index but lives in HEAD), so it
        # restores instead of being misread as untracked.
        run("rm", "-q", "keep.txt", cwd=self.fx.work, env=self.fx.env)
        result = gitops.discard(".", ["keep.txt"], str(self.fx.work))
        self.assertEqual(result["discarded"], ["keep.txt"], result)
        self.assertEqual((self.fx.work / "keep.txt").read_text(encoding="utf-8"), "v1\n")
        os.remove(self.fx.work / "fresh.txt")


if __name__ == "__main__":
    unittest.main(verbosity=2)
