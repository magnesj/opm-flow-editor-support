#!/usr/bin/env python3
"""Build the SUMMARY-vector description table shipped with the extension.

The OPM reference manual and opm-common cover most SUMMARY vectors, but several
hundred valid mnemonics (all network vectors, plus foam / surfactant / polymer /
interfacial-tension / relative-permeability / aquifer-molar block, field, group,
well and segment vectors) are absent from both. ResInsight maintains a curated
description for each of these, so we fold its ``keywords_eclipse.json`` and
``keywords_network.json`` tables into a single lookup that the extension merges
into its keyword index (never overwriting an authoritative opm-common entry).

The ``keywords_6x.json`` variant (Slb 6x / INTERSECT-format mnemonics) is
deliberately excluded -- it targets a different simulator format.

Source (GPL-3.0, compatible with this extension's GPL-3.0-only licence):
  https://github.com/OPM/ResInsight
  ApplicationLibCode/Application/Resources/keyword-description/

Usage:
  python build_summary_vectors.py --output ../vscode-extension/data/summary_vectors.json
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

# Pin to a specific ResInsight commit so regenerating the file is reproducible.
# Bump this (and re-run) to pick up upstream additions.
DEFAULT_REF = "931c8d066c953f23b964e56217a53642379de1b0"

# Files to fold in, in merge order. `keywords_6x.json` is intentionally omitted.
SOURCE_FILES = ("keywords_eclipse.json", "keywords_network.json")

RAW_URL = (
    "https://raw.githubusercontent.com/OPM/ResInsight/{ref}/"
    "ApplicationLibCode/Application/Resources/keyword-description/{name}"
)


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url) as resp:  # noqa: S310 (fixed https host)
        return json.loads(resp.read().decode("utf-8"))


def load_source(name: str, ref: str, local_dir: Path | None) -> dict:
    if local_dir is not None:
        return json.loads((local_dir / name).read_text(encoding="utf-8"))
    return fetch_json(RAW_URL.format(ref=ref, name=name))


def build(ref: str, local_dir: Path | None) -> dict:
    """Merge the eclipse + network tables into one sorted mnemonic map."""
    merged: dict[str, dict] = {}
    for name in SOURCE_FILES:
        data = load_source(name, ref, local_dir)
        for mnemonic, entry in data.items():
            # First file wins on the rare duplicate; the two sets are disjoint
            # in practice, but be deterministic regardless.
            merged.setdefault(
                mnemonic,
                {
                    "summary": entry.get("description", "").strip(),
                    "category": entry.get("category", ""),
                },
            )
    return {k: merged[k] for k in sorted(merged)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Path to write the summary_vectors.json data file.",
    )
    parser.add_argument(
        "--ref",
        default=DEFAULT_REF,
        help=f"ResInsight git ref to fetch from (default: pinned {DEFAULT_REF[:12]}).",
    )
    parser.add_argument(
        "--local-dir",
        type=Path,
        default=None,
        help="Read the source JSON files from this local directory instead of "
        "fetching them (offline / testing).",
    )
    args = parser.parse_args(argv)

    table = build(args.ref, args.local_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Match the compact index: 0-indent, newline-terminated, UTF-8.
    with args.output.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(table, fh, ensure_ascii=False, indent=0)
        fh.write("\n")

    print(
        f"Wrote {len(table)} SUMMARY-vector descriptions to {args.output} "
        f"(ResInsight @ {args.ref[:12]}, 6x variants excluded)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
