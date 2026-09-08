"""The spec language and its errors.

A spec is a title, ``key: value`` lines, and a ``rules:`` list. That is the
whole language. Every refusal in this module is one line a human can read.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Union

Number = Union[int, float]

VENUES = ("hyperliquid", "dydx", "robinhood", "paper")

#: Spot venues have no leverage to give. Naming them here keeps the refusal
#: below honest about why it fires.
SPOT_ONLY = ("robinhood",)

#: The documented defaults. Templates read them from here, so a generated
#: README cannot claim a default the parser does not actually apply.
DEFAULTS: Dict[str, object] = {
    "venue": "paper",
    "pairs": ["BTC"],
    "timeframe": "5m",
    "max_position": 0.05,
    "stop_loss": 0.03,
    "leverage": 1,
    "cash": 1000,
}

#: parse() can be handed text that still carries one; parse_file() decodes it away.
BOM = "\ufeff"

KNOWN_KEYS = tuple(DEFAULTS)
NUMERIC_KEYS = ("max_position", "stop_loss", "leverage", "cash")


class SpecError(Exception):
    """A refusal the user can read without a traceback."""


@dataclass
class Spec:
    """One parsed spec. Nothing here was invented by the generator."""

    title: str
    slug: str
    venue: str
    pairs: List[str]
    timeframe: str
    max_position: Number
    stop_loss: Number
    leverage: Number
    cash: Number
    rules: List[str]
    source: str
    extras: Dict[str, str] = field(default_factory=dict)
    provenance: Dict[str, str] = field(default_factory=dict)
    raw: Dict[str, str] = field(default_factory=dict)

    @property
    def risk(self) -> Dict[str, Number]:
        """The three caps that end up in ``risk.py`` and in the receipt."""
        return {
            "max_position": self.max_position,
            "stop_loss": self.stop_loss,
            "leverage": self.leverage,
        }

    @property
    def filename(self) -> str:
        """Just the spec's file name.

        Generated files get this rather than ``source``: an absolute path
        carries the user's home directory, and a generated repo is meant to be
        pushed. The full path stays in the receipt, which does not travel.
        """
        return Path(self.source).name

    def origin(self, key: str) -> str:
        """Where a value came from, phrased for a generated comment."""
        if self.provenance.get(key) == "spec":
            return "spec: {0}: {1}".format(key, self.raw[key])
        return "default: {0!r} (no {1} in the spec)".format(DEFAULTS[key], key)


def slugify(title: str) -> str:
    """``"Momentum Degen"`` -> ``"momentum-degen"``."""
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "degen-bot"


def parse_file(path: Union[str, Path]) -> Spec:
    """Read a spec file and parse it.

    The path is kept as the user typed it, with separators normalised: it ends
    up quoted inside generated files, and a Windows backslash there would read
    as an escape sequence.
    """
    try:
        # utf-8-sig: Notepad and PowerShell both save specs with a BOM, and a
        # BOM on the title line would otherwise read as a syntax error.
        text = Path(path).read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise SpecError("cannot read spec {0}: {1}".format(path, exc.strerror or exc))
    return parse(text, source=str(path).replace("\\", "/"))


def parse(text: str, source: str = "<spec>") -> Spec:
    """Parse spec text into a :class:`Spec`, or refuse with a one-line error."""
    title = None
    values: Dict[str, str] = {}
    extras: Dict[str, str] = {}
    lines: Dict[str, int] = {}
    rules: List[str] = []
    in_rules = False

    for lineno, raw_line in enumerate(text.lstrip(BOM).splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            if title is None:
                title = line.lstrip("#").strip()
                if not title:
                    raise SpecError(
                        "{0}:{1}: the title line is empty: write '# My Bot'".format(
                            source, lineno
                        )
                    )
            continue
        if line.startswith("-"):
            if not in_rules:
                raise SpecError(
                    "{0}:{1}: rule outside a 'rules:' block: {2!r}".format(
                        source, lineno, line
                    )
                )
            rule = line[1:].strip()
            if rule:
                rules.append(rule)
            continue
        if ":" not in line:
            raise SpecError(
                "{0}:{1}: expected 'key: value' or '- rule', got {2!r}".format(
                    source, lineno, line
                )
            )
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key == "rules":
            in_rules = True
            if value:  # `rules: fade the wick` — take it as the first rule
                rules.append(value)
            continue
        in_rules = False
        lines[key] = lineno
        if key in KNOWN_KEYS:
            values[key] = value
        else:  # unknown keys are kept, never an error
            extras[key] = value

    if title is None:
        raise SpecError("{0}: no title line: start the spec with '# My Bot'".format(source))
    if not rules:
        raise SpecError(
            "{0}: no rules: a bot with no rules is a random number generator".format(source)
        )

    provenance = {key: ("spec" if key in values else "default") for key in KNOWN_KEYS}
    raw = {key: values[key] for key in values}

    venue = values.get("venue", DEFAULTS["venue"]).strip().lower()
    if venue not in VENUES:
        raise SpecError(
            "{0}: unknown venue {1!r}: choose one of {2}".format(
                source, venue, ", ".join(VENUES)
            )
        )

    if "pairs" in values:
        pairs = [p.strip().upper() for p in values["pairs"].split(",") if p.strip()]
        if not pairs:
            raise SpecError(
                "{0}:{1}: pairs is empty: list at least one, e.g. 'pairs: BTC'".format(
                    source, lines["pairs"]
                )
            )
    else:
        pairs = list(DEFAULTS["pairs"])

    numbers = {}
    for key in NUMERIC_KEYS:
        if key in values:
            numbers[key] = _number(key, values[key], source, lines[key])
        else:
            numbers[key] = DEFAULTS[key]

    if venue in SPOT_ONLY and numbers["leverage"] != 1:
        # Point at the leverage line, not the venue line: that is the line the
        # user has to delete. It is always in `lines` when this fires — without
        # a leverage line the value comes from DEFAULTS and is 1.
        raise SpecError(
            "{0}:{1}: leverage {2} with venue {3!r}: {3} chain is spot "
            "only, drop the leverage line".format(
                source, lines["leverage"], numbers["leverage"], venue
            )
        )

    title_text = title
    return Spec(
        title=title_text,
        slug=slugify(title_text),
        venue=venue,
        pairs=pairs,
        timeframe=values.get("timeframe", DEFAULTS["timeframe"]),
        rules=rules,
        source=source,
        extras=extras,
        provenance=provenance,
        raw=raw,
        **numbers
    )


def _number(key: str, text: str, source: str, lineno: int) -> Number:
    """``5%`` -> ``0.05``, ``3x`` -> ``3``, anything else -> a refusal."""
    body = text.strip()
    scale = 1.0
    if body.endswith("%"):
        body = body[:-1].strip()
        scale = 0.01
    elif key == "leverage" and body[-1:] in ("x", "X"):
        body = body[:-1].strip()
    try:
        value = float(body) * scale
    except ValueError:
        raise SpecError(
            "{0}:{1}: {2} is not a number: {3!r}".format(source, lineno, key, text)
        )
    if value <= 0:
        raise SpecError(
            "{0}:{1}: {2} must be positive, got {3!r}".format(source, lineno, key, text)
        )
    return _tidy(value)


def _tidy(value: float) -> Number:
    """Keep whole numbers whole: ``3.0`` prints as ``3`` in code and JSON."""
    if value == int(value):
        return int(value)
    return round(value, 10)
