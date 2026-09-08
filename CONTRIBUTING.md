# Contributing

## The rules that are not negotiable

- **Standard library only**, here and in everything generated. A pull request
  that adds a dependency to either side will be closed.
- **No live order execution.** Venue adapters are paper-mode stubs that refuse
  to construct with `live=True`. Writing and reviewing the live path is the
  user's job, deliberately.
- **No new venues** beyond `hyperliquid`, `dydx`, `robinhood` and `paper`.
- **No signing, no wallets, no RPC calls.** `robinhood` is a chain, and the
  temptation to reach for `web3` and a key field is exactly the thing this repo
  refuses. A generated `.env.example` must never name a private key.
- **Do not interpret rule text.** Rules are copied into `strategy.py` as
  comments, verbatim. Turning English into trading logic is out of scope and
  always will be.
- **Do not invent config.** Every number in a generated `risk.py` traces back
  to a line in the spec or to a default documented in `spec.DEFAULTS`.

## Where things live

| file | job |
| --- | --- |
| `degenerator/spec.py` | the spec language and every user-facing refusal |
| `degenerator/templates.py` | every generated file, as one flat table |
| `degenerator/scaffold.py` | writes the tree, runs git init |
| `degenerator/receipts.py` | `runs/` receipts and the trace log |
| `degenerator/cli.py` | argparse front door, exit codes |

Adding or changing a generated file means editing `TEMPLATES` in
`templates.py`. `scaffold.plan()` reads the same table, and the test suite
asserts the two against each other — that is why they cannot drift.

## Before you open a pull request

```
python -m unittest discover -s tests -q
```

That suite scaffolds a repo into a temp directory and runs the generated
repo's own tests as part of the run. If a change makes a generated repo fail
its own `make test`, the suite fails here first, which is the point.

New behaviour needs a test. New refusals need a test asserting the message is
a single readable line.

## Determinism

Two `new` runs on the same spec must produce byte-identical trees. That means:

- no timestamps, no randomness, and no iteration over anything unordered in
  anything `templates.py` renders;
- files are written as bytes, so no platform newline translation;
- receipts are written next to the invocation, never inside the generated repo.

`tests/test_scaffold.py::TestDeterminism` holds the line.
