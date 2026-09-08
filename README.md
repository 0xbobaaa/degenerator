# degenerator

One spec in, one degen bot out.

`degenerator` reads a one-page spec file and writes a complete, working crypto
trading-bot repository: source, tests, Dockerfile, GitHub Actions CI,
`.env.example`, an initialised git repo with the first commit made, and a JSON
receipt of everything it wrote.

Standard library only — in this tool, and in the code it generates. No
dependencies to pin, audit, or wake up broken.

## Install

```
pip install -e .
```

## Use

```
degenerator plan  examples/momentum.spec.md          # print the tree, write nothing
degenerator new   examples/momentum.spec.md          # write it
degenerator new   examples/momentum.spec.md -o ./bots/x
```

```
$ degenerator new examples/momentum.spec.md
Momentum Degen -> momentum-degen/
  14 files · 13.0kb · 31ms · git: initialised · 1 commit
  receipt: runs/2026-09-06/receipt-141203.json

next:
  cd momentum-degen && cp .env.example .env && make test
```

| flag | behaviour |
| --- | --- |
| `-o, --out` | output directory (default: slugified project name) |
| `--force` | overwrite a non-empty directory |
| `--no-git` | skip `git init` and the first commit |
| `--dry-run` | report what would happen, touch nothing |

A refusal prints one line on stderr and exits non-zero.

## The spec language

A title, `key: value` lines, and a `rules:` list. That is the whole language.

```
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
```

| key | default | notes |
| --- | --- | --- |
| `venue` | `paper` | one of `hyperliquid`, `dydx`, `robinhood`, `paper` |
| `pairs` | `BTC` | comma separated |
| `timeframe` | `5m` | free text, copied into the strategy as a comment |
| `max_position` | `0.05` | share of equity per position, `%` accepted |
| `stop_loss` | `0.03` | per position, `%` accepted |
| `leverage` | `1` | `3x` and `3` both parse to `3` |
| `cash` | `1000` | starting paper equity |

- A `%` suffix divides by 100. An `x` suffix on `leverage` is stripped.
- Unknown keys are **not** an error. They are kept and copied into the
  generated README, so nothing a human wrote is silently dropped.
- A spec with no `rules:` is refused: a bot with no rules is a random number
  generator.
- An unknown `venue` is refused, and the error lists the valid ones.
- `robinhood` is spot only. Robinhood Chain is an Ethereum layer-2 with no
  leverage to give, so a spec that pairs it with `leverage` above `1` is
  refused, pointing at the `leverage` line you need to delete. Its generated
  adapter marks fills `model=swap` rather than pretending there is an order
  book.
- Rules are copied verbatim into `strategy.py` as comments. degenerator does
  not try to parse English into code.

## What you get

```
momentum-degen/
├── README.md              the spec, restated for whoever opens the repo
├── .env.example           keys go here; .env is gitignored
├── .gitignore
├── requirements.txt       empty, with a comment saying why
├── Makefile               make run · make test · make image
├── Dockerfile             multi-stage, python:3.12-slim
├── compose.yml            bot + mounted runs/
├── .github/workflows/ci.yml   unittest + docker build on every push
├── src/
│   ├── main.py            one pass: fetch, decide, size, submit
│   ├── strategy.py        signals in, orders out (spec rules as comments)
│   ├── risk.py            the only file allowed to say no
│   └── venue/
│       ├── base.py        the interface every venue answers
│       └── <venue>.py     paper-mode adapter, live path left to you
├── tests/test_risk.py     the caps from the spec, asserted
└── runs/                  receipts, never edited by hand
```

`make test` passes in the generated repo immediately, with no edits.

## Safety

- Generated venue adapters are paper-mode stubs: placeholder prices, fake
  fills, no sockets. The loop runs end to end and touches no exchange.
- An adapter refuses to construct with `live=True`. The live order path is
  deliberately left to you to implement and review.
- `risk.py` enforces `max_position`, `stop_loss` and `leverage` from the spec,
  and `tests/test_risk.py` asserts those exact numbers. Every constant carries
  a comment naming the spec line it came from, or the default it fell back to.
- **The caps are applied, not judged.** `leverage: 50x` generates a repo that
  says `50x`. degenerator refuses to invent config you did not write, and that
  cuts both ways: there is no ceiling on `leverage`, `max_position` or
  `stop_loss`. Paper mode means nothing is at risk in the generated repo, but
  the numbers are yours to sanity-check before any of it goes near an exchange.
- A spec is a file, and a file can come from someone else. Free text from a
  spec is neutralised before it reaches generated Python, so a spec cannot
  execute code when you run `make test` — `tests/test_scaffold.py` holds that
  line. Absolute spec paths stay out of the generated repo and its git history;
  they are recorded only in the local receipt.

Nothing here is financial advice.

## Receipts

Every `new` run writes `runs/<date>/receipt-<time>.json` next to where you ran
it, and appends a line to `runs/trace.log`:

```json
{
  "at": "2026-09-06T14:12:03+00:00",
  "spec": "examples/momentum.spec.md",
  "project": "Momentum Degen",
  "venue": "hyperliquid",
  "risk": { "max_position": 0.05, "stop_loss": 0.03, "leverage": 3 },
  "files": ["README.md", "..."],
  "bytes": 13043,
  "ms": 31,
  "git": "initialised · 1 commit"
}
```

Receipts live beside the invocation, not inside the generated repo, so running
`new --force` twice on the same spec leaves that repo byte-identical.

If you cannot say which run wrote a file and why, it is not a generator, it is
a folder.

## Layout

```
degenerator/
├── cli.py           argparse front door
├── spec.py          the spec language and its errors
├── scaffold.py      writes the tree, runs git init
├── templates.py     every generated file, as one flat table
└── receipts.py      runs/ receipts and the trace log
tests/
├── test_spec.py     parsing, defaults, % and x suffixes, refusals
└── test_scaffold.py scaffolds into a temp dir, runs the child repo's tests
examples/
```

`plan()` and the file table are asserted against each other by the test suite,
so they cannot drift apart.

## Tests

```
python -m unittest discover -s tests -q
```

The suite scaffolds a repo into a temp directory and runs that repo's own
tests as part of the run, so a generated bot that fails its own `make test`
fails here first.
