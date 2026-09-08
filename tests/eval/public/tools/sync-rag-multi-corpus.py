#!/usr/bin/env python3
"""Freeze the exact RAG-Multi-Corpus slice used by kb-pilot."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
import tempfile
from collections import OrderedDict
from pathlib import Path


EXPECTED_REVISION = "39071af3f4dd25e59f5c59a6f9b6e8e99cd643b3"
EXPECTED_QUERY_SHA256 = "58be4e8ebe96147ab63b159b3166357ad905989023956038ed563f9b88c2d24e"
EXPECTED_LICENSE_SHA256 = "98800da81937e7e782491cd00623c39f6958cf031e36441f9ed604997921a140"
EXPECTED_DOCUMENTS = 236
EXPECTED_SOURCE_ROWS = 1088
EXPECTED_CASES = 907
QUERY_SOURCE = Path("bechmark/bechmark-agentic-references/Dataset categories - queries.csv")
ENTERPRISE_DIRS = {
    "ZX Bank": "ZX Bank",
    "Cendara University": "Cendara University",
    "Aventro Motors": "Aventro Motors",
    "Velvera Technologies": "Velvera Technologies",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_revision(source: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def normalized_filename(value: str) -> str:
    return " ".join(value.strip().split())


def case_id(enterprise: str, query: str) -> str:
    slug = "-".join(enterprise.lower().split())
    identity = hashlib.sha256(f"{enterprise}\0{query}".encode("utf-8")).hexdigest()[:16]
    return f"ragmc-{slug}-{identity}"


def corpus_documents(source: Path) -> tuple[list[dict[str, object]], dict[str, dict[str, str]]]:
    documents: list[dict[str, object]] = []
    lookup: dict[str, dict[str, str]] = {}
    for md_dir in sorted(source.glob("datasets/*/md"), key=lambda value: value.as_posix()):
        enterprise_dir = md_dir.parent.name
        normalized: dict[str, str] = {}
        for document in sorted(md_dir.glob("*.md"), key=lambda value: value.name):
            relative = document.relative_to(source).as_posix()
            key = normalized_filename(document.name)
            if key in normalized:
                raise ValueError(f"ambiguous normalized filename: {enterprise_dir}/{key}")
            normalized[key] = relative
            documents.append({
                "path": relative,
                "enterpriseName": enterprise_dir,
                "filename": document.name,
                "bytes": document.stat().st_size,
                "sha256": sha256_file(document),
            })
        lookup[enterprise_dir] = normalized
    if len(documents) != EXPECTED_DOCUMENTS:
        raise ValueError(f"expected {EXPECTED_DOCUMENTS} Markdown documents, got {len(documents)}")
    return documents, lookup


def normalized_queries(
    query_path: Path,
    document_lookup: dict[str, dict[str, str]],
) -> list[dict[str, object]]:
    grouped: OrderedDict[tuple[str, str], dict[str, object]] = OrderedDict()
    source_rows = 0
    with query_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            source_rows += 1
            enterprise = row["Enterprise Name"].strip()
            query = row["Query"].strip()
            query_type = row["Query Type"].strip()
            key = (enterprise, query)
            facts = json.loads(row["Supporting Facts"])
            if not isinstance(facts, list) or not facts:
                raise ValueError(f"query has no supporting facts: {key}")
            current = grouped.setdefault(key, {
                "schemaVersion": "1",
                "id": case_id(enterprise, query),
                "enterpriseName": enterprise,
                "queryType": query_type,
                "query": query,
                "sourceRowCount": 0,
                "supportingFacts": [],
                "evidenceDocumentPaths": [],
                "missingEvidenceFiles": [],
            })
            if current["queryType"] != query_type:
                raise ValueError(f"query type conflict: {key}")
            current["sourceRowCount"] = int(current["sourceRowCount"]) + 1
            fact_list = current["supportingFacts"]
            if not isinstance(fact_list, list):
                raise TypeError("supportingFacts accumulator is invalid")
            for fact in facts:
                normalized_fact = {
                    "filename": str(fact["filename"]),
                    "text": str(fact["text"]),
                }
                if normalized_fact not in fact_list:
                    fact_list.append(normalized_fact)

    if source_rows != EXPECTED_SOURCE_ROWS or len(grouped) != EXPECTED_CASES:
        raise ValueError(
            f"expected {EXPECTED_SOURCE_ROWS} rows/{EXPECTED_CASES} cases, "
            f"got {source_rows}/{len(grouped)}"
        )

    for (enterprise, _), item in grouped.items():
        enterprise_dir = ENTERPRISE_DIRS.get(enterprise)
        if enterprise_dir is None:
            raise ValueError(f"unsupported enterprise in kb-pilot slice: {enterprise}")
        available = document_lookup[enterprise_dir]
        evidence: list[str] = []
        missing: list[str] = []
        facts = item["supportingFacts"]
        if not isinstance(facts, list):
            raise TypeError("supportingFacts must be a list")
        for fact in facts:
            filename = str(fact["filename"])
            path = available.get(normalized_filename(filename))
            if path is None:
                if filename not in missing:
                    missing.append(filename)
            elif path not in evidence:
                evidence.append(path)
        item["evidenceDocumentPaths"] = evidence
        item["missingEvidenceFiles"] = missing
        item["sourceStatus"] = "complete" if not missing else "invalid-missing-document"
    return list(grouped.values())


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def assert_replaceable_output(output: Path, force: bool) -> None:
    if not output.exists():
        return
    if not force:
        raise FileExistsError(f"output already exists: {output}; pass --force to replace it")
    manifest_path = output / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"refusing to replace unrecognized output directory: {output}") from error
    if manifest.get("datasetId") != "rag-multi-corpus-kb-pilot-v1":
        raise ValueError(f"refusing to replace unrelated output directory: {output}")


def sync(source: Path, output: Path, force: bool) -> dict[str, object]:
    source = source.resolve()
    if output.is_symlink():
        raise ValueError(f"refusing to use a symlink output directory: {output}")
    output = output.resolve()
    revision = source_revision(source)
    query_path = source / QUERY_SOURCE
    license_path = source / "LICENSE"
    if revision != EXPECTED_REVISION:
        raise ValueError(f"RAG-Multi-Corpus revision mismatch: {revision}")
    if sha256_file(query_path) != EXPECTED_QUERY_SHA256:
        raise ValueError("RAG-Multi-Corpus query CSV hash mismatch")
    if sha256_file(license_path) != EXPECTED_LICENSE_SHA256:
        raise ValueError("RAG-Multi-Corpus license hash mismatch")
    assert_replaceable_output(output, force)

    documents, document_lookup = corpus_documents(source)
    queries = normalized_queries(query_path, document_lookup)
    complete_cases = sum(item["sourceStatus"] == "complete" for item in queries)
    invalid_cases = len(queries) - complete_cases

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="rag-multi-corpus-sync-", dir=output.parent) as temp:
        stage = Path(temp) / output.name
        corpus_root = stage / "corpus"
        for document in documents:
            relative = Path(str(document["path"]))
            destination = corpus_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, destination)
        source_dir = stage / "source"
        source_dir.mkdir(parents=True)
        shutil.copyfile(query_path, source_dir / "queries.csv")
        shutil.copyfile(license_path, stage / "LICENSE.rag-multi-corpus")

        queries_jsonl = "".join(
            json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
            for item in queries
        )
        (stage / "queries.jsonl").write_text(queries_jsonl, encoding="utf-8")
        write_json(stage / "corpus-manifest.json", {
            "schemaVersion": "1",
            "documentCount": len(documents),
            "documents": documents,
        })
        manifest = {
            "schemaVersion": "1",
            "datasetId": "rag-multi-corpus-kb-pilot-v1",
            "track": "general",
            "formalScoreEligible": False,
            "source": {
                "repository": "https://github.com/udayallu/RAG-Multi-Corpus",
                "revision": revision,
                "queryCsv": QUERY_SOURCE.as_posix(),
                "queryCsvSha256": EXPECTED_QUERY_SHA256,
                "licenseSha256": EXPECTED_LICENSE_SHA256,
            },
            "kbPilot": {
                "repository": "https://github.com/waylondev/kb-pilot",
                "revision": "a987183b1ff3c983775d4eff14e012baf811f080",
                "reportedUniqueQuestions": EXPECTED_CASES,
            },
            "sourceRowCount": EXPECTED_SOURCE_ROWS,
            "caseCount": len(queries),
            "completeCaseCount": complete_cases,
            "invalidMissingDocumentCaseCount": invalid_cases,
            "documentCount": len(documents),
            "queriesSha256": hashlib.sha256(queries_jsonl.encode("utf-8")).hexdigest(),
            "corpusManifestSha256": sha256_file(stage / "corpus-manifest.json"),
            "limitations": [
                "The upstream QA file contains supporting facts but no reference answers.",
                "The upstream answer grader was manual and is not published as a versioned scorer.",
                "Cases with unresolved evidence documents are retained but excluded from scoring.",
            ],
        }
        write_json(stage / "manifest.json", manifest)
        if output.exists():
            shutil.rmtree(output)
        shutil.move(str(stage), output)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path(
        "tests/eval/public/kb-pilot/data/rag-multi-corpus-v1"
    ))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    manifest = sync(args.source, args.output, args.force)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
