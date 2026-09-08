#!/usr/bin/env python3
"""Losslessly export frozen MemoryAgentBench parquet rows as JSONL for the TS adapter."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pyarrow.parquet as pq


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    manifest = {"schemaVersion": "1", "exports": []}
    for parquet_path in sorted(args.input_dir.glob("*.parquet")):
        table = pq.read_table(parquet_path)
        output_path = args.output_dir / f"{parquet_path.stem}.jsonl"
        with output_path.open("w", encoding="utf-8") as handle:
            for index, row in enumerate(table.to_pylist()):
                handle.write(json.dumps(
                    {"rowIndex": index, "row": row},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ))
                handle.write("\n")
        manifest["exports"].append({
            "split": parquet_path.stem,
            "sourceSha256": sha256(parquet_path),
            "sourceSizeBytes": parquet_path.stat().st_size,
            "rowCount": table.num_rows,
            "output": output_path.name,
            "outputSha256": sha256(output_path),
            "outputSizeBytes": output_path.stat().st_size,
        })

    manifest_path = args.output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
