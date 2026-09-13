"""The paper desk refuses what the generated repository refuses.

docs/simulator.js carries a copy of the risk.py that degenerator writes, so the
site can be traded rather than read. A copy that disagrees with the real file
would teach visitors a cap the tool does not enforce, which is worse than
having no desk at all. So every decision is checked against the risk.py the CLI
actually writes, scaffolded into a temp directory and imported for the purpose.

The rest of the file checks the desk itself: the same seed replays exactly, a
stop-loss closes a position and says risk.py did it, the demo strategy never
sends a short to a spot chain, and the session export is marked synthetic.

Needs Node. Locally a missing node is a skip; in CI it is a failure.
"""

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from degenerator import scaffold
from degenerator.spec import parse

ROOT = Path(__file__).resolve().parents[1]
SIMULATOR = ROOT / "docs" / "simulator.js"

# Orders a desk can produce, plus a few no desk would: the port has to agree
# about those too, because the generated risk.py is what defines them.
ORDERS = [
    {"pair": "BTC", "side": "long", "notional": 150.0, "leverage": None},
    {"pair": "BTC", "side": "short", "notional": 150.0, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": 150.00000000000003, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": 149.99999999999997, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": 0.0, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": -1.0, "leverage": None},
    {"pair": "BTC", "side": "short", "notional": -1.0, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": 1e-09, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": 2.675, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": 1234.565, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": 1e20, "leverage": None},
    # 0.125 and 2.5 * 0.05 are exact halves at the second decimal, where
    # "{0:.2f}" rounds to even and toFixed() rounds up.
    {"pair": "BTC", "side": "long", "notional": 0.125, "leverage": None},
    {"pair": "BTC", "side": "long", "notional": 1.0, "leverage": [3, True]},
    {"pair": "BTC", "side": "long", "notional": 1.0, "leverage": [4, True]},
    {"pair": "BTC", "side": "long", "notional": 1.0, "leverage": [2.5, False]},
    {"pair": "BTC", "side": "long", "notional": 1.0, "leverage": [3.0, False]},
    {"pair": "BTC", "side": "long", "notional": 1.0, "leverage": [100, True]},
    {"pair": "BTC", "side": "short", "notional": 1.0, "leverage": [100, True]},
]

EQUITIES = [[1000, True], [1000.0, False], [0.0, False], [-5.0, False], [0.5, False],
            [2.5, False], [123.456, False], [1000000.0, False], [1e16, False]]

SPECS = [
    ("# Momentum Degen\n\nvenue: hyperliquid\npairs: BTC\nmax_position: 5%\n"
     "stop_loss: 3%\nleverage: 3x\ncash: 1000\n\nrules:\n- ape\n"),
    ("# Spot Degen\n\nvenue: robinhood\npairs: CASHCAT\nmax_position: 5%\n"
     "stop_loss: 10%\ncash: 500\n\nrules:\n- ape\n"),
    ("# Defaults\n\nrules:\n- ape\n"),
    ("# Odd Numbers\n\nvenue: dydx\nmax_position: 0.123456789\nstop_loss: 2.675%\n"
     "leverage: 2.5x\ncash: 1000000\n\nrules:\n- ape\n"),
    ("# Whole\n\nvenue: dydx\nmax_position: 2\nstop_loss: 1\nleverage: 1\ncash: 7\n\nrules:\n- ape\n"),
]

CHILD = """
import json, sys
sys.path.insert(0, 'src')
import risk

out = []
for order, equity in json.loads(sys.stdin.read()):
    order = dict(order)
    if order.get('leverage') is None:
        order.pop('leverage', None)
    else:
        value, whole = order['leverage']
        order['leverage'] = int(value) if whole else float(value)
    value, whole = equity
    equity = int(value) if whole else float(value)
    out.append({
        'check': risk.check(order, equity),
        'max_notional': risk.max_notional(equity),
        'stop_long': risk.stop_price(100.0, 'long'),
        'stop_short': risk.stop_price(100.0, 'short'),
    })
sys.stdout.write(json.dumps(out))
"""

DRIVER = r"""
const sim = require(process.argv[1]);
const gen = require(process.argv[2]);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  const out = {};

  if (job.risk) {
    out.risk = job.risk.map(([specText, pairs]) => {
      const spec = gen.parse(specText, "desk.spec.md");
      const risk = sim.Risk(spec);
      return pairs.map(([order, equity]) => {
        const o = Object.assign({}, order);
        o.leverage = order.leverage === null ? null : { v: order.leverage[0], int: order.leverage[1] };
        const e = equity[0];
        return {
          check: risk.check(o, e),
          max_notional: risk.maxNotional(e),
          stop_long: risk.stopPrice(100.0, "long"),
          stop_short: risk.stopPrice(100.0, "short"),
        };
      });
    });
  }

  if (job.prices) out.prices = job.prices.map((pair) => sim.placeholderPrice(pair));

  if (job.scripts) {
    out.scripts = job.scripts.map((script) => {
      const spec = gen.parse(script.spec, "desk.spec.md");
      const desk = sim.create(spec, { seed: script.seed, volatility: script.volatility });
      script.steps.forEach((step) => {
        if (step.tick) for (let i = 0; i < step.tick; i++) sim.tick(desk);
        if (step.submit) sim.submit(desk, step.submit);
        if (step.close) sim.close(desk, step.close, "you");
        if (step.shock) sim.shock(desk, step.shock[0], step.shock[1]);
        if (step.autopilot !== undefined) desk.autopilot = step.autopilot;
      });
      const parts = desk.cash + desk.realised +
        Object.keys(desk.positions).reduce((total, pair) => {
          const quote = desk.markets.filter((m) => m.pair === pair)[0];
          return total + sim.unrealised(desk.positions[pair], quote.price);
        }, 0);
      return { session: sim.session(desk), equity: sim.equity(desk), parts: parts, halted: desk.halted };
    });
  }

  process.stdout.write(JSON.stringify(out));
});
"""


def run_driver(job):
    done = subprocess.run(
        [shutil.which("node"), "-e", DRIVER, str(SIMULATOR), str(ROOT / "docs" / "degenerator.js")],
        input=json.dumps(job).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if done.returncode != 0:
        raise AssertionError("node failed:\n" + done.stderr.decode("utf-8", "replace"))
    return json.loads(done.stdout.decode("utf-8"))


class TestTheDeskRefusesWhatTheRepoRefuses(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("node") is None:
            if os.environ.get("CI"):
                raise AssertionError("node is required in CI: the desk parity test must run")
            raise unittest.SkipTest("node is not installed")
        cls.pairs = [(order, equity) for equity in EQUITIES for order in ORDERS]
        cls.result = run_driver({"risk": [[text, cls.pairs] for text in SPECS]})

    def test_every_decision_matches_the_generated_risk_module(self):
        import tempfile

        for text, theirs in zip(SPECS, self.result["risk"]):
            spec = parse(text, "desk.spec.md")
            tmp = Path(tempfile.mkdtemp(prefix="degenerator-desk-"))
            try:
                scaffold.write(spec, tmp / "bot", no_git=True)
                done = subprocess.run(
                    [__import__("sys").executable, "-c", CHILD],
                    cwd=str(tmp / "bot"),
                    input=json.dumps(self.pairs).encode("utf-8"),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                if done.returncode:
                    raise AssertionError(done.stderr.decode("utf-8", "replace"))
                ours = json.loads(done.stdout.decode("utf-8"))
            finally:
                shutil.rmtree(str(tmp), ignore_errors=True)

            self.assertEqual(len(ours), len(theirs))
            for (order, equity), mine, desk in zip(self.pairs, ours, theirs):
                with self.subTest(venue=spec.venue, order=order, equity=equity):
                    self.assertEqual(mine, desk)

    def test_the_desk_quotes_the_same_first_price_as_the_paper_adapter(self):
        import hashlib

        pairs = ["BTC", "SOL", "HYPE", "CASHCAT", "PONS", "ETH", "A", "", "РАКЕТА"]
        theirs = run_driver({"prices": pairs})["prices"]
        for pair, price in zip(pairs, theirs):
            digest = hashlib.sha256(pair.encode("utf-8")).digest()
            expected = round(10.0 + (int.from_bytes(digest[:4], "big") % 100000) / 100.0, 2)
            self.assertEqual(expected, price, pair)


class TestTheDeskItself(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("node") is None:
            if os.environ.get("CI"):
                raise AssertionError("node is required in CI: the desk tests must run")
            raise unittest.SkipTest("node is not installed")

    def test_the_same_seed_replays_exactly(self):
        script = {
            "spec": SPECS[0],
            "seed": 7,
            "steps": [{"tick": 40}, {"submit": {"pair": "BTC", "side": "long", "notional": 100.0}}, {"tick": 40}],
        }
        first, second = run_driver({"scripts": [script, dict(script)]})["scripts"]
        self.assertEqual(first, second)

    def test_a_different_seed_is_a_different_market(self):
        base = {"spec": SPECS[0], "seed": 7, "steps": [{"tick": 60}]}
        other = dict(base, seed=8)
        first, second = run_driver({"scripts": [base, other]})["scripts"]
        self.assertNotEqual(first["session"]["log"], second["session"]["log"] or [None])

    def test_a_stop_closes_the_position_and_risk_py_gets_the_credit(self):
        script = {
            "spec": SPECS[0],
            "seed": 3,
            "volatility": 0.0,
            "steps": [
                {"submit": {"pair": "BTC", "side": "long", "notional": 100.0}},
                {"shock": ["BTC", -0.2]},
                {"tick": 1},
            ],
        }
        result = run_driver({"scripts": [script]})["scripts"][0]
        stopped = [row for row in result["session"]["log"] if row["kind"] == "stopped"]
        self.assertEqual(1, len(stopped), result["session"]["log"])
        self.assertEqual("risk.py", stopped[0]["source"])
        self.assertIn("stop hit on BTC", stopped[0]["text"])
        self.assertEqual([], result["session"]["positions"])
        self.assertLess(float(result["session"]["realised"]), 0)

    def test_a_short_on_the_spot_chain_is_refused_in_the_desk_too(self):
        script = {
            "spec": SPECS[1],
            "seed": 1,
            "steps": [{"submit": {"pair": "CASHCAT", "side": "short", "notional": 1.0}}],
        }
        log = run_driver({"scripts": [script]})["scripts"][0]["session"]["log"]
        self.assertEqual(1, len(log))
        self.assertEqual("risk.py", log[0]["source"])
        self.assertEqual(
            "short refused: robinhood chain is spot only, there is nothing to borrow", log[0]["text"]
        )

    def test_the_demo_strategy_never_sends_a_short_to_a_spot_chain(self):
        script = {
            "spec": SPECS[1],
            "seed": 11,
            "steps": [{"autopilot": True}, {"tick": 400}],
        }
        log = run_driver({"scripts": [script]})["scripts"][0]["session"]["log"]
        self.assertTrue(log, "the demo strategy never traded, so this proves nothing")
        for row in log:
            self.assertNotIn("short", row["text"], row)

    def test_the_demo_strategy_does_trade_on_a_perps_venue(self):
        script = {"spec": SPECS[0], "seed": 11, "steps": [{"autopilot": True}, {"tick": 400}]}
        log = run_driver({"scripts": [script]})["scripts"][0]["session"]["log"]
        filled = [row for row in log if row["kind"] == "filled"]
        self.assertTrue(filled, "the demo strategy never opened anything")
        self.assertTrue(all(row["by"] == "autopilot" for row in filled))

    def test_equity_is_cash_plus_realised_plus_what_is_open(self):
        script = {
            "spec": SPECS[0],
            "seed": 5,
            "steps": [{"autopilot": True}, {"tick": 200}],
        }
        result = run_driver({"scripts": [script]})["scripts"][0]
        self.assertEqual(result["parts"], result["equity"])

    def test_the_session_says_it_is_synthetic(self):
        script = {"spec": SPECS[0], "seed": 2, "steps": [{"tick": 5}]}
        session = run_driver({"scripts": [script]})["scripts"][0]["session"]
        self.assertIs(True, session["synthetic"])
        self.assertIn("no money", session["note"])
        self.assertEqual("Momentum Degen", session["spec"]["title"])


if __name__ == "__main__":
    unittest.main()
