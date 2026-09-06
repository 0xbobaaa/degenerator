"""Scaffolds into a temp dir, then runs the child repo's own tests.

The expensive tests here are the point of the tool: a generated repo whose
`make test` does not pass is a broken generator, not a broken bot.
"""

import ast
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

from degenerator import cli, receipts, scaffold, templates
from degenerator.scaffold import ScaffoldError
from degenerator.spec import parse, parse_file

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
MOMENTUM = EXAMPLES / "momentum.spec.md"
MEANREVERT = EXAMPLES / "meanrevert.spec.md"

#: Criterion 7, as a test rather than a grep: generated code imports these and
#: nothing else. Anything outside the two sets is a dependency in disguise.
STDLIB = {"hashlib", "json", "sys", "unittest", "datetime", "pathlib"}
LOCAL = {"risk", "strategy", "main", "venue"}

TEST_COMMAND = "python -m unittest discover -s tests -q"


@contextlib.contextmanager
def cd(path):
    previous = os.getcwd()
    os.chdir(str(path))
    try:
        yield Path(path)
    finally:
        os.chdir(previous)


@contextlib.contextmanager
def temp_dir():
    path = tempfile.mkdtemp(prefix="degenerator-")
    try:
        yield Path(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


def files_on_disk(root):
    """Every file under ``root``, as forward-slash relative paths."""
    return sorted(
        str(p.relative_to(root)).replace("\\", "/")
        for p in root.rglob("*")
        if p.is_file()
    )


def imported_roots(source):
    roots = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
    return roots


class TestTable(unittest.TestCase):
    """plan() and the file table cannot drift apart."""

    def test_plan_is_the_table(self):
        spec = parse_file(MOMENTUM)
        self.assertEqual(scaffold.plan(spec), [path for path, _ in scaffold.file_table(spec)])

    def test_plan_matches_what_lands_on_disk(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=True)
            self.assertEqual(files_on_disk(out), sorted(scaffold.plan(spec)))

    def test_the_venue_file_is_named_for_the_venue(self):
        for spec_path, expected in ((MOMENTUM, "hyperliquid"), (MEANREVERT, "dydx")):
            paths = scaffold.plan(parse_file(spec_path))
            self.assertIn("src/venue/{0}.py".format(expected), paths)
            self.assertEqual(1, len([p for p in paths if p.startswith("src/venue/") and "base" not in p]))

    def test_the_table_has_no_duplicates(self):
        paths = [path for path, _ in templates.TEMPLATES]
        self.assertEqual(len(paths), len(set(paths)))

    def test_plan_writes_nothing(self):
        with temp_dir() as tmp, cd(tmp):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                self.assertEqual(cli.main(["plan", str(MOMENTUM)]), 0)
            self.assertEqual(list(tmp.iterdir()), [])
            self.assertIn("src/risk.py", buffer.getvalue())


class TestGeneratedRepo(unittest.TestCase):
    """The generated repo has to stand up on its own, with no edits."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = Path(tempfile.mkdtemp(prefix="degenerator-repo-"))
        cls.spec = parse_file(MOMENTUM)
        cls.out = cls._tmp / "momentum-degen"
        cls.result = scaffold.write(cls.spec, cls.out, no_git=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(str(cls._tmp), ignore_errors=True)

    def test_its_own_test_suite_passes(self):
        done = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"],
            cwd=str(self.out),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertEqual(
            done.returncode, 0, done.stdout.decode("utf-8", "replace")
        )

    def test_the_makefile_runs_the_command_we_just_verified(self):
        makefile = (self.out / "Makefile").read_text(encoding="utf-8")
        self.assertIn("\t" + TEST_COMMAND, makefile)
        self.assertIn("\tpython src/main.py", makefile)

    def test_one_pass_of_the_bot_runs(self):
        done = subprocess.run(
            [sys.executable, "src/main.py"],
            cwd=str(self.out),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.assertEqual(done.returncode, 0, done.stdout.decode("utf-8", "replace"))
        self.assertTrue(list((self.out / "runs").glob("run-*.json")))

    def test_generated_python_compiles_without_a_warning(self):
        # The spec path is absolute here, backslashes and all: it gets quoted
        # into generated source, where a stray \p reads as a bad escape.
        for relative in scaffold.plan(self.spec):
            if not relative.endswith(".py"):
                continue
            source = (self.out / relative).read_text(encoding="utf-8")
            with warnings.catch_warnings():
                warnings.simplefilter("error")
                compile(source, relative, "exec")

    def test_stdlib_imports_only(self):
        for relative in scaffold.plan(self.spec):
            if not relative.endswith(".py"):
                continue
            roots = imported_roots((self.out / relative).read_text(encoding="utf-8"))
            unexpected = roots - STDLIB - LOCAL
            self.assertEqual(set(), unexpected, "{0} imports {1}".format(relative, unexpected))

    def test_requirements_is_empty_on_purpose(self):
        text = (self.out / "requirements.txt").read_text(encoding="utf-8")
        self.assertEqual([], [line for line in text.splitlines() if line and not line.startswith("#")])

    def test_no_crlf_anywhere(self):
        for relative in scaffold.plan(self.spec):
            self.assertNotIn(b"\r\n", (self.out / relative).read_bytes(), relative)

    def test_runs_directory_exists_and_is_empty(self):
        runs = self.out / "runs"
        self.assertTrue(runs.is_dir())

    def test_readme_ends_with_the_disclaimer(self):
        readme = (self.out / "README.md").read_text(encoding="utf-8").strip()
        self.assertTrue(readme.lower().endswith("nothing here is financial advice."), readme[-80:])

    def test_rules_are_verbatim_comments_in_the_strategy(self):
        strategy = (self.out / "src/strategy.py").read_text(encoding="utf-8")
        for rule in self.spec.rules:
            self.assertIn("# " + rule, strategy)

    def test_risk_numbers_cite_the_spec(self):
        risk = (self.out / "src/risk.py").read_text(encoding="utf-8")
        self.assertIn("# spec: max_position: 5%", risk)
        self.assertIn("MAX_POSITION = 0.05", risk)
        self.assertIn("# spec: leverage: 3x", risk)
        self.assertIn("LEVERAGE = 3", risk)

    def test_reported_bytes_match_the_bytes_on_disk(self):
        on_disk = sum((self.out / rel).stat().st_size for rel in self.result.files)
        self.assertEqual(self.result.bytes, on_disk)


class TestDefaultsInTheOutput(unittest.TestCase):
    """A spec that leans on defaults must say so in the generated repo."""

    def test_defaults_are_labelled_as_defaults(self):
        spec = parse_file(MEANREVERT)
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=True)
            risk = (out / "src/risk.py").read_text(encoding="utf-8")
            self.assertIn("# default: 1 (no leverage in the spec)", risk)
            self.assertIn("# spec: stop_loss: 2%", risk)

    def test_unknown_keys_survive_into_the_readme(self):
        spec = parse_file(MEANREVERT)
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=True)
            readme = (out / "README.md").read_text(encoding="utf-8")
            self.assertIn("author", readme)
            self.assertIn("bob", readme)
            self.assertIn("paper only until the funding math", readme)


class TestHostileSpecs(unittest.TestCase):
    """A spec is a file, and a file can come from someone else."""

    PAYLOAD = '5m"""; __import__("pathlib").Path("PWNED.txt").write_text("x"); """'

    def test_a_spec_value_cannot_execute_code_in_the_generated_repo(self):
        spec = parse(
            "# Hostile Bot\n\nvenue: paper\npairs: BTC\ntimeframe: {0}\n\nrules:\n- ape\n".format(
                self.PAYLOAD
            ),
            "hostile.spec.md",
        )
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=True)

            # It has to still be valid Python...
            for relative in scaffold.plan(spec):
                if relative.endswith(".py"):
                    compile((out / relative).read_text(encoding="utf-8"), relative, "exec")

            # ...and running the repo's own tests must not run the payload.
            done = subprocess.run(
                [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"],
                cwd=str(out),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            self.assertEqual(done.returncode, 0, done.stdout.decode("utf-8", "replace"))
            self.assertFalse((out / "PWNED.txt").exists(), "spec text executed as code")

    def test_the_value_still_survives_verbatim_where_it_is_data(self):
        # Neutralised for source, never silently dropped: repr() keeps it whole.
        spec = parse(
            "# Bot\n\ntimeframe: {0}\n\nrules:\n- ape\n".format(self.PAYLOAD), "s.spec.md"
        )
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=True)
            strategy = (out / "src/strategy.py").read_text(encoding="utf-8")
            self.assertIn(repr(self.PAYLOAD), strategy)

    def test_a_rule_cannot_escape_its_comment(self):
        spec = parse(
            '# Bot\n\nrules:\n- ape """ then import os\n', "s.spec.md"
        )
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=True)
            source = (out / "src/strategy.py").read_text(encoding="utf-8")
            compile(source, "strategy.py", "exec")
            self.assertIn('# ape """ then import os', source)


class TestNoPathLeak(unittest.TestCase):
    """An absolute spec path carries a home directory. Generated repos travel."""

    def test_the_generated_repo_never_names_the_full_spec_path(self):
        spec = parse_file(MOMENTUM)  # an absolute path, home directory and all
        self.assertTrue(Path(spec.source).is_absolute())
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=True)
            for relative in scaffold.plan(spec):
                text = (out / relative).read_text(encoding="utf-8")
                self.assertNotIn(spec.source, text, relative)
            readme = (out / "README.md").read_text(encoding="utf-8")
            self.assertIn("momentum.spec.md", readme)

    @unittest.skipIf(shutil.which("git") is None, "git is not installed")
    def test_the_commit_message_never_names_the_full_spec_path(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=False)
            log = subprocess.run(
                ["git", "log", "--format=%s%n%b"],
                cwd=str(out),
                stdout=subprocess.PIPE,
                check=True,
            ).stdout.decode("utf-8", "replace")
            self.assertNotIn(spec.source, log)
            self.assertIn("momentum.spec.md", log)

    def test_the_receipt_still_records_the_full_path(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            result = scaffold.write(spec, tmp / "bot", no_git=True)
            path = receipts.write_receipt(spec, result, 1, root=tmp)
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["spec"], spec.source)


class TestDeterminism(unittest.TestCase):
    def test_two_runs_into_the_same_dir_are_identical(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            out = tmp / "bot"
            first = scaffold.write(spec, out, no_git=True)
            snapshot = {rel: (out / rel).read_bytes() for rel in files_on_disk(out)}
            second = scaffold.write(spec, out, force=True, no_git=True)
            after = {rel: (out / rel).read_bytes() for rel in files_on_disk(out)}
            self.assertEqual(snapshot, after)
            self.assertEqual(first.files, second.files)
            self.assertEqual(first.bytes, second.bytes)

    def test_two_runs_into_different_dirs_are_identical(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            scaffold.write(spec, tmp / "a", no_git=True)
            scaffold.write(spec, tmp / "b", no_git=True)
            for relative in files_on_disk(tmp / "a"):
                self.assertEqual(
                    (tmp / "a" / relative).read_bytes(),
                    (tmp / "b" / relative).read_bytes(),
                    relative,
                )


class TestOverwriteRules(unittest.TestCase):
    def test_a_non_empty_directory_is_refused(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            (tmp / "keep.txt").write_text("mine", encoding="utf-8")
            with self.assertRaises(ScaffoldError) as caught:
                scaffold.write(spec, tmp, no_git=True)
            self.assertIn("--force", str(caught.exception))
            self.assertEqual(["keep.txt"], files_on_disk(tmp))

    def test_force_writes_over_it(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            (tmp / "keep.txt").write_text("mine", encoding="utf-8")
            scaffold.write(spec, tmp, force=True, no_git=True)
            self.assertIn("README.md", files_on_disk(tmp))


@unittest.skipIf(shutil.which("git") is None, "git is not installed")
class TestGit(unittest.TestCase):
    def test_init_and_one_commit(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            out = tmp / "bot"
            result = scaffold.write(spec, out, no_git=False)
            self.assertEqual("initialised · 1 commit", result.git)
            log = subprocess.run(
                ["git", "log", "--oneline"],
                cwd=str(out),
                stdout=subprocess.PIPE,
                check=True,
            )
            self.assertEqual(1, len(log.stdout.decode("utf-8", "replace").strip().splitlines()))

    def test_a_force_rerun_says_there_is_nothing_to_commit(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            out = tmp / "bot"
            scaffold.write(spec, out, no_git=False)
            again = scaffold.write(spec, out, force=True, no_git=False)
            self.assertEqual("initialised · nothing to commit", again.git)

    def test_no_git_leaves_no_repo(self):
        spec = parse_file(MOMENTUM)
        with temp_dir() as tmp:
            out = tmp / "bot"
            result = scaffold.write(spec, out, no_git=True)
            self.assertEqual("skipped", result.git)
            self.assertFalse((out / ".git").exists())


class TestReceipts(unittest.TestCase):
    def setUp(self):
        self.spec = parse_file(MOMENTUM)

    def test_receipt_shape_and_trace_log(self):
        with temp_dir() as tmp:
            out = tmp / "bot"
            result = scaffold.write(self.spec, out, no_git=True)
            path = receipts.write_receipt(self.spec, result, 24, root=tmp)

            self.assertEqual("runs", path.parent.parent.name)
            self.assertTrue(path.name.startswith("receipt-"))

            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(
                sorted(payload),
                sorted(["at", "spec", "project", "venue", "risk", "files", "bytes", "ms", "git"]),
            )
            self.assertEqual(payload["project"], "Momentum Degen")
            self.assertEqual(payload["venue"], "hyperliquid")
            self.assertEqual(payload["risk"], {"max_position": 0.05, "stop_loss": 0.03, "leverage": 3})
            self.assertEqual(payload["files"], result.files)
            self.assertEqual(payload["ms"], 24)
            self.assertTrue(payload["at"].endswith("+00:00"))

            trace = (tmp / "runs" / "trace.log").read_text(encoding="utf-8")
            self.assertEqual(1, len(trace.strip().splitlines()))

    def test_a_second_run_appends_and_does_not_clobber(self):
        with temp_dir() as tmp:
            out = tmp / "bot"
            result = scaffold.write(self.spec, out, no_git=True)
            first = receipts.write_receipt(self.spec, result, 1, root=tmp)
            second = receipts.write_receipt(self.spec, result, 2, root=tmp)
            self.assertNotEqual(first, second)
            self.assertTrue(first.exists())
            trace = (tmp / "runs" / "trace.log").read_text(encoding="utf-8")
            self.assertEqual(2, len(trace.strip().splitlines()))


class TestCli(unittest.TestCase):
    def run_cli(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_new_writes_a_repo_and_a_receipt(self):
        with temp_dir() as tmp, cd(tmp):
            code, out, _ = self.run_cli(["new", str(MOMENTUM), "-o", "bot", "--no-git"])
            self.assertEqual(0, code)
            self.assertIn("Momentum Degen -> bot/", out)
            self.assertIn("receipt: runs/", out)
            self.assertIn("next:", out)
            self.assertTrue((tmp / "bot" / "README.md").exists())
            self.assertTrue(list((tmp / "runs").rglob("receipt-*.json")))

    def test_dry_run_touches_nothing(self):
        with temp_dir() as tmp, cd(tmp):
            code, out, _ = self.run_cli(["new", str(MOMENTUM), "-o", "bot", "--dry-run"])
            self.assertEqual(0, code)
            self.assertIn("nothing written", out)
            self.assertEqual([], list(tmp.iterdir()))

    def test_out_defaults_to_the_slug(self):
        with temp_dir() as tmp, cd(tmp):
            self.run_cli(["new", str(MOMENTUM), "--no-git"])
            self.assertTrue((tmp / "momentum-degen" / "README.md").exists())

    def test_a_spec_with_no_rules_is_refused(self):
        with temp_dir() as tmp, cd(tmp):
            bad = tmp / "norules.spec.md"
            bad.write_text("# No Rules\n\nvenue: paper\n", encoding="utf-8")
            code, _, err = self.run_cli(["new", str(bad), "-o", "bot"])
            self.assertEqual(2, code)
            self.assertEqual(1, len(err.strip().splitlines()))
            self.assertIn("random number generator", err)
            self.assertFalse((tmp / "bot").exists())

    def test_an_unknown_venue_is_refused(self):
        with temp_dir() as tmp, cd(tmp):
            bad = tmp / "bad-venue.spec.md"
            bad.write_text("# Bot\n\nvenue: binance\n\nrules:\n- ape\n", encoding="utf-8")
            code, _, err = self.run_cli(["new", str(bad), "-o", "bot"])
            self.assertEqual(2, code)
            self.assertEqual(1, len(err.strip().splitlines()))
            self.assertIn("hyperliquid", err)
            self.assertFalse((tmp / "bot").exists())

    def test_a_refusal_exits_non_zero_from_the_shell(self):
        with temp_dir() as tmp:
            bad = tmp / "norules.spec.md"
            bad.write_text("# No Rules\n\nvenue: paper\n", encoding="utf-8")
            done = subprocess.run(
                [sys.executable, "-m", "degenerator.cli", "new", str(bad)],
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertNotEqual(0, done.returncode)
            self.assertEqual(b"", done.stdout)


if __name__ == "__main__":
    unittest.main()
