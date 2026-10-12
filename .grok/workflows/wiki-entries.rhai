let meta = #{
    name: "wiki-entries",
    description: "Implement the 2026-10-12 wiki Track E slice: configurable wiki root, entry markdown, ancestor indexes, recall paths, and wiki_read",
    when_to_use: "Use after docs/plans/wiki-memory-feasibility.md and docs/plans/wiki-md-material-and-index.md are the locked decisions. /wiki-entries",
    phases: [
        #{ title: "W1-Config", detail: "wiki.root and the relative-path jail" },
        #{ title: "Core-Modules", detail: "entry writer, index maintainer, and wiki reader in parallel" },
        #{ title: "Wire", detail: "persist hook plus recall and read surfaces in parallel" },
        #{ title: "Backfill-Docs", detail: "CLI backfill and docs in parallel" },
        #{ title: "Review", detail: "three read-only skeptics" },
        #{ title: "Fix", detail: "apply only evidenced findings and retest" },
        #{ title: "Report", detail: "local commit, no push" },
    ],
};

let verdict_schema = #{
    "type": "object",
    "required": ["findings"],
    "properties": #{
        "findings": #{
            "type": "array",
            "maxItems": 8,
            "items": #{
                "type": "object",
                "required": ["file", "issue", "evidence"],
                "properties": #{
                    "file": #{ "type": "string" },
                    "issue": #{ "type": "string" },
                    "evidence": #{ "type": "string" },
                },
            },
        },
    },
};

let status_schema = #{
    "type": "object",
    "required": ["status", "evidence"],
    "properties": #{
        "status": #{ "type": "string" },
        "evidence": #{ "type": "string" },
        "files": #{ "type": "array", "maxItems": 20, "items": #{ "type": "string" } },
    },
};

const FEASIBILITY = "docs/plans/wiki-memory-feasibility.md";
const DESIGN = "docs/plans/wiki-md-material-and-index.md";
const BRANCH = "1.0.7";

let locks = "Read " + FEASIBILITY + " sections 0.1 and 0.2 and all of " + DESIGN + " with read_file before editing. ";
locks += "Branch " + BRANCH + ". Do not push. Do not commit in this phase. ";
locks += "Do not edit ~/.mengshu, do not run ingest against production Postgres, do not rewrite pages/**/page-*.md or .sources. ";
locks += "Do not add Graphiti, an npm publish, or a top-level material/ tree. ";
locks += "DB stays the record of record. Track F fused pages stay offline. Track E is pages/<slug>/entries/<semanticType>/<id>.md. ";
locks += "wikiPath values stored in metadata are relative to wikiRoot with forward slashes. ";
locks += "A wiki file write failure must not roll back a committed memory. ";
locks += "Run the focused vitest files you add or change. Do not start MENGSHU_RUN_LIVE_TESTS.";

phase("W1-Config");
let w1_prompt = locks;
w1_prompt += " Implement ONLY W1. Add config wiki.root (absolute, expand ~, default ~/.mengshu/wiki) plus the optional fields in " + DESIGN + " section 4: entriesDirName, writeEntriesOnPersist, indexUpdate, updateCompletion. ";
w1_prompt += "Put path resolve, ~ expansion, and the jail (resolve under root, .md only, reject .., absolute escape, and symlinks) in a new module packages/core/src/wiki/root.ts with a unit test. ";
w1_prompt += "Update config.ts, config.example.json, and docs/guides/configuration.md only as needed to document the key. ";
w1_prompt += "Do not create EntryWriter, indexes, MCP tools, or CLI commands. Do not edit packages/mcp/src/tools.ts or write-kernel.ts.";
let w1 = agent(w1_prompt, #{
    label: "w1-config",
    capability_mode: "all",
    output_schema: status_schema,
});
if w1 == () || w1.success != true {
    pause("verification", "W1 did not land wiki.root. Resume only after that module exists.");
}

phase("Core-Modules");
let w2_prompt = locks;
w2_prompt += " Implement ONLY W2 EntryWriter in NEW files packages/core/src/wiki/entry-writer.ts and entry-writer.test.ts. ";
w2_prompt += "Import the W1 root helper. Write pages/<scopeSlug>/entries/<semanticType>/<id>.md with the Track E frontmatter from " + DESIGN + " section 3.2. ";
w2_prompt += "Atomic tmp+rename. Scope or semanticType changes move the file. Never create or edit page-*.md or .sources. ";
w2_prompt += "Do not edit write-kernel.ts, tools.ts, ms.ts, config.ts, or any INDEX.md under a real wiki. No barrel index.ts.";
let w4_prompt = locks;
w4_prompt += " Implement ONLY W4 IndexMaintainer in NEW files packages/core/src/wiki/index-maintainer.ts and index-maintainer.test.ts. ";
w4_prompt += "On one entry path, patch only ancestor indexes: L3 type INDEX, L2 entries/INDEX.md, L1 pages/<slug>/INDEX.md, and the L0 Entries section of <wikiRoot>/INDEX.md. ";
w4_prompt += "Derive rows from the directory, stable sort, idempotent. Do not scan page-*.md bodies and do not rewrite the fused totals. ";
w4_prompt += "Do not edit entry-writer.ts, write-kernel.ts, tools.ts, or ms.ts.";
let w6_prompt = locks;
w6_prompt += " Implement ONLY the wiki file reader in NEW files packages/core/src/wiki/wiki-read.ts and wiki-read.test.ts. ";
w6_prompt += "Use the W1 jail. Allow any relative .md under wikiRoot, including fused pages and entries. Reject .., absolute paths, symlinks, non-md, and directories. Support maxChars truncation. ";
w6_prompt += "Do not register an MCP tool and do not edit packages/mcp/src/tools.ts or packages/api/src/cli/ms.ts.";
let core = parallel([
    #{ prompt: w2_prompt, label: "w2-entry-writer", capability_mode: "all", output_schema: status_schema },
    #{ prompt: w4_prompt, label: "w4-index", capability_mode: "all", output_schema: status_schema },
    #{ prompt: w6_prompt, label: "w6-reader", capability_mode: "all", output_schema: status_schema },
]);
let core_ok = 0;
for r in core {
    if r != () && r.success == true { core_ok += 1; }
}
log("core modules succeeded: " + core_ok.to_string() + "/3");
if core_ok != 3 {
    pause("verification", "Entry writer, index maintainer, and wiki reader must all exist before wiring.");
}

phase("Wire");
let w3_prompt = locks;
w3_prompt += " Implement ONLY W3. After a successful memories or knowledge persist in packages/core/src/service/write-kernel.ts (and the knowledge persist path if it does not go through that kernel), call EntryWriter then IndexMaintainer. ";
w3_prompt += "Set metadata.wikiPath to the relative path and optional wikiTrack=entry. Honor writeEntriesOnPersist=false. ";
w3_prompt += "If metadata.wikiPath already points at pages/.../page-NNN.md, do not write a second entry and do not edit that fused page. ";
w3_prompt += "Wiki IO failure logs and leaves the DB row committed. Add a focused test with a temp wiki root. ";
w3_prompt += "Do not edit packages/mcp/src/tools.ts or packages/api/src/cli/ms.ts.";
let w56_prompt = locks;
w56_prompt += " Implement W5 and W6 surfaces only. In packages/mcp/src/tools.ts, when a recall hit has metadata.wikiPath, show a relative wiki: line in text mode and wikiPath in raw mode. ";
w56_prompt += "Register memory_wiki_read that calls packages/core/src/wiki/wiki-read.ts. Add ms wiki read to packages/api/src/cli/ms.ts. ";
w56_prompt += "Tool text must say wiki_read is file drill-down and memory_knowledge_read stays the DB projection. ";
w56_prompt += "Do not edit write-kernel.ts. Add or extend unit tests for the formatter and the CLI/MCP rejection of ../ and non-md.";
let wired = parallel([
    #{ prompt: w3_prompt, label: "w3-persist", capability_mode: "all", output_schema: status_schema },
    #{ prompt: w56_prompt, label: "w5-w6-surface", capability_mode: "all", output_schema: status_schema },
]);
let wire_ok = 0;
for r in wired {
    if r != () && r.success == true { wire_ok += 1; }
}
log("wire agents succeeded: " + wire_ok.to_string() + "/2");
if wire_ok != 2 {
    pause("verification", "Persist hook and recall/read surfaces must both land.");
}

phase("Backfill-Docs");
let w7_prompt = locks;
w7_prompt += " Implement ONLY W7. Add ms wiki reindex entries and ms wiki backfill-entries. ";
w7_prompt += "backfill-entries defaults to dry-run. --apply writes pages/<slug>/entries files only for rows with no wikiPath or a missing file, skips rows whose wikiPath is pages/.../page-NNN.md, then reindexes entries. ";
w7_prompt += "Put the command in the CLI next to the existing ms wiki read registration. Add a unit test that uses a temp root and never opens ~/.mengshu. ";
w7_prompt += "Do not edit .agents/skills or docs/guides except a one-line CLI help string if the command file owns it.";
let w8_prompt = locks;
w8_prompt += " Implement ONLY W8 docs. Update .agents/skills/mengshu/SKILL.md and docs/guides so an agent sees: recall may include a relative wiki path; read the file with memory_wiki_read or ms wiki read; that is not memory_knowledge_read. ";
w8_prompt += "State Track F page-NNN versus Track E entries, and that wiki.root defaults to ~/.mengshu/wiki and can point at another absolute directory. ";
w8_prompt += "Do not edit TypeScript. Do not rewrite ~/.mengshu/wiki/USAGE.md in place; if the plan requires a USAGE appendix, add docs/guides/wiki-entries.md instead and link it from the skill.";
let tail = parallel([
    #{ prompt: w7_prompt, label: "w7-backfill", capability_mode: "all", output_schema: status_schema },
    #{ prompt: w8_prompt, label: "w8-docs", capability_mode: "all", output_schema: status_schema },
]);
let tail_ok = 0;
for r in tail {
    if r != () && r.success == true { tail_ok += 1; }
}
log("backfill/docs succeeded: " + tail_ok.to_string() + "/2");
if tail_ok != 2 {
    pause("verification", "Backfill CLI and docs must both land before review.");
}

phase("Review");
let sec_prompt = "Read the git diff on branch " + BRANCH + " with git diff and read_file. ";
sec_prompt += "Adversarially check only path safety of the new wiki reader and any root jail. ";
sec_prompt += "Set a finding only when you can quote the code that accepts .., a symlink, a non-md file, or a path outside wikiRoot. ";
sec_prompt += "Empty findings is valid after you have read wiki-read.ts and its test. Return at most 8 {file, issue, evidence}.";
let contract_prompt = "Read the git diff on branch " + BRANCH + ". ";
contract_prompt += "Adversarially check the Track E contract from " + DESIGN + ". ";
contract_prompt += "File a finding only with quoted evidence that the hot path edits page-NNN.md, writes absolute paths into metadata.wikiPath, rolls back a committed DB row when wiki IO fails, or creates a top-level material/ tree. ";
contract_prompt += "Empty findings is valid after reading the diff. Return at most 8 {file, issue, evidence}.";
let test_prompt = "Read the new wiki tests and run npx vitest on the wiki, recall formatter, and CLI files that this change added. ";
test_prompt += "File a finding only when a required behavior has no test or a test fails. Include the command output as evidence. ";
test_prompt += "Do not edit files. Return at most 8 {file, issue, evidence}.";
let reviews = parallel([
    #{ prompt: sec_prompt, label: "review-paths", capability_mode: "read-only", output_schema: verdict_schema },
    #{ prompt: contract_prompt, label: "review-contract", capability_mode: "read-only", output_schema: verdict_schema },
    #{ prompt: test_prompt, label: "review-tests", capability_mode: "execute", output_schema: verdict_schema },
]);

let findings = [];
for r in reviews {
    if r != () && r.success == true && r.output != () && r.output.findings != () {
        for f in r.output.findings {
            if f != () && f.evidence != () && f.evidence != "" { findings.push(f); }
        }
    }
}
log("evidenced findings: " + findings.len().to_string());

phase("Fix");
if findings.len() > 0 {
    let fix_prompt = locks;
    fix_prompt += " Apply ONLY the evidenced findings in this JSON. Do not invent extra refactors. Re-run the focused vitest files. Do not commit yet. JSON: ";
    fix_prompt += json_encode(findings);
    let fix = agent(fix_prompt, #{
        label: "fix",
        capability_mode: "all",
        output_schema: status_schema,
    });
    if fix == () || fix.success != true {
        pause("verification", "Fix agent did not apply the evidenced findings.");
    }
} else {
    log("no evidenced findings; skip fix");
}

phase("Report");
let report_prompt = "Inspect git status and git diff on branch " + BRANCH + ". ";
report_prompt += "If wiki.root, entry writer, index maintainer, persist hook, recall wikiPath, memory_wiki_read, ms wiki read, and backfill-entries are present and the focused tests you run pass, create ONE local commit. ";
report_prompt += "Do not push. Do not stage ~/.mengshu or secrets. ";
report_prompt += "Commit message: feat(wiki): add configurable wiki root and Track E entry material. ";
report_prompt += "If tests fail, do not commit. Return status committed or blocked plus evidence.";
let report = agent(report_prompt, #{
    label: "report",
    capability_mode: "all",
    output_schema: status_schema,
});

complete(#{
    summary: "wiki-entries finished",
    findings: findings.len(),
    report: report,
});
