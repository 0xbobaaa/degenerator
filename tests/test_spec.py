"""Parsing, defaults, % and x suffixes, refusals."""

import unittest

from degenerator.spec import DEFAULTS, Spec, SpecError, parse, slugify

FULL = """\
# Momentum Degen

venue: hyperliquid
pairs: BTC, SOL, HYPE
timeframe: 5m
max_position: 5%
stop_loss: 3%
leverage: 3x
cash: 1000

rules:
- long when the 20 period average crosses above the 50
- close anything down 3%
- flat before funding
"""

MINIMAL = """\
# Bare Bot

rules:
- buy the dip
"""


class TestParsing(unittest.TestCase):
    def test_reads_every_key(self):
        spec = parse(FULL, "momentum.spec.md")
        self.assertEqual(spec.title, "Momentum Degen")
        self.assertEqual(spec.slug, "momentum-degen")
        self.assertEqual(spec.venue, "hyperliquid")
        self.assertEqual(spec.pairs, ["BTC", "SOL", "HYPE"])
        self.assertEqual(spec.timeframe, "5m")
        self.assertEqual(spec.source, "momentum.spec.md")

    def test_percent_divides_by_a_hundred(self):
        spec = parse(FULL)
        self.assertAlmostEqual(spec.max_position, 0.05)
        self.assertAlmostEqual(spec.stop_loss, 0.03)

    def test_x_suffix_is_stripped(self):
        self.assertEqual(parse(FULL).leverage, 3)
        self.assertEqual(parse(MINIMAL.replace("rules:", "leverage: 5\n\nrules:")).leverage, 5)

    def test_whole_numbers_stay_whole(self):
        spec = parse(FULL)
        self.assertIsInstance(spec.leverage, int)
        self.assertIsInstance(spec.cash, int)

    def test_rules_are_verbatim(self):
        self.assertEqual(
            parse(FULL).rules,
            [
                "long when the 20 period average crosses above the 50",
                "close anything down 3%",
                "flat before funding",
            ],
        )

    def test_pairs_are_uppercased_and_trimmed(self):
        spec = parse(MINIMAL.replace("rules:", "pairs:  btc , eth\n\nrules:"))
        self.assertEqual(spec.pairs, ["BTC", "ETH"])


class TestDefaults(unittest.TestCase):
    def test_a_minimal_spec_gets_every_default(self):
        spec = parse(MINIMAL)
        self.assertEqual(spec.venue, DEFAULTS["venue"])
        self.assertEqual(spec.pairs, DEFAULTS["pairs"])
        self.assertEqual(spec.timeframe, DEFAULTS["timeframe"])
        self.assertEqual(spec.max_position, DEFAULTS["max_position"])
        self.assertEqual(spec.stop_loss, DEFAULTS["stop_loss"])
        self.assertEqual(spec.leverage, DEFAULTS["leverage"])
        self.assertEqual(spec.cash, DEFAULTS["cash"])

    def test_provenance_says_where_each_number_came_from(self):
        spec = parse(MINIMAL)
        self.assertEqual(spec.provenance["max_position"], "default")
        self.assertIn("default", spec.origin("max_position"))
        full = parse(FULL)
        self.assertEqual(full.provenance["max_position"], "spec")
        self.assertEqual(full.origin("max_position"), "spec: max_position: 5%")

    def test_defaults_are_not_mutated_by_a_parse(self):
        parse(MINIMAL).pairs.append("DOGE")
        self.assertEqual(DEFAULTS["pairs"], ["BTC"])


class TestUnknownKeys(unittest.TestCase):
    def test_unknown_keys_are_kept_not_refused(self):
        spec = parse(MINIMAL.replace("rules:", "author: bob\nnotes: paper only\n\nrules:"))
        self.assertEqual(spec.extras, {"author": "bob", "notes": "paper only"})

    def test_unknown_keys_stay_out_of_the_known_ones(self):
        spec = parse(MINIMAL.replace("rules:", "author: bob\n\nrules:"))
        self.assertNotIn("author", spec.provenance)


class TestRefusals(unittest.TestCase):
    def assertRefusal(self, text, needle):
        with self.assertRaises(SpecError) as caught:
            parse(text, "bad.spec.md")
        message = str(caught.exception)
        self.assertIn(needle, message)
        self.assertNotIn("\n", message)  # one readable line, always

    def test_no_rules(self):
        self.assertRefusal("# No Rules\n\nvenue: paper\n", "random number generator")

    def test_empty_rules_block(self):
        self.assertRefusal("# No Rules\n\nrules:\n", "random number generator")

    def test_unknown_venue_lists_the_valid_ones(self):
        with self.assertRaises(SpecError) as caught:
            parse("# Bot\n\nvenue: binance\n\nrules:\n- ape\n")
        message = str(caught.exception)
        self.assertIn("binance", message)
        for venue in ("hyperliquid", "dydx", "paper"):
            self.assertIn(venue, message)

    def test_no_title(self):
        self.assertRefusal("venue: paper\n\nrules:\n- ape\n", "no title line")

    def test_number_that_is_not_a_number(self):
        self.assertRefusal("# Bot\n\ncash: lots\n\nrules:\n- ape\n", "not a number")

    def test_negative_number(self):
        self.assertRefusal("# Bot\n\nstop_loss: -3%\n\nrules:\n- ape\n", "must be positive")

    def test_rule_outside_a_rules_block(self):
        self.assertRefusal("# Bot\n\n- ape\n\nrules:\n- ape\n", "outside a 'rules:' block")

    def test_a_byte_order_mark_is_not_a_syntax_error(self):
        # Notepad and PowerShell both save UTF-8 with a BOM.
        spec = parse("\ufeff" + FULL)
        self.assertEqual(spec.title, "Momentum Degen")

    def test_line_that_is_neither_key_nor_rule(self):
        self.assertRefusal("# Bot\n\nnonsense\n\nrules:\n- ape\n", "expected 'key: value'")


class TestSlugify(unittest.TestCase):
    def test_slugs(self):
        self.assertEqual(slugify("Momentum Degen"), "momentum-degen")
        self.assertEqual(slugify("  Mean/Revert v2!  "), "mean-revert-v2")
        self.assertEqual(slugify("!!!"), "degen-bot")


class TestRiskView(unittest.TestCase):
    def test_risk_is_the_three_caps(self):
        self.assertEqual(
            parse(FULL).risk,
            {"max_position": 0.05, "stop_loss": 0.03, "leverage": 3},
        )

    def test_spec_is_a_plain_dataclass(self):
        self.assertIsInstance(parse(MINIMAL), Spec)


if __name__ == "__main__":
    unittest.main()
