/*
 * degenerator, in the browser.
 *
 * A port of degenerator/spec.py and degenerator/templates.py, laid out so the
 * two read side by side. It lets the site run the generator rather than
 * describe it: paste a spec, get the repository, download it as a zip.
 *
 * A port is only worth having if it is exact. tests/test_site_generator.py
 * feeds the same specs to this file and to the Python package and fails on a
 * single byte of difference in any generated file or refusal message, then
 * unpacks the zip with Python's zipfile and checks every member against the
 * CLI's output. Change a template in one place and not the other, and CI says so.
 *
 * No dependencies and no network, like everything else in this repository.
 * It runs as a plain <script> in a browser and as a CommonJS module in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Degenerator = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // --- just enough Python -------------------------------------------------
  // The parser leans on str.strip(), str.splitlines(), float(), repr() and
  // round(). Each has corners where the nearest JavaScript disagrees, and
  // every disagreement would be a different byte in a generated file.

  // str.isspace(). String.prototype.trim() misses U+001C..U+001F and U+0085,
  // and strips U+FEFF, which Python does not count as space.
  function isSpace(c) {
    return (
      (c >= 0x09 && c <= 0x0d) ||
      (c >= 0x1c && c <= 0x20) ||
      c === 0x85 ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000
    );
  }

  function strip(s) {
    let a = 0;
    let b = s.length;
    while (a < b && isSpace(s.charCodeAt(a))) a++;
    while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
    return s.slice(a, b);
  }

  // str.splitlines(): more breaks than \n, and no empty item after the last.
  function isBreak(c) {
    return (
      c === 0x0a ||
      c === 0x0b ||
      c === 0x0c ||
      c === 0x1c ||
      c === 0x1d ||
      c === 0x1e ||
      c === 0x85 ||
      c === 0x2028 ||
      c === 0x2029
    );
  }

  function splitlines(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x0d) {
        out.push(text.slice(start, i));
        if (text.charCodeAt(i + 1) === 0x0a) i++;
        start = i + 1;
      } else if (isBreak(c)) {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    if (start < text.length) out.push(text.slice(start));
    return out;
  }

  // float() reads any Unicode decimal digit, not just 0-9. Unicode encodes
  // decimal digits in runs of ten that start at zero, so a digit's value is
  // its distance from the start of its run, modulo ten.
  const DECIMAL = /\p{Nd}/u;

  function asciiDigits(s) {
    return s.replace(/\p{Nd}/gu, function (ch) {
      let cp = ch.codePointAt(0);
      if (cp <= 0x39) return ch;
      let run = 0;
      while (DECIMAL.test(String.fromCodePoint(cp - 1))) {
        cp--;
        run++;
      }
      return String(run % 10);
    });
  }

  // float() without "inf" and "nan": the parser refuses those anyway, with
  // the same message it gives for anything else that is not a number.
  const FLOAT =
    /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;

  function pyFloat(body) {
    const digits = asciiDigits(body);
    return FLOAT.test(digits) ? Number(digits.replace(/_/g, "")) : NaN;
  }

  // repr(str): Python picks its quote and escapes what it will not print.
  // "Will not print" follows each runtime's Unicode version, so a code point
  // assigned in one version and not in the other can still come out differently.
  const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
  const hex = (n, width) => n.toString(16).padStart(width, "0");

  function reprStr(s) {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (ch === quote || ch === "\\") out += "\\" + ch;
      else if (ch === "\t") out += "\\t";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (cp < 0x20 || cp === 0x7f) out += "\\x" + hex(cp, 2);
      else if (cp < 0x7f) out += ch;
      else if (NOT_PRINTABLE.test(ch)) {
        out += cp < 0x100 ? "\\x" + hex(cp, 2) : cp < 0x10000 ? "\\u" + hex(cp, 4) : "\\U" + hex(cp, 8);
      } else out += ch;
    }
    return out + quote;
  }

  // repr(float): String() already finds the shortest digits that round-trip;
  // Python only lays them out differently. Exponent below 1e-4 or from 1e16,
  // at least two exponent digits, and ".0" on a whole value.
  function reprFloat(x) {
    if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
    const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(x)));
    let digits = m[1] + (m[2] || "");
    let decpt = m[1].length + (m[3] ? parseInt(m[3], 10) : 0);
    const lead = digits.length - digits.replace(/^0+/, "").length;
    digits = digits.slice(lead).replace(/0+$/, "");
    decpt -= lead;
    let body;
    if (decpt <= -4 || decpt > 16) {
      const exp = decpt - 1;
      body =
        digits[0] +
        (digits.length > 1 ? "." + digits.slice(1) : "") +
        "e" +
        (exp < 0 ? "-" : "+") +
        String(Math.abs(exp)).padStart(2, "0");
    } else if (decpt <= 0) {
      body = "0." + "0".repeat(-decpt) + digits;
    } else if (decpt >= digits.length) {
      body = digits + "0".repeat(decpt - digits.length) + ".0";
    } else {
      body = digits.slice(0, decpt) + "." + digits.slice(decpt);
    }
    return (x < 0 ? "-" : "") + body;
  }

  // round(x, n) as CPython does it: on the exact binary value, halves to even.
  // toFixed() sends halves up, and some halves are exactly representable.
  function roundTo(x, ndigits) {
    if (!isFinite(x) || x === 0) return x;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, Math.abs(x));
    const hi = view.getUint32(0);
    const lo = view.getUint32(4);
    const biased = (hi >>> 20) & 0x7ff;
    let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let exp;
    if (biased === 0) {
      exp = -1074;
    } else {
      mantissa |= 1n << 52n;
      exp = biased - 1075;
    }
    if (exp >= 0) return x; // already a whole number
    const numerator = mantissa * 10n ** BigInt(ndigits);
    const denominator = 1n << BigInt(-exp);
    let q = numerator / denominator;
    const twice = (numerator % denominator) * 2n;
    if (twice > denominator || (twice === denominator && q % 2n === 1n)) q += 1n;
    const result = Number(q.toString() + "e-" + ndigits);
    return x < 0 ? -result : result;
  }

  // Python keeps int and float apart and generated source shows it:
  // `LEVERAGE = 3`, never `3.0`. A number here carries which one it is.
  const int = (v) => ({ v: v, int: true });
  const float = (v) => ({ v: v, int: false });
  const intStr = (v) => BigInt(v).toString();
  const numStr = (n) => (n.int ? intStr(n.v) : reprFloat(n.v));

  // --- the spec language: degenerator/spec.py -----------------------------

  const VENUES = ["hyperliquid", "dydx", "robinhood", "paper"];
  const SPOT_ONLY = ["robinhood"];
  const KNOWN_KEYS = ["venue", "pairs", "timeframe", "max_position", "stop_loss", "leverage", "cash"];
  const NUMERIC_KEYS = ["max_position", "stop_loss", "leverage", "cash"];

  const DEFAULTS = {
    venue: "paper",
    pairs: ["BTC"],
    timeframe: "5m",
    max_position: float(0.05),
    stop_loss: float(0.03),
    leverage: int(1),
    cash: int(1000),
  };

  class SpecError extends Error {
    constructor(message) {
      super(message);
      this.name = "SpecError";
    }
  }

  function slugify(title) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "degen-bot";
  }

  const filename = (source) => source.replace(/\/+$/, "").split("/").pop();

  const tidy = (value) => (Number.isInteger(value) ? int(value) : float(roundTo(value, 10)));

  function number(key, text, source, lineno) {
    let body = strip(text);
    let scale = 1.0;
    if (body.endsWith("%")) {
      body = strip(body.slice(0, -1));
      scale = 0.01;
    } else if (key === "leverage" && (body.endsWith("x") || body.endsWith("X"))) {
      body = strip(body.slice(0, -1));
    }
    const value = pyFloat(body) * scale;
    if (!isFinite(value)) {
      throw new SpecError(source + ":" + lineno + ": " + key + " is not a number: " + reprStr(text));
    }
    if (value <= 0) {
      throw new SpecError(source + ":" + lineno + ": " + key + " must be positive, got " + reprStr(text));
    }
    return tidy(value);
  }

  function parse(text, source) {
    if (source === undefined) source = "<spec>";
    let title = null;
    const values = new Map();
    const extras = new Map();
    const lines = new Map();
    const rules = [];
    let inRules = false;

    let start = 0;
    while (text.charCodeAt(start) === 0xfeff) start++;
    const rows = splitlines(text.slice(start));

    for (let i = 0; i < rows.length; i++) {
      const lineno = i + 1;
      const line = strip(rows[i]);
      if (!line) continue;
      if (line.startsWith("#")) {
        if (title === null) {
          title = strip(line.replace(/^#+/, ""));
          if (!title) {
            throw new SpecError(source + ":" + lineno + ": the title line is empty: write '# My Bot'");
          }
        }
        continue;
      }
      if (line.startsWith("-")) {
        if (!inRules) {
          throw new SpecError(source + ":" + lineno + ": rule outside a 'rules:' block: " + reprStr(line));
        }
        const rule = strip(line.slice(1));
        if (rule) rules.push(rule);
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === -1) {
        throw new SpecError(
          source + ":" + lineno + ": expected 'key: value' or '- rule', got " + reprStr(line)
        );
      }
      const key = strip(line.slice(0, colon)).toLowerCase();
      const value = strip(line.slice(colon + 1));
      if (key === "rules") {
        inRules = true;
        if (value) rules.push(value); // `rules: fade the wick` is the first rule
        continue;
      }
      inRules = false;
      lines.set(key, lineno);
      if (KNOWN_KEYS.includes(key)) values.set(key, value);
      else extras.set(key, value); // unknown keys are kept, never an error
    }

    if (title === null) {
      throw new SpecError(source + ": no title line: start the spec with '# My Bot'");
    }
    if (!rules.length) {
      throw new SpecError(source + ": no rules: a bot with no rules is a random number generator");
    }

    const provenance = {};
    for (const key of KNOWN_KEYS) provenance[key] = values.has(key) ? "spec" : "default";
    const raw = {};
    for (const [key, value] of values) raw[key] = value;

    const venue = strip(values.has("venue") ? values.get("venue") : DEFAULTS.venue).toLowerCase();
    if (!VENUES.includes(venue)) {
      throw new SpecError(
        source + ": unknown venue " + reprStr(venue) + ": choose one of " + VENUES.join(", ")
      );
    }

    let pairs;
    if (values.has("pairs")) {
      pairs = values
        .get("pairs")
        .split(",")
        .filter((p) => strip(p))
        .map((p) => strip(p).toUpperCase());
      if (!pairs.length) {
        throw new SpecError(
          source + ":" + lines.get("pairs") + ": pairs is empty: list at least one, e.g. 'pairs: BTC'"
        );
      }
    } else {
      pairs = DEFAULTS.pairs.slice();
    }

    const numbers = {};
    for (const key of NUMERIC_KEYS) {
      numbers[key] = values.has(key) ? number(key, values.get(key), source, lines.get(key)) : DEFAULTS[key];
    }

    if (SPOT_ONLY.includes(venue) && numbers.leverage.v !== 1) {
      // Point at the leverage line, not the venue line: that is the one to delete.
      throw new SpecError(
        source + ":" + lines.get("leverage") + ": leverage " + numStr(numbers.leverage) +
          " with venue " + reprStr(venue) + ": " + venue + " chain is spot only, drop the leverage line"
      );
    }

    return {
      title: title,
      slug: slugify(title),
      venue: venue,
      pairs: pairs,
      timeframe: values.has("timeframe") ? values.get("timeframe") : DEFAULTS.timeframe,
      max_position: numbers.max_position,
      stop_loss: numbers.stop_loss,
      leverage: numbers.leverage,
      cash: numbers.cash,
      rules: rules,
      source: source,
      extras: extras,
      provenance: provenance,
      raw: raw,
    };
  }

  function origin(spec, key) {
    if (spec.provenance[key] === "spec") return "spec: " + key + ": " + spec.raw[key];
    return "default: " + numStr(DEFAULTS[key]) + " (no " + key + " in the spec)";
  }

  // --- the generated files: degenerator/templates.py ----------------------

  const TAB = "\t";

  const num = (n) => (n.int ? intStr(n.v) : reprFloat(roundTo(n.v, 10)));

  function pct(n) {
    if (n.int) return (BigInt(n.v) * 100n).toString() + "%";
    const scaled = n.v * 100;
    if (Number.isInteger(scaled)) return intStr(scaled) + "%";
    return reprFloat(roundTo(scaled, 6)) + "%";
  }

  // Free text embedded in generated Python may not close a string, start an
  // escape, or reach a new line. Values that must survive verbatim use repr.
  const docsafe = (text) =>
    text.replace(/\\/g, "/").replace(/"/g, "'").replace(/\r/g, " ").replace(/\n/g, " ");

  const className = (venue) => venue.charAt(0).toUpperCase() + venue.slice(1).toLowerCase() + "Venue";
  const listLiteral = (items) => "[" + items.map(reprStr).join(", ") + "]";
  const block = (rows) => rows.join("\n") + "\n";

  // No entry here may name a private key, a mnemonic, or a seed.
  const CREDENTIALS = {
    hyperliquid: [[], ["HYPERLIQUID_ACCOUNT_ADDRESS", "HYPERLIQUID_API_SECRET"]],
    dydx: [[], ["DYDX_ACCOUNT_ADDRESS", "DYDX_API_KEY", "DYDX_API_SECRET", "DYDX_API_PASSPHRASE"]],
    robinhood: [
      [
        "Reading robinhood chain needs an RPC endpoint and nothing else.",
        "Signing is deliberately not part of this repo: a key does not",
        "belong in a file like this one, and a generated repo has no",
        "business teaching you otherwise.",
      ],
      ["ROBINHOOD_RPC_URL"],
    ],
    paper: [[], []],
  };

  function readme(spec) {
    const caps = [
      ["max_position", pct(spec.max_position) + " of equity"],
      ["stop_loss", pct(spec.stop_loss) + " per position"],
      ["leverage", num(spec.leverage) + "x"],
      ["cash", num(spec.cash) + " starting paper equity"],
    ];
    const out = [
      "# " + spec.title,
      "",
      "Generated by degenerator from `" + filename(spec.source) + "`.",
      "",
      "## What it trades",
      "",
      "- venue: `" + spec.venue + "` — paper-mode adapter, no network, no money",
      "- pairs: " + spec.pairs.map((pair) => "`" + pair + "`").join(", "),
      "- timeframe: `" + spec.timeframe + "`",
    ];
    if (SPOT_ONLY.includes(spec.venue)) {
      out.push(
        "- " + spec.venue + " chain is spot only: there is no leverage to ask for, and the " +
          "generated adapter models swaps against a pool rather than order book fills."
      );
    }
    out.push(
      "",
      "## The caps",
      "",
      "Every number below traces back to a line in the spec or to a documented",
      "default. `src/risk.py` is the only file allowed to say no, and",
      "`tests/test_risk.py` asserts these exact numbers.",
      "",
      "| cap | value | where it came from |",
      "| --- | --- | --- |"
    );
    for (const [key, shown] of caps) {
      out.push("| `" + key + "` | " + shown + " | `" + origin(spec, key) + "` |");
    }
    out.push(
      "",
      "## Rules, copied from the spec",
      "",
      "Verbatim. They live in `src/strategy.py` as comments — degenerator does",
      "not turn English into code, so writing the logic is your job.",
      ""
    );
    for (const rule of spec.rules) out.push("- " + rule);
    if (spec.extras.size) {
      out.push(
        "",
        "## Other keys from the spec",
        "",
        "Kept as written, unused by the generated code. Nothing a human wrote",
        "is dropped on the floor.",
        ""
      );
      for (const [key, value] of spec.extras) out.push("- `" + key + "`: " + value);
    }
    out.push(
      "",
      "## Run it",
      "",
      "```",
      "cp .env.example .env",
      "make test",
      "make run",
      "```",
      "",
      "`make image` builds the container; `compose.yml` mounts `runs/` so the",
      "run records survive the container.",
      "",
      "## Safety",
      "",
      "The venue adapter is a paper-mode stub: placeholder prices and fake fills,",
      "so the loop runs end to end without touching an exchange. It refuses to",
      "construct with `live=True`. The live order path is deliberately left to you",
      "to implement and review.",
      "",
      "The caps above are applied, not judged: degenerator copies what the spec",
      "said and never second-guesses it, so nothing capped `leverage` at",
      num(spec.leverage) + "x. Paper mode means nothing is at risk here — the number is yours to",
      "sanity-check before this goes anywhere near an exchange.",
      "",
      "Nothing here is financial advice."
    );
    return block(out);
  }

  function envExample(spec) {
    const out = [
      "# Copy to .env, then fill it in. .env is gitignored; keys never go in git.",
      "# The generated adapter is paper-mode and reads none of these — they are",
      "# here for the live path you write yourself.",
      "",
      "LIVE=false",
      "",
    ];
    const note = CREDENTIALS[spec.venue][0];
    const keys = CREDENTIALS[spec.venue][1];
    if (keys.length) {
      out.push("# " + spec.venue);
      for (const line of note) out.push("# " + line);
      for (const key of keys) out.push(key + "=");
    } else {
      out.push("# the paper venue needs no credentials at all.");
    }
    return block(out);
  }

  const gitignore = () =>
    block([
      ".env",
      "__pycache__/",
      "*.py[cod]",
      ".venv/",
      "",
      "# run records are written by the bot, never edited by hand",
      "runs/*.json",
      "runs/*.log",
    ]);

  const requirements = () =>
    block([
      "# Intentionally empty.",
      "#",
      "# This bot runs on the Python standard library alone: nothing to pin,",
      "# nothing to audit, nothing to wake up broken. If you add a dependency,",
      "# you own it.",
    ]);

  const makefile = (spec) =>
    block([
      ".PHONY: run test image",
      "",
      "run:",
      TAB + "python src/main.py",
      "",
      "test:",
      TAB + "python -m unittest discover -s tests -q",
      "",
      "image:",
      TAB + "docker build -t " + spec.slug + " .",
    ]);

  const dockerfile = () =>
    block([
      "# Multi-stage, though there is nothing to compile: the build stage only",
      "# proves the sources import cleanly before they reach the runtime image.",
      "FROM python:3.12-slim AS build",
      "WORKDIR /app",
      "COPY . .",
      "RUN python -m compileall -q src tests",
      "",
      "FROM python:3.12-slim AS runtime",
      "WORKDIR /app",
      "ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1",
      "COPY --from=build /app /app",
      "RUN useradd --create-home --uid 10001 bot && chown -R bot:bot /app",
      "USER bot",
      'CMD ["python", "src/main.py"]',
    ]);

  const compose = (spec) =>
    block([
      "services:",
      "  bot:",
      "    build: .",
      "    image: " + spec.slug,
      "    env_file: .env",
      "    volumes:",
      "      # run records outlive the container",
      "      - ./runs:/app/runs",
      '    restart: "no"',
    ]);

  const ci = (spec) =>
    block([
      "name: ci",
      "",
      "on:",
      "  push:",
      "  pull_request:",
      "",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-python@v5",
      "        with:",
      '          python-version: "3.12"',
      "      - name: unittest",
      "        run: python -m unittest discover -s tests -q",
      "",
      "  image:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - name: docker build",
      "        run: docker build -t " + spec.slug + " .",
    ]);

  const risk = (spec) =>
    block([
      '"""The only file allowed to say no.',
      "",
      "Every number here traces back to a line in the spec or to a documented",
      "default — the comment above each one says which. Nothing else in this",
      "repo may raise a cap; everything else asks this module first.",
      '"""',
      "",
      "# " + origin(spec, "max_position"),
      "MAX_POSITION = " + num(spec.max_position),
      "",
      "# " + origin(spec, "stop_loss"),
      "STOP_LOSS = " + num(spec.stop_loss),
      "",
      "# " + origin(spec, "leverage"),
      "LEVERAGE = " + num(spec.leverage),
      "",
      "# " + origin(spec, "cash"),
      "CASH = " + num(spec.cash),
      "",
      "",
      "def max_notional(equity):",
      '    """The largest notional one position may carry, caps included."""',
      "    return equity * MAX_POSITION * LEVERAGE",
      "",
      "",
      "def stop_price(entry, side):",
      "    \"\"\"Where a position gets cut, per the spec's stop_loss.\"\"\"",
      '    if side == "long":',
      "        return entry * (1.0 - STOP_LOSS)",
      '    if side == "short":',
      "        return entry * (1.0 + STOP_LOSS)",
      "    raise ValueError(\"side must be 'long' or 'short', got {0!r}\".format(side))",
      "",
      "",
      "def check(order, equity):",
      '    """Return a refusal string, or None when the order is allowed."""',
      '    notional = order["notional"]',
      "    if notional <= 0:",
      '        return "notional must be positive, got {0}".format(notional)',
      "    cap = max_notional(equity)",
      "    if notional > cap:",
      '        return "notional {0:.2f} over the cap {1:.2f} (max_position {2}, leverage {3})".format(',
      "            notional, cap, MAX_POSITION, LEVERAGE",
      "        )",
      '    if order.get("leverage", LEVERAGE) > LEVERAGE:',
      '        return "leverage {0} over the cap {1}".format(order["leverage"], LEVERAGE)',
      "    return None",
    ]);

  function strategy(spec) {
    const out = [
      '"""Signals in, orders out.',
      "",
      "The rules below are copied verbatim from the spec. degenerator does not",
      "turn English into code on purpose: you write the logic, you own the trades.",
      '"""',
      "",
      "PAIRS = " + listLiteral(spec.pairs),
      "TIMEFRAME = " + reprStr(spec.timeframe),
      "",
      "# --- rules from the spec, verbatim ---------------------------------",
    ];
    for (const rule of spec.rules) out.push("# " + rule);
    out.push(
      "# -------------------------------------------------------------------",
      "",
      "",
      "def decide(pair, price, position=None):",
      '    """Return an intent dict like {"side": "long"}, or None to stand still.',
      "",
      "    Placeholder: it stands still. Implement the rules above here, on the",
      "    " + docsafe(spec.timeframe) + " timeframe, and size the result through risk.py.",
      '    """',
      "    return None"
    );
    return block(out);
  }

  const venueBase = () =>
    block([
      '"""The interface every venue answers.',
      "",
      "Paper mode only. Constructing an adapter with live=True is refused: the",
      "live order path is left to you to implement and review.",
      '"""',
      "",
      "",
      "class Venue:",
      '    """Fetch a price, submit an order, list what is open."""',
      "",
      '    name = "base"',
      "",
      "    def __init__(self, live=False):",
      "        if live:",
      "            raise RuntimeError(",
      '                "{0} is a paper-mode stub: the live order path is "',
      '                "deliberately not implemented. Write it and review it "',
      '                "yourself before any of this touches money.".format(',
      "                    type(self).__name__",
      "                )",
      "            )",
      "        self.live = False",
      "",
      "    def price(self, pair):",
      '        """Last price for a pair."""',
      "        raise NotImplementedError",
      "",
      "    def submit(self, order):",
      '        """Send an order dict, return a fill dict."""',
      "        raise NotImplementedError",
      "",
      "    def positions(self):",
      '        """Everything currently open."""',
      "        raise NotImplementedError",
    ]);

  function venueAdapter(spec) {
    const cls = className(spec.venue);
    const spot = SPOT_ONLY.includes(spec.venue);
    const out = [
      '"""' + spec.venue + " adapter, paper mode.",
      "",
      "Placeholder prices and fake fills, so the loop runs end to end without",
      "touching an exchange. Nothing here opens a socket. The live order path",
      "is yours to write and review.",
    ];
    if (spot) {
      out.push(
        "",
        "Robinhood Chain is an Ethereum layer-2 on Arbitrum Orbit, and it is spot",
        "only: there is no leverage to ask for and no order book to sit in. The",
        "fills below model a swap against a pool, which is why each one carries",
        "model=swap. Writing the actual swap — routing, slippage, signing — is",
        "yours, and none of it lives here."
      );
    }
    out.push(
      '"""',
      "",
      "import hashlib",
      "",
      "from venue.base import Venue",
      "",
      "",
      "def placeholder_price(pair):",
      '    """A stable made-up price. Deterministic per pair, worth nothing."""',
      '    digest = hashlib.sha256(pair.encode("utf-8")).digest()',
      '    return round(10.0 + (int.from_bytes(digest[:4], "big") % 100000) / 100.0, 2)',
      "",
      "",
      "class " + cls + "(Venue):",
      "",
      '    name = "' + spec.venue + '"',
      "",
      "    def __init__(self, live=False):",
      "        super().__init__(live=live)",
      "        self._fills = []",
      "",
      "    def price(self, pair):",
      "        return placeholder_price(pair)",
      "",
      "    def submit(self, order):",
      '        """Fake a fill at the placeholder price. No network, no money."""',
      '        price = order.get("price") or self.price(order["pair"])',
      "        fill = {",
      '            "status": "filled",',
      '            "venue": self.name,',
      '            "pair": order["pair"],',
      '            "side": order["side"],',
      '            "notional": order["notional"],',
      '            "price": price,',
      '            "fee": 0.0,',
      '            "paper": True,'
    );
    if (spot) out.push('            "model": "swap",');
    out.push(
      "        }",
      "        self._fills.append(fill)",
      "        return fill",
      "",
      "    def positions(self):",
      "        return list(self._fills)"
    );
    return block(out);
  }

  function main(spec) {
    const cls = className(spec.venue);
    return block([
      '"""One pass: fetch, decide, size, submit.',
      "",
      "Paper mode. `make run` calls this; it writes a run record into runs/ and",
      "exits. Loop it from cron or a supervisor if you want it to keep going.",
      '"""',
      "",
      "import json",
      "import sys",
      "from datetime import datetime, timezone",
      "from pathlib import Path",
      "",
      "SRC = Path(__file__).resolve().parent",
      "if str(SRC) not in sys.path:",
      "    sys.path.insert(0, str(SRC))",
      "",
      "import risk  # noqa: E402  (after the sys.path line above)",
      "import strategy  # noqa: E402",
      "from venue." + spec.venue + " import " + cls + "  # noqa: E402",
      "",
      'RUNS = SRC.parent / "runs"',
      "",
      "",
      "def run_once(venue=None, equity=risk.CASH):",
      '    """Walk every pair once and return what happened."""',
      "    venue = venue or " + cls + "()",
      "    submitted = []",
      "    skipped = []",
      "    for pair in strategy.PAIRS:",
      "        price = venue.price(pair)  # fetch",
      "        intent = strategy.decide(pair, price)  # decide",
      "        if intent is None:",
      '            skipped.append({"pair": pair, "why": "no signal"})',
      "            continue",
      "        order = {  # size",
      '            "pair": pair,',
      '            "side": intent["side"],',
      '            "notional": risk.max_notional(equity),',
      '            "price": price,',
      "        }",
      "        refusal = risk.check(order, equity)  # the only no",
      "        if refusal:",
      '            skipped.append({"pair": pair, "why": refusal})',
      "            continue",
      "        submitted.append(venue.submit(order))  # submit",
      "    return {",
      '        "venue": venue.name,',
      '        "equity": equity,',
      '        "paper": True,',
      '        "submitted": submitted,',
      '        "skipped": skipped,',
      "    }",
      "",
      "",
      "def main():",
      "    record = run_once()",
      "    now = datetime.now(timezone.utc)",
      '    record["at"] = now.isoformat(timespec="seconds")',
      "    RUNS.mkdir(parents=True, exist_ok=True)",
      '    path = RUNS / "run-{0}.json".format(now.strftime("%Y%m%dT%H%M%S"))',
      '    path.write_text(json.dumps(record, indent=2) + "\\n", encoding="utf-8")',
      "    print(",
      '        "{0}: {1} submitted, {2} skipped -> {3}".format(',
      '            record["venue"], len(record["submitted"]), len(record["skipped"]), path',
      "        )",
      "    )",
      "    return 0",
      "",
      "",
      'if __name__ == "__main__":',
      "    raise SystemExit(main())",
    ]);
  }

  function testRisk(spec) {
    const cls = className(spec.venue);
    return block([
      '"""The caps from the spec, asserted.',
      "",
      "If someone edits src/risk.py to trade bigger than " + docsafe(filename(spec.source)) + " allowed,",
      "this test fails. That is the whole point of it.",
      '"""',
      "",
      "import sys",
      "import unittest",
      "from pathlib import Path",
      "",
      'sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))',
      "",
      "import main  # noqa: E402  (after the sys.path line above)",
      "import risk  # noqa: E402",
      "import strategy  # noqa: E402",
      "from venue." + spec.venue + " import " + cls + "  # noqa: E402",
      "",
      "",
      "class TestCapsFromTheSpec(unittest.TestCase):",
      "",
      "    def test_caps_are_exactly_what_the_spec_said(self):",
      "        self.assertAlmostEqual(risk.MAX_POSITION, " + num(spec.max_position) + ")",
      "        self.assertAlmostEqual(risk.STOP_LOSS, " + num(spec.stop_loss) + ")",
      "        self.assertAlmostEqual(risk.LEVERAGE, " + num(spec.leverage) + ")",
      "        self.assertAlmostEqual(risk.CASH, " + num(spec.cash) + ")",
      "",
      "    def test_pairs_and_timeframe_are_the_spec_ones(self):",
      "        self.assertEqual(strategy.PAIRS, " + listLiteral(spec.pairs) + ")",
      "        self.assertEqual(strategy.TIMEFRAME, " + reprStr(spec.timeframe) + ")",
      "",
      "    def test_max_notional_scales_with_equity(self):",
      "        self.assertAlmostEqual(",
      "            risk.max_notional(risk.CASH),",
      "            risk.CASH * risk.MAX_POSITION * risk.LEVERAGE,",
      "        )",
      "",
      "    def test_stop_price_sits_a_stop_loss_away(self):",
      '        self.assertAlmostEqual(risk.stop_price(100.0, "long"), 100.0 * (1 - risk.STOP_LOSS))',
      '        self.assertAlmostEqual(risk.stop_price(100.0, "short"), 100.0 * (1 + risk.STOP_LOSS))',
      "        with self.assertRaises(ValueError):",
      '            risk.stop_price(100.0, "sideways")',
      "",
      "    def test_an_order_at_the_cap_is_allowed(self):",
      '        order = {"pair": "BTC", "side": "long", "notional": risk.max_notional(risk.CASH)}',
      "        self.assertIsNone(risk.check(order, risk.CASH))",
      "",
      "    def test_an_order_over_the_cap_is_refused(self):",
      "        order = {",
      '            "pair": "BTC",',
      '            "side": "long",',
      '            "notional": risk.max_notional(risk.CASH) * 1.01,',
      "        }",
      '        self.assertIn("over the cap", risk.check(order, risk.CASH))',
      "",
      "    def test_too_much_leverage_is_refused(self):",
      "        order = {",
      '            "pair": "BTC",',
      '            "side": "long",',
      '            "notional": 1.0,',
      '            "leverage": risk.LEVERAGE + 1,',
      "        }",
      '        self.assertIn("leverage", risk.check(order, risk.CASH))',
      "",
      "",
      "class TestPaperOnly(unittest.TestCase):",
      "",
      "    def test_live_is_refused(self):",
      "        with self.assertRaises(RuntimeError) as caught:",
      "            " + cls + "(live=True)",
      '        self.assertIn("paper-mode stub", str(caught.exception))',
      "",
      "    def test_a_fill_is_fake_and_says_so(self):",
      "        venue = " + cls + "()",
      '        fill = venue.submit({"pair": "BTC", "side": "long", "notional": 1.0})',
      '        self.assertTrue(fill["paper"])',
      '        self.assertEqual(fill["status"], "filled")',
      "        self.assertEqual(venue.positions(), [fill])",
      "",
      "",
      "class TestOnePass(unittest.TestCase):",
      "",
      "    def test_the_loop_runs_end_to_end(self):",
      "        record = main.run_once(venue=" + cls + "(), equity=risk.CASH)",
      '        self.assertTrue(record["paper"])',
      '        self.assertEqual(record["venue"], ' + reprStr(spec.venue) + ")",
      '        seen = [row["pair"] for row in record["submitted"]] + [',
      '            row["pair"] for row in record["skipped"]',
      "        ]",
      "        self.assertEqual(sorted(seen), sorted(strategy.PAIRS))",
      "",
      "",
      'if __name__ == "__main__":',
      "    unittest.main()",
    ]);
  }

  const TEMPLATES = [
    ["README.md", readme],
    [".env.example", envExample],
    [".gitignore", gitignore],
    ["requirements.txt", requirements],
    ["Makefile", makefile],
    ["Dockerfile", dockerfile],
    ["compose.yml", compose],
    [".github/workflows/ci.yml", ci],
    ["src/main.py", main],
    ["src/strategy.py", strategy],
    ["src/risk.py", risk],
    ["src/venue/base.py", venueBase],
    ["src/venue/{venue}.py", venueAdapter],
    ["tests/test_risk.py", testRisk],
  ];

  const DIRECTORIES = ["runs"];

  function render(spec) {
    return TEMPLATES.map(function (entry) {
      let text = entry[1](spec);
      if (!text.endsWith("\n")) text += "\n";
      return [entry[0].replace("{venue}", spec.venue), text];
    });
  }

  // --- what the CLI prints: "14 files, 13.3kb" ------------------------------

  const encoder = new TextEncoder();

  function size(files) {
    let total = 0;
    for (const entry of files) total += encoder.encode(entry[1]).length;
    // "{0:.1f}kb".format(total / 1000.0) rounds the binary value half to even.
    return { bytes: total, label: roundTo(total / 1000, 1).toFixed(1) + "kb" };
  }

  // --- a .zip, written by hand ----------------------------------------------
  // Stored, not deflated: no compression code and no dependency, and a whole
  // generated repo is about 14kb. Every timestamp is 1980-01-01, so the same
  // spec downloads the same bytes, the way the CLI writes the same tree.

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // entries: [path, text] for a file, [path, null] for a directory.
  function zip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const isDir = entry[1] === null;
      const name = encoder.encode(entry[0]);
      const data = isDir ? new Uint8Array(0) : encoder.encode(entry[1]);
      const crc = isDir ? 0 : crc32(data);
      const attributes = isDir ? (0o40755 * 0x10000 + 0x10) >>> 0 : (0o100644 * 0x10000) >>> 0;

      const local = new Uint8Array(30 + name.length);
      const l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true);
      l.setUint16(4, 20, true); // version needed to extract
      l.setUint16(6, 0x0800, true); // names are UTF-8
      l.setUint16(8, 0, true); // stored
      l.setUint16(10, 0, true); // 00:00:00
      l.setUint16(12, 0x21, true); // 1980-01-01
      l.setUint32(14, crc, true);
      l.setUint32(18, data.length, true);
      l.setUint32(22, data.length, true);
      l.setUint16(26, name.length, true);
      local.set(name, 30);

      const record = new Uint8Array(46 + name.length);
      const c = new DataView(record.buffer);
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 0x0314, true); // made by unix, spec 2.0
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true);
      c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(38, attributes, true);
      c.setUint32(42, offset, true);
      record.set(name, 46);

      parts.push(local, data);
      central.push(record);
      offset += local.length + data.length;
    }
    let centralSize = 0;
    for (const part of central) centralSize += part.length;
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, entries.length, true);
    e.setUint16(10, entries.length, true);
    e.setUint32(12, centralSize, true);
    e.setUint32(16, offset, true);

    const all = parts.concat(central, [end]);
    let length = 0;
    for (const part of all) length += part.length;
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of all) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  // The generated repository as one archive: slug/, every file, slug/runs/.
  function bundle(spec) {
    const root = spec.slug + "/";
    const entries = [[root, null]];
    for (const file of render(spec)) entries.push([root + file[0], file[1]]);
    for (const dir of DIRECTORIES) entries.push([root + dir + "/", null]);
    return zip(entries);
  }

  return {
    VENUES: VENUES,
    DIRECTORIES: DIRECTORIES,
    SpecError: SpecError,
    parse: parse,
    render: render,
    size: size,
    bundle: bundle,
    filename: filename,
  };
});
