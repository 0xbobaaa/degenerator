"""The generator on the website is the generator in this package.

docs/degenerator.js is a hand port of spec.py and templates.py so the site can
run it in a browser. A port that drifts is worse than no port: it would hand
people a repository the CLI never writes. So this suite runs the same specs
through both and fails on a single byte of difference, in every generated file,
in every refusal message, in the size the CLI prints, and inside the zip the
page offers for download.

Needs Node. Locally a missing node is a skip; in CI it is a failure, because a
parity test that quietly does not run is exactly how the two would drift.
"""

import base64
import difflib
import io
import json
import os
import shutil
import subprocess
import unittest
import zipfile
from pathlib import Path

from degenerator import cli
from degenerator.spec import SpecError, parse
from degenerator.templates import DIRECTORIES, render

ROOT = Path(__file__).resolve().parents[1]
PORT = ROOT / "docs" / "degenerator.js"
PAGE = ROOT / "docs" / "index.html"

DRIVER = r"""
const port = require(process.argv[1]);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const out = JSON.parse(input).map(([text, source]) => {
    let spec;
    try {
      spec = port.parse(text, source);
    } catch (err) {
      return err instanceof port.SpecError ? { error: err.message } : { crash: String(err.stack || err) };
    }
    try {
      const files = port.render(spec);
      const first = Buffer.from(port.bundle(spec));
      const second = Buffer.from(port.bundle(spec));
      return {
        slug: spec.slug,
        files: files,
        label: port.size(files).label,
        zip: first.toString("base64"),
        stable: first.equals(second),
      };
    } catch (err) {
      return { crash: String(err.stack || err) };
    }
  });
  process.stdout.write(JSON.stringify(out));
});
"""


def spec_with(line, venue="hyperliquid"):
    return "# Numbers\n\nvenue: {0}\n{1}\n\nrules:\n- ape\n".format(venue, line)


def cases():
    found = [
        (path.read_text(encoding="utf-8"), "examples/" + path.name)
        for path in sorted((ROOT / "examples").glob("*.spec.md"))
    ]
    found += [
        # structure, defaults, unknown and repeated keys
        ("# Bare Bot\n\nrules:\n- buy the dip\n", "bare.spec.md"),
        (
            "# Keys\n\nauthor: bob\nvenue: dydx\nauthor: alice\n: empty key\n"
            "notes: a: b: c\n\nrules: inline first rule\n- second\n-\n- third # not a comment\n",
            "keys.spec.md",
        ),
        ("# Late\n\nrules:\n- one\nvenue: paper\n- two\n", "late.spec.md"),
        # line endings and byte order marks
        ("\ufeff\ufeff# BOM\r\n\r\nvenue: paper\r\nrules:\r\n- crlf\r\n", "bom.spec.md"),
        ("# Old Mac\rvenue: paper\rrules:\r- cr only\r", "cr.spec.md"),
        (
            "# Breaks\x0bvenue: paper\x0crules:\u2028- u2028\u2029- u2029\x85- nel\x1c- fs\x1d- gs\n",
            "b.spec.md",
        ),
        # what Python counts as space, and what it does not
        (
            "# Spaces\n\n\u3000venue:\u00a0dydx\u2003\npairs:\u2009eth ,\x1f arb\u205f\n"
            "timeframe:\u1680 1h \u202f\n\nrules:\n-\u2000 spaced\u200a\n",
            "spaces.spec.md",
        ),
        ("# \ufeffNot space\n\ntimeframe: \ufeff5m\ufeff\n\nrules:\n- x\n", "feff.spec.md"),
        # free text that ends up inside generated Python
        ('# Quotes\n\ntimeframe: 5m"""; __import__("os"); """\n\nrules:\n- x\n', "q1.spec.md"),
        ("# Quotes\n\ntimeframe: it's \"both\" \\ back\n\nrules:\n- x\n", "q2.spec.md"),
        ("# Quotes\n\ntimeframe: it's\n\nrules:\n- x\n", "q3.spec.md"),
        (
            "# Odd\n\ntimeframe: \u03a9 \U0001f680 soft\u00adhyphen zero\u200bwidth \x7f del\tab\n\n"
            "rules:\n- x\n",
            "o.spec.md",
        ),
        (
            "# \u00cbpic D\u00f6ge \U0001f680 v2!\n\npairs: \u00df, stra\u00dfe, btc,, sol ,\n\n"
            "rules:\n- x\n",
            "u.spec.md",
        ),
        ("# !!!\n\nrules:\n- x\n", "my spec (1).md"),
        ("# Name\n\nrules:\n- x\n", "quote\"name'.md"),
        # refusals
        ("#\n\nrules:\n- a\n", "r.spec.md"),
        ("venue: paper\n\nrules:\n- a\n", "r.spec.md"),
        ("# T\n\n- a\n\nrules:\n- a\n", "r.spec.md"),
        ("# T\n\nnonsense line\n\nrules:\n- a\n", "r.spec.md"),
        ("# T\n\nsay \"hi\" it's\n\nrules:\n- a\n", "r.spec.md"),
        ("# T\n\nwe\u200bird\u00ad\ttab\x7f \U0001f680 back\\slash\n\nrules:\n- a\n", "r.spec.md"),
        ("# T\n\nvenue: Binance\n\nrules:\n- a\n", "r.spec.md"),
        ("# T\n\nvenue: it's\n\nrules:\n- a\n", "r.spec.md"),
        ("# T\n\npairs: , ,\n\nrules:\n- a\n", "r.spec.md"),
        ("# T\n\nvenue: paper\n", "r.spec.md"),
        ("# T\n\nrules:\n", "r.spec.md"),
        # the spot venue
        ("# T\n\nvenue: robinhood\nleverage: 3x\n\nrules:\n- a\n", "rh.spec.md"),
        ("# T\n\nvenue: ROBINHOOD\nleverage: 1.5\n\nrules:\n- a\n", "rh.spec.md"),
        ("# T\n\nvenue: robinhood\nleverage: 1\n\nrules:\n- a\n", "rh.spec.md"),
        ("# T\n\nvenue: robinhood\nleverage: 100%\n\nrules:\n- a\n", "rh.spec.md"),
        ("# T\n\nleverage: 3x\nvenue: robinhood\nleverage: 2\n\nrules:\n- a\n", "rh.spec.md"),
    ]
    numbers = [
        "5%", "12.5%", "0.1%", "33.333333333%", "2.675%", "7  %", "%",
        "0.0000001", "1e-7", "1E3", "1_000", "1_0.0_1", "5.", ".5", "+3", "007",
        "100000000000000000000", "1e20", "123456789012345678901234567890",
        "1.7976931348623157e308", "7.000000000049999", "0.123456789", "0.1234567895",
        "2", "2.5",
        # Exact binary halves at the rounding digit, where half-to-even and
        # half-up disagree: 2**-11 is a tie in round(v, 10), and 7.8125e-05
        # makes the 0.0078125 that pct() hands to round(scaled, 6).
        "0.00048828125", "7.8125e-05",
        "\u0663.\u0661\u0664",  # Arabic-Indic digits with an ASCII point
        "\u0661\u0660\u0660\u0660",
        "\uff11\uff12",  # fullwidth digits
        "\U0001d7d0\U0001d7ce",  # mathematical bold digits: 2, 0
        "1e-400", "0", "-0", "-5", "0.0%", "inf", "-Infinity", "NaN", "1e309",
        "0x10", "1__0", "_1", "1_", "1e", "e5", "--1", "1.2.3", "", "lots",
    ]
    for key in ("max_position", "stop_loss", "cash"):
        found += [(spec_with("{0}: {1}".format(key, raw)), "n.spec.md") for raw in numbers]
    for raw in ("3x", "2.5X", "x", "3xx", "10", "0.5x", " 4 x "):
        found.append((spec_with("leverage: " + raw), "n.spec.md"))
    found.append(size_on_a_tie())
    return found


def size_on_a_tie():
    """A spec whose repo is exactly N250 bytes, so "{0:.1f}kb" rounds a true half.

    Found by padding an unknown key rather than hard-coded, so it keeps landing
    on the tie when the templates change.
    """
    for pad in range(2000):
        text = "# Tie\n\nnote: {0}\n\nrules:\n- ape\n".format("x" * pad)
        total = sum(len(body.encode("utf-8")) for _, body in render(parse(text, "tie.spec.md")))
        if total % 1000 == 250:
            return text, "tie.spec.md"
    raise AssertionError("no padding lands the generated repo on a rounding tie")


def run_port(inputs):
    done = subprocess.run(
        [shutil.which("node"), "-e", DRIVER, str(PORT)],
        input=json.dumps(inputs).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if done.returncode != 0:
        raise AssertionError("node failed:\n" + done.stderr.decode("utf-8", "replace"))
    return json.loads(done.stdout.decode("utf-8"))


class TestTheSiteRunsTheRealGenerator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("node") is None:
            if os.environ.get("CI"):
                raise AssertionError("node is required in CI: the site/CLI parity test must run")
            raise unittest.SkipTest("node is not installed")
        cls.inputs = cases()
        cls.results = run_port(cls.inputs)

    def test_every_spec_comes_out_byte_identical(self):
        self.assertEqual(len(self.inputs), len(self.results))
        for (text, source), theirs in zip(self.inputs, self.results):
            with self.subTest(source=source, spec=text[:80]):
                self.assertNotIn("crash", theirs, theirs.get("crash"))
                try:
                    spec = parse(text, source)
                except SpecError as exc:
                    self.assertEqual({"error": str(exc)}, theirs)
                    continue
                self.assertNotIn("error", theirs, "the port refused a spec the CLI accepts")

                ours = render(spec)
                theirs_files = [tuple(entry) for entry in theirs["files"]]
                self.assertEqual([path for path, _ in ours], [path for path, _ in theirs_files])
                for (path, mine), (_, port) in zip(ours, theirs_files):
                    if mine != port:
                        diff = "".join(
                            difflib.unified_diff(
                                mine.splitlines(True),
                                port.splitlines(True),
                                "cli/" + path,
                                "site/" + path,
                            )
                        )
                        self.fail("{0} differs between the CLI and the site:\n{1}".format(path, diff))

                total = sum(len(body.encode("utf-8")) for _, body in ours)
                self.assertEqual(cli._kb(total), theirs["label"])
                self.assertEqual(spec.slug, theirs["slug"])

    def test_the_download_is_a_valid_zip_of_exactly_that_repository(self):
        for (text, source), theirs in zip(self.inputs, self.results):
            if "files" not in theirs:
                continue
            with self.subTest(source=source, spec=text[:80]):
                spec = parse(text, source)
                self.assertTrue(theirs["stable"], "the same spec downloaded different bytes twice")
                archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(theirs["zip"])))
                self.assertIsNone(archive.testzip(), "a member fails its CRC")
                root = spec.slug + "/"
                expected = [root] + [root + path for path, _ in render(spec)]
                expected += [root + name + "/" for name in DIRECTORIES]
                self.assertEqual(expected, archive.namelist())
                for path, body in render(spec):
                    self.assertEqual(body.encode("utf-8"), archive.read(root + path), path)

    def test_the_examples_on_the_page_are_the_ones_in_the_repo(self):
        page = PAGE.read_text(encoding="utf-8")
        for path in sorted((ROOT / "examples").glob("*.spec.md")):
            block = '<script type="text/plain" id="example-{0}" data-source="{1}">{2}</script>'.format(
                path.name.replace(".spec.md", ""), path.name, path.read_text(encoding="utf-8")
            )
            self.assertIn(block, page, "the page's copy of {0} has drifted".format(path.name))

    def test_the_refusals_on_the_page_are_what_the_cli_prints(self):
        import re

        page = PAGE.read_text(encoding="utf-8")
        blocks = re.findall(
            r'<script type="text/plain" id="refusal-\w+" data-source="([^"]+)">(.*?)</script>', page, re.S
        )
        shown = re.findall(r'<ul class="refusals">(.*?)</ul>', page, re.S)[0]
        messages = re.findall(r"<code>(degenerator: .*?)</code>", shown)
        self.assertEqual(len(blocks), len(messages))
        self.assertEqual(3, len(messages))
        for (source, text), message in zip(blocks, messages):
            with self.assertRaises(SpecError) as caught:
                parse(text, source)
            printed = "degenerator: " + str(caught.exception)
            self.assertEqual(printed, message.replace("&#39;", "'").replace("&amp;", "&"))

    def test_the_page_loads_the_generator_from_its_own_origin(self):
        page = PAGE.read_text(encoding="utf-8")
        self.assertIn('<script src="degenerator.js"', page)
        for chunk in page.split("<script")[1:]:
            tag = chunk.split(">", 1)[0]
            self.assertNotIn("//", tag, "a script loads from another host: " + tag)


if __name__ == "__main__":
    unittest.main()
