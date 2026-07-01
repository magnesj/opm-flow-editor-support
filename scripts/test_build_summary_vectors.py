"""Tests for build_summary_vectors.py (offline, via --local-dir fixtures)."""

import json
import sys
from pathlib import Path

# Make the scripts directory importable
sys.path.insert(0, str(Path(__file__).parent))
from build_summary_vectors import build, main


def _write_sources(tmp_path: Path) -> Path:
    (tmp_path / "keywords_eclipse.json").write_text(
        json.dumps(
            {
                "WOPR": {"category": "SUMMARY_WELL", "description": "Oil Production Rate"},
                "BFOAM": {"category": "SUMMARY_BLOCK", "description": " Surfactant concentration "},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "keywords_network.json").write_text(
        json.dumps(
            {"GNETPR": {"category": "SUMMARY_NETWORK", "description": "Node pressure"}}
        ),
        encoding="utf-8",
    )
    # A 6x file that must be ignored even if present.
    (tmp_path / "keywords_6x.json").write_text(
        json.dumps({"BAPIM-1": {"category": "SUMMARY_BLOCK", "description": "6x only"}}),
        encoding="utf-8",
    )
    return tmp_path


def test_build_merges_eclipse_and_network_and_sorts(tmp_path):
    table = build(ref="unused", local_dir=_write_sources(tmp_path))
    assert list(table) == sorted(table)  # sorted by mnemonic
    assert set(table) == {"WOPR", "BFOAM", "GNETPR"}
    assert table["WOPR"] == {"summary": "Oil Production Rate", "category": "SUMMARY_WELL"}
    # Descriptions are stripped.
    assert table["BFOAM"]["summary"] == "Surfactant concentration"


def test_build_excludes_6x_variants(tmp_path):
    table = build(ref="unused", local_dir=_write_sources(tmp_path))
    assert "BAPIM-1" not in table


def test_main_writes_output_file(tmp_path):
    src = _write_sources(tmp_path)
    out = tmp_path / "out" / "summary_vectors.json"
    rc = main(["--output", str(out), "--local-dir", str(src)])
    assert rc == 0
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["GNETPR"]["category"] == "SUMMARY_NETWORK"
