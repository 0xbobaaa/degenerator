"""runs/ receipts and the trace log.

If you cannot say which run wrote a file and why, it is not a generator, it is
a folder. Receipts live under the directory degenerator was invoked from, not
inside the generated repo — so re-running with --force leaves that repo
byte-identical.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Union

from .scaffold import Result
from .spec import Spec

RUNS = "runs"
TRACE = "trace.log"


def receipt_payload(spec: Spec, result: Result, ms: int, at: datetime) -> dict:
    """Exactly what lands in the JSON file."""
    return {
        "at": at.isoformat(timespec="seconds"),
        "spec": spec.source,
        "project": spec.title,
        "venue": spec.venue,
        "risk": spec.risk,
        "files": list(result.files),
        "bytes": result.bytes,
        "ms": ms,
        "git": result.git,
    }


def write_receipt(
    spec: Spec,
    result: Result,
    ms: int,
    root: Optional[Union[str, Path]] = None,
    at: Optional[datetime] = None,
) -> Path:
    """Write the JSON receipt, append one line to the trace log, return the path."""
    root = Path(root) if root is not None else Path.cwd()
    at = at or datetime.now(timezone.utc)

    day = root / RUNS / at.strftime("%Y-%m-%d")
    day.mkdir(parents=True, exist_ok=True)
    path = _free_path(day, at)

    payload = receipt_payload(spec, result, ms, at)
    # ensure_ascii=False: the git line carries a middot, and a receipt should
    # read the same as the line printed to the terminal.
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    append_trace(root, spec, result, ms, path, at)
    return path


def append_trace(
    root: Path,
    spec: Spec,
    result: Result,
    ms: int,
    receipt: Path,
    at: datetime,
) -> Path:
    """One line per run, oldest first. Never rewritten, only appended to."""
    trace = Path(root) / RUNS / TRACE
    trace.parent.mkdir(parents=True, exist_ok=True)
    line = "{0} new {1} <- {2} · {3} files · {4} bytes · {5}ms · git: {6} · {7}\n".format(
        at.isoformat(timespec="seconds"),
        result.out,
        spec.source,
        len(result.files),
        result.bytes,
        ms,
        result.git,
        relative(receipt, root),
    )
    with open(trace, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)
    return trace


def _free_path(day: Path, at: datetime) -> Path:
    """receipt-141203.json, or -2, -3 … when a second holds more than one run."""
    stem = "receipt-{0}".format(at.strftime("%H%M%S"))
    path = day / "{0}.json".format(stem)
    nth = 2
    while path.exists():
        path = day / "{0}-{1}.json".format(stem, nth)
        nth += 1
    return path


def relative(path: Path, root: Path) -> str:
    """The receipt path as the user would type it, when that is possible."""
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return str(path)
