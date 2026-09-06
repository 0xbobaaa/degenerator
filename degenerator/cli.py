"""argparse front door.

Two commands: ``plan`` prints the tree and writes nothing, ``new`` writes it.
Refusals leave one readable line on stderr and a non-zero exit code.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import List, Optional

from . import receipts, scaffold, templates
from .scaffold import ScaffoldError
from .spec import SpecError, parse_file

PROG = "degenerator"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG, description="One spec in, one degen bot out."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    plan_cmd = commands.add_parser("plan", help="print the file tree, write nothing")
    plan_cmd.add_argument("spec", help="path to the spec file")
    plan_cmd.set_defaults(handler=cmd_plan)

    new_cmd = commands.add_parser("new", help="write the bot repo")
    new_cmd.add_argument("spec", help="path to the spec file")
    new_cmd.add_argument(
        "-o", "--out", default=None, help="output directory (default: slugified project name)"
    )
    new_cmd.add_argument("--force", action="store_true", help="overwrite a non-empty directory")
    new_cmd.add_argument(
        "--no-git", action="store_true", help="skip git init and the first commit"
    )
    new_cmd.add_argument(
        "--dry-run", action="store_true", help="report what would happen, touch nothing"
    )
    new_cmd.set_defaults(handler=cmd_new)

    return parser


def cmd_plan(args: argparse.Namespace) -> int:
    spec = parse_file(args.spec)
    out = Path(spec.slug)
    files = scaffold.plan(spec)
    _say("{0} -> {1}/".format(spec.title, out))
    for path in files:
        _say("  {0}".format(path))
    for directory in templates.DIRECTORIES:
        _say("  {0}/ (empty)".format(directory))
    _say("")
    _say("{0} files · {1} · nothing written".format(len(files), _size(spec)))
    return 0


def cmd_new(args: argparse.Namespace) -> int:
    started = time.perf_counter()
    spec = parse_file(args.spec)
    out = Path(args.out) if args.out else Path(spec.slug)

    if args.dry_run:
        # A dry run still refuses what the real run would refuse: better to
        # hear it now than after the files are gone.
        _refuse_if_occupied(out, args.force)
        files = scaffold.plan(spec)
        _say("{0} -> {1}/".format(spec.title, out))
        _say(
            "  would write {0} files · {1} · git: {2}".format(
                len(files), _size(spec), "skipped" if args.no_git else "initialised · 1 commit"
            )
        )
        _say("  dry run: nothing written, no receipt")
        return 0

    result = scaffold.write(spec, out, force=args.force, no_git=args.no_git)
    ms = int((time.perf_counter() - started) * 1000)
    receipt = receipts.write_receipt(spec, result, ms)

    _say("{0} -> {1}/".format(spec.title, out))
    _say(
        "  {0} files · {1} · {2}ms · git: {3}".format(
            len(result.files), _kb(result.bytes), ms, result.git
        )
    )
    _say("  receipt: {0}".format(receipts.relative(receipt, Path.cwd())))
    _say("")
    _say("next:")
    _say("  cd {0} && cp .env.example .env && make test".format(out))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    _utf8_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except (SpecError, ScaffoldError) as exc:
        print("{0}: {1}".format(PROG, exc), file=sys.stderr)
        return 2


def _refuse_if_occupied(out: Path, force: bool) -> None:
    if out.exists() and out.is_dir() and any(out.iterdir()) and not force:
        raise ScaffoldError("{0} is not empty: pass --force to write over it".format(out))


def _size(spec) -> str:
    return _kb(sum(len(text.encode("utf-8")) for _, text in scaffold.file_table(spec)))


def _kb(total: int) -> str:
    return "{0:.1f}kb".format(total / 1000.0)


def _say(line: str) -> None:
    print(line)


def _utf8_stdout() -> None:
    """Keep the middot in the output on consoles that would choke on it."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except (AttributeError, ValueError, OSError):
            pass


if __name__ == "__main__":
    raise SystemExit(main())
