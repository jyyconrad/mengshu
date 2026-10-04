let meta = #{
    name: "wiki-knowledge-governance",
    description: "Run exactly one phase of the knowledge wiki governance pipeline per invocation: read a unit of batches, verify excerpt coverage, regroup by scope, fuse a unit of parts, replace the knowledge table, or compile the run report",
    when_to_use: "Use when ~/.mengshu holds the frozen knowledge workset export and the pipeline must resume in bounded units. Pass args.phase plus that phase's parameters; a read run never triggers verify, regroup, fuse, or replace, and every read or fuse unit keeps a durable checkpoint.json so a rerun only processes unfinished batches or parts.",
    phases: [
        #{ title: "Read", detail: "One unit of batches into analysisDir with checkpoint.json" },
        #{ title: "Verify", detail: "Coverage, excerpt readback, path containment, and enhanced audit all green" },
        #{ title: "Regroup", detail: "Split merged analysis into by-scope parts.json" },
        #{ title: "Fuse", detail: "One unit of parts into page-NNN.md pages with .sources" },
        #{ title: "Replace", detail: "Apply only after a ready preflight receipt, with merged manifest provenance" },
        #{ title: "Report", detail: "Compile coverage and replacement report from runRoot artifacts" },
    ],
};

let read_schema = #{
    "type": "object",
    "required": ["filesRead", "filesExpected", "outputPath"],
    "properties": #{
        "filesRead": #{ "type": "integer" },
        "filesExpected": #{ "type": "integer" },
        "outputPath": #{ "type": "string" },
    },
};
let verify_schema = #{
    "type": "object",
    "required": ["passed", "evidence"],
    "properties": #{
        "passed": #{ "type": "boolean" },
        "evidence": #{ "type": "string" },
    },
};
let parts_schema = #{
    "type": "object",
    "required": ["parts"],
    "properties": #{
        "parts": #{
            "type": "array",
            "maxItems": 200,
            "items": #{
                "type": "object",
                "required": ["file", "scopeKey", "lines"],
                "properties": #{
                    "file": #{ "type": "string" },
                    "scopeKey": #{ "type": "string" },
                    "lines": #{ "type": "integer" },
                },
            },
        },
    },
};
let list_schema = #{
    "type": "object",
    "required": ["entries"],
    "properties": #{
        "entries": #{
            "type": "array",
            "maxItems": 120,
            "items": #{ "type": "integer" },
        },
    },
};
let fuse_manifest_schema = #{
    "type": "object",
    "required": ["totalParts", "parts"],
    "properties": #{
        "totalParts": #{ "type": "integer" },
        "parts": #{
            "type": "array",
            "maxItems": 48,
            "items": #{
                "type": "object",
                "required": ["index", "file", "scopeKey", "lines"],
                "properties": #{
                    "index": #{ "type": "integer" },
                    "file": #{ "type": "string" },
                    "scopeKey": #{ "type": "string" },
                    "lines": #{ "type": "integer" },
                },
            },
        },
    },
};
let checkpoint_read_schema = #{
    "type": "object",
    "required": ["checkpointPath", "exists", "completed", "failed"],
    "properties": #{
        "checkpointPath": #{ "type": "string" },
        "exists": #{ "type": "boolean" },
        "completed": #{
            "type": "array",
            "maxItems": 130,
            "items": #{
                "type": "object",
                "required": ["batch", "output", "lineCount", "sha256"],
                "properties": #{
                    "batch": #{ "type": "string" },
                    "output": #{ "type": "string" },
                    "lineCount": #{ "type": "integer" },
                    "sha256": #{ "type": "string" },
                },
            },
        },
        "failed": #{
            "type": "array",
            "maxItems": 130,
            "items": #{
                "type": "object",
                "required": ["batch", "reason"],
                "properties": #{
                    "batch": #{ "type": "string" },
                    "reason": #{ "type": "string" },
                },
            },
        },
    },
};
let checkpoint_fuse_schema = #{
    "type": "object",
    "required": ["checkpointPath", "exists", "completed", "failed"],
    "properties": #{
        "checkpointPath": #{ "type": "string" },
        "exists": #{ "type": "boolean" },
        "completed": #{
            "type": "array",
            "maxItems": 60,
            "items": #{
                "type": "object",
                "required": ["part", "pagesDir", "fileCount", "sourcesLines", "digest"],
                "properties": #{
                    "part": #{ "type": "string" },
                    "pagesDir": #{ "type": "string" },
                    "fileCount": #{ "type": "integer" },
                    "sourcesLines": #{ "type": "integer" },
                    "digest": #{ "type": "string" },
                },
            },
        },
        "failed": #{
            "type": "array",
            "maxItems": 60,
            "items": #{
                "type": "object",
                "required": ["part", "reason"],
                "properties": #{
                    "part": #{ "type": "string" },
                    "reason": #{ "type": "string" },
                },
            },
        },
    },
};
let fuse_schema = #{
    "type": "object",
    "required": ["pages", "sourceIds"],
    "properties": #{
        "pages": #{ "type": "integer" },
        "sourceIds": #{ "type": "integer" },
    },
};
let apply_schema = #{
    "type": "object",
    "required": ["status", "evidence"],
    "properties": #{
        "status": #{ "type": "string" },
        "evidence": #{ "type": "string" },
    },
};
let audit_schema = #{
    "type": "object",
    "required": ["claims", "valid", "invalid", "missingIds"],
    "properties": #{
        "claims": #{ "type": "integer" },
        "valid": #{ "type": "integer" },
        "invalid": #{ "type": "integer" },
        "missingIds": #{ "type": "integer" },
    },
};
let preflight_schema = #{
    "type": "object",
    "required": ["status", "preflightPath"],
    "properties": #{
        "status": #{ "type": "string" },
        "preflightPath": #{ "type": "string" },
    },
};
let report_schema = #{
    "type": "object",
    "required": ["status", "reportPath", "evidence"],
    "properties": #{
        "status": #{ "type": "string" },
        "reportPath": #{ "type": "string" },
        "evidence": #{ "type": "string" },
    },
};

fn is_map(v) { v != () && type_of(v) == "map" }
fn is_array(v) { v != () && type_of(v) == "array" }
fn is_string(v) { v != () && type_of(v) == "string" }
fn is_int(v) {
    if v == () { return false; }
    let t = type_of(v);
    t == "i64" || t == "i32" || t == "u64" || t == "u32"
}
fn blank(v) {
    if !is_string(v) { return true; }
    let s = v;
    s.trim();
    s == ""
}
fn as_int(v, fallback) {
    if is_int(v) { return v; }
    if v != () && type_of(v) == "f64" { return v.to_int(); }
    fallback
}
fn pad4(n) {
    let s = n.to_string();
    if s.len() >= 4 { return s; }
    let zeros = "0000";
    zeros.sub_string(0, 4 - s.len()) + s
}
fn has_dot_segment(p) {
    if !is_string(p) { return true; }
    let seg = "";
    let i = 0;
    let n = p.len();
    let hit = false;
    while i <= n {
        let ch = "";
        if i < n { ch = p.sub_string(i, 1); }
        if ch == "/" || i == n {
            if seg == ".." || seg == "." { hit = true; }
            seg = "";
        } else {
            seg += ch;
        }
        i += 1;
    }
    hit
}
fn under_root(path, root) {
    if !is_string(path) || !is_string(root) || root == "" || path.len() < root.len() { return false; }
    // 词法前缀不足以构成 containment：任何 "." / ".." 段都可能越过 root 边界，一律拒绝。
    if has_dot_segment(path) || has_dot_segment(root) { return false; }
    let rooted = root;
    if root.sub_string(root.len() - 1, 1) != "/" { rooted = root + "/"; }
    if path == root { return true; }
    if path.len() < rooted.len() { return false; }
    path.sub_string(0, rooted.len()) == rooted
}
fn is_abs(p) {
    is_string(p) && p.len() > 0 && p.sub_string(0, 1) == "/"
}
fn found(hay, needle) {
    if !is_string(hay) || !is_string(needle) { return false; }
    let at = hay.index_of(needle);
    is_int(at) && at >= 0
}
fn ends_with(s, tail) {
    if !is_string(s) || !is_string(tail) || tail.len() == 0 || s.len() < tail.len() { return false; }
    s.sub_string(s.len() - tail.len(), tail.len()) == tail
}
fn parse_uint(s) {
    if !is_string(s) { return -1; }
    let t = s;
    t.trim();
    if t.len() == 0 || t.len() > 9 { return -1; }
    let digits = "0123456789";
    let n = 0;
    let i = 0;
    while i < t.len() {
        let at = digits.index_of(t.sub_string(i, 1));
        if !is_int(at) || at < 0 { return -1; }
        n = n * 10 + at;
        i += 1;
    }
    n
}
fn parse_range(spec) {
    if !is_string(spec) { return (); }
    let s = spec;
    s.trim();
    if s == "" { return (); }
    let dash = s.index_of("-");
    if !is_int(dash) || dash < 0 {
        let only = parse_uint(s);
        if only < 0 { return (); }
        return #{ start: only, end: only };
    }
    let start = parse_uint(s.sub_string(0, dash));
    let end = parse_uint(s.sub_string(dash + 1, s.len() - dash - 1));
    if start < 0 || end < 0 || start > end { return (); }
    #{ start: start, end: end }
}
fn range_indices(start, end) {
    let out = [];
    let i = start;
    while i <= end {
        out.push(i);
        i += 1;
    }
    out
}
fn contains_str(list, v) {
    if !is_array(list) || !is_string(v) { return false; }
    for item in list {
        if item == v { return true; }
    }
    false
}
fn contains_int(list, v) {
    if !is_array(list) || !is_int(v) { return false; }
    for item in list {
        if item == v { return true; }
    }
    false
}
fn batch_expected(index, totalBatches, fullBatchSize, totalFiles) {
    if index == totalBatches - 1 {
        return totalFiles - (totalBatches - 1) * fullBatchSize;
    }
    fullBatchSize
}
fn batch_name(index, expected) {
    "batch-" + pad4(index) + "-n" + expected.to_string() + ".txt"
}

if !under_root("/a/b/c.jsonl", "/a/b") { throw "under_root rejected a child path"; }
if under_root("/a/bc/c.jsonl", "/a/b") { throw "under_root accepted a prefix collision"; }
if under_root("/etc/passwd", "/a/b") { throw "under_root accepted an outside path"; }
if !under_root("/a/b", "/a/b") { throw "under_root rejected the root itself"; }
if under_root("/a/b/../c.jsonl", "/a/b") { throw "under_root accepted a .. escape"; }
if under_root("/a/b/c/../../d.jsonl", "/a/b") { throw "under_root accepted a nested .. escape"; }
if under_root("/a/./b/c.jsonl", "/a") { throw "under_root accepted a . segment"; }
if under_root("/a/b/c.jsonl", "/a/../a") { throw "under_root accepted a root with .."; }
if !has_dot_segment("..") || !has_dot_segment("/a/./b") || has_dot_segment("run-01") || has_dot_segment("/a/b/c") || has_dot_segment("") { throw "has_dot_segment is wrong"; }
if !is_abs("/a/b") || is_abs("a/b") || is_abs("") { throw "is_abs is wrong"; }
if parse_uint("0104") != 104 || parse_uint("0") != 0 || parse_uint("abc") != -1 || parse_uint("") != -1 || parse_uint("-1") != -1 || parse_uint("1234567890") != -1 { throw "parse_uint is wrong"; }
let probe_range = parse_range("0104-0207");
if probe_range == () || probe_range.start != 104 || probe_range.end != 207 { throw "parse_range failed a normal range"; }
let probe_single = parse_range("7");
if probe_single == () || probe_single.start != 7 || probe_single.end != 7 { throw "parse_range failed a single index"; }
if parse_range("51-12") != () { throw "parse_range accepted an inverted range"; }
if parse_range("a-b") != () { throw "parse_range accepted non-numeric bounds"; }
if parse_range("") != () { throw "parse_range accepted an empty spec"; }
let probe_indices = range_indices(2, 5);
if probe_indices.len() != 4 || probe_indices[0] != 2 || probe_indices[3] != 5 { throw "range_indices is wrong"; }
if pad4(7) != "0007" || pad4(1234) != "1234" { throw "pad4 is wrong"; }
if batch_name(104, 60) != "batch-0104-n60.txt" { throw "batch_name is wrong"; }
if batch_expected(825, 826, 60, 49509) != 9 || batch_expected(0, 826, 60, 49509) != 60 { throw "batch_expected is wrong"; }
if !contains_str(["a"], "a") || contains_str(["a"], "b") { throw "contains_str is wrong"; }
if !contains_int([3], 3) || contains_int([3], 4) { throw "contains_int is wrong"; }
if !ends_with("page-001.md", ".md") || ends_with("page-001.md", ".sources") { throw "ends_with is wrong"; }
if !found("npx tsx scan", " scan ") || found("migrate-semantic-types", "activate-import") { throw "found is wrong"; }

let phaseName = if args == () { () } else { args.phase };
if !is_string(phaseName) || blank(phaseName) {
    pause("verification", "Pass args.phase as read, verify, regroup, fuse, replace, or report.");
    complete(#{ status: "blocked", reason: "args.phase is missing" });
}
let p = phaseName;
p.trim();
if p != "read" && p != "verify" && p != "regroup" && p != "fuse" && p != "replace" && p != "report" {
    pause("verification", "args.phase must be read, verify, regroup, fuse, replace, or report; got " + p + ".");
    complete(#{ status: "blocked", reason: "args.phase was not a known phase" });
}
let repo = if args == () { () } else { args.repo };
let runRoot = if args == () { () } else { args.runRoot };
if !is_string(repo) || blank(repo) || !is_abs(repo) {
    pause("verification", "Pass args.repo as the absolute Mengshu repository path.");
    complete(#{ status: "blocked", reason: "args.repo is missing or not absolute" });
}
if !is_string(runRoot) || blank(runRoot) || !is_abs(runRoot) {
    pause("verification", "Pass args.runRoot as the absolute run root, for example /Users/you/.mengshu/wiki-governance/2026-10-04-rerun.");
    complete(#{ status: "blocked", reason: "args.runRoot is missing or not absolute" });
}

log("phase=" + p + " runRoot=" + runRoot);

if p == "read" {
    let batchDir = args.batchDir;
    let analysisDir = args.analysisDir;
    let batchListSpec = args.batchList;
    if !is_string(batchDir) || blank(batchDir) || !is_abs(batchDir) {
        pause("verification", "phase read needs args.batchDir as the absolute frozen batches directory.");
        complete(#{ status: "blocked", reason: "args.batchDir is missing or not absolute" });
    }
    if !is_string(analysisDir) || blank(analysisDir) || !is_abs(analysisDir) {
        pause("verification", "phase read needs args.analysisDir as this unit's absolute analysis output directory.");
        complete(#{ status: "blocked", reason: "args.analysisDir is missing or not absolute" });
    }
    if !under_root(analysisDir, runRoot) {
        pause("verification", "args.analysisDir must stay under args.runRoot; declare a new run root instead of writing elsewhere.");
        complete(#{ status: "blocked", reason: "args.analysisDir escaped args.runRoot" });
    }
    if !is_string(batchListSpec) || blank(batchListSpec) {
        pause("verification", "phase read needs args.batchList: an absolute list file under runRoot or a start-end range like 0104-0207.");
        complete(#{ status: "blocked", reason: "args.batchList is missing" });
    }
    let totalFiles = as_int(args.totalFiles, 0);
    let totalBatches = as_int(args.totalBatches, 0);
    let fullBatchSize = as_int(args.fullBatchSize, 0);
    let expectedCount = as_int(args.expectedCount, 0);
    if totalFiles < 1 || totalBatches < 1 || fullBatchSize < 1 || expectedCount != totalFiles {
        pause("verification", "args.totalFiles, args.totalBatches, args.fullBatchSize, and args.expectedCount must describe the same frozen knowledge set.");
        complete(#{ status: "blocked", reason: "frozen counts were inconsistent" });
    }
    if batch_expected(totalBatches - 1, totalBatches, fullBatchSize, totalFiles) < 1 {
        pause("verification", "the frozen counts leave an empty last batch; re-check totalFiles, totalBatches, and fullBatchSize.");
        complete(#{ status: "blocked", reason: "frozen counts leave an empty last batch" });
    }
    let waveSize = as_int(args.waveSize, 24);
    if waveSize < 1 { waveSize = 1; }
    if waveSize > 24 {
        log("capped waveSize at 24");
        waveSize = 24;
    }
    let budgetReserve = as_int(args.budgetReserve, 140);
    if budgetReserve < 10 { budgetReserve = 10; }
    let ckptPath = analysisDir + "/checkpoint.json";

    let requested = [];
    let unitLabel = "";
    if is_abs(batchListSpec) {
        if !under_root(batchListSpec, runRoot) {
            pause("verification", "an args.batchList file must live under args.runRoot.");
            complete(#{ status: "blocked", reason: "args.batchList file escaped args.runRoot" });
        }
        let listPrompt = "Read one Mengshu wiki governance batch selection file: " + batchListSpec + ". ";
        listPrompt += "Use read_file or the shell. Every non-empty line holds either a batch index such as 0104 ";
        listPrompt += "or a batch file name such as batch-0104-n60.txt. Lines starting with # are comments. ";
        listPrompt += "Return the integer batch index of every selected line in file order. ";
        listPrompt += "Do not invent indices, do not reorder, and do not modify the file.";
        let listed = agent(listPrompt, #{
            label: "read:list-batches",
            capability_mode: "read-only",
            output_schema: list_schema,
        });
        if listed == () || listed.success != true || !is_map(listed.output) || !is_array(listed.output.entries) || listed.output.entries.len() == 0 {
            pause("verification", "The batchList file was unreadable or selected no batches: " + batchListSpec + ".");
            complete(#{ status: "blocked", reason: "args.batchList file was unreadable or empty" });
        }
        for entry in listed.output.entries {
            if !is_int(entry) || entry < 0 || entry >= totalBatches {
                pause("verification", "args.batchList contained an index outside 0.." + (totalBatches - 1).to_string() + ".");
                complete(#{ status: "blocked", reason: "args.batchList entry was out of range" });
            }
            if !contains_int(requested, entry) {
                if requested.len() >= 104 {
                    pause("verification", "A read run may cover at most 104 batches; split the batchList file across runs.");
                    complete(#{ status: "blocked", reason: "args.batchList selected more than 104 batches" });
                }
                requested.push(entry);
            }
        }
        unitLabel = "list";
    } else {
        let range = parse_range(batchListSpec);
        if range == () {
            pause("verification", "args.batchList must be an absolute list file under runRoot or a start-end range like 0104-0207.");
            complete(#{ status: "blocked", reason: "args.batchList was not a usable range or list file" });
        }
        if range.start < 0 || range.end >= totalBatches {
            pause("verification", "args.batchList range must stay inside 0.." + (totalBatches - 1).to_string() + ".");
            complete(#{ status: "blocked", reason: "args.batchList range was out of bounds" });
        }
        if range.end - range.start + 1 > 104 {
            pause("verification", "A read run may cover at most 104 batches; split the range across runs.");
            complete(#{ status: "blocked", reason: "args.batchList range covered more than 104 batches" });
        }
        requested = range_indices(range.start, range.end);
        unitLabel = range.start.to_string() + "-" + range.end.to_string();
    }

    phase("Read");
    log("read unit " + unitLabel + " batches=" + requested.len().to_string());

    let resumePrompt = "Read the durable checkpoint of one Mengshu wiki governance read unit: " + ckptPath + ". ";
    resumePrompt += "Use read_file or the shell. If the file exists and parses as JSON, return exists true and the completed and failed arrays exactly as recorded. ";
    resumePrompt += "If it does not exist, return exists false with empty arrays. ";
    resumePrompt += "If it exists but does not parse, return exists true with empty arrays. ";
    resumePrompt += "checkpointPath must be " + ckptPath + ". Do not modify anything.";
    let resumed = agent(resumePrompt, #{
        label: "read:resume",
        capability_mode: "read-only",
        output_schema: checkpoint_read_schema,
    });
    let completedNames = [];
    if resumed != () && resumed.success == true && is_map(resumed.output) && resumed.output.checkpointPath == ckptPath {
        if is_array(resumed.output.completed) {
            for entry in resumed.output.completed {
                if is_map(entry) && is_string(entry.batch) && is_string(entry.output) && under_root(entry.output, analysisDir) {
                    completedNames.push(entry.batch);
                }
            }
        }
    } else {
        log("resume checkpoint was unreadable; completed batches will be redone safely");
    }

    let skippedThisRun = [];
    while true {
        let pending = [];
        for idx in requested {
            let expected = batch_expected(idx, totalBatches, fullBatchSize, totalFiles);
            let name = batch_name(idx, expected);
            if !contains_str(completedNames, name) && !contains_str(skippedThisRun, name) {
                pending.push(#{
                    index: idx,
                    name: name,
                    expected: expected,
                });
            }
        }
        if pending.len() == 0 { break; }
        if budget().remaining < budgetReserve {
            log("budget reserve reached with " + pending.len().to_string() + " batches unfinished");
            complete(#{
                status: "blocked",
                reason: "agent budget reserve reached before the read unit finished",
                phase: "read",
                unit: unitLabel,
                checkpointPath: ckptPath,
                requestedBatches: requested.len(),
                completedBatches: completedNames.len(),
                pendingBatches: pending.len(),
            });
        }
        let jobs = [];
        let waveMap = [];
        let w = 0;
        while w < waveSize && w < pending.len() {
            let item = pending[w];
            let outputPath = analysisDir + "/" + item.name + ".jsonl";
            let prompt = "Read every knowledge markdown file listed in " + batchDir + "/" + item.name + ". ";
            prompt += "The batch has " + item.expected.to_string() + " lines. Each line is an absolute path, a tab, and a scope_key. ";
            prompt += "For every line, print only the markdown body after the second frontmatter fence and ignore mengshu_envelope. ";
            prompt += "A short node or python print of that body is enough. You must see each body before classifying it. ";
            prompt += "Write one JSON object per file, in batch order, to " + outputPath + ".tmp and then atomically rename it to " + outputPath + ". ";
            prompt += "Never append to an existing " + outputPath + " and never leave a .tmp file behind. ";
            prompt += "Fields: id, path, scopeKey, semanticType, memoryForm, treeType, topic, title, summary, evidenceNote, excerpt. ";
            prompt += "id is the filename uuid. semanticType is profile, task_context, rules, experience, resource, or unclassified. ";
            prompt += "memoryForm is event, fact, semantic, procedural, or unknown. treeType is source, topic, global, or none. ";
            prompt += "experience requires evidenceNote. excerpt is a verbatim slice of at least 12 characters from that file body. ";
            prompt += "Do not invent text, do not paste envelopes, and do not drop a file. ";
            prompt += "Return filesRead " + item.expected.to_string() + ", filesExpected " + item.expected.to_string();
            prompt += ", and outputPath exactly " + outputPath + ".";
            jobs.push(#{
                prompt: prompt,
                label: "read:" + item.index.to_string(),
                capability_mode: "read-write",
                output_schema: read_schema,
            });
            waveMap.push(#{
                index: item.index,
                name: item.name,
                expected: item.expected,
                output: outputPath,
            });
            w += 1;
        }
        let results = parallel(jobs);
        let payload = [];
        let slot = 0;
        for result in results {
            let m = waveMap[slot];
            let ok = result != () && result.success == true && is_map(result.output) && result.output.filesRead == m.expected && result.output.outputPath == m.output;
            payload.push(#{
                batch: m.name,
                expected: m.expected,
                output: m.output,
                ok: ok,
            });
            slot += 1;
        }
        let updatePrompt = "Update the durable checkpoint of one Mengshu wiki governance read unit. ";
        updatePrompt += "Checkpoint file: " + ckptPath + ". Analysis directory: " + analysisDir + ". ";
        updatePrompt += "Wave payload JSON follows. For every entry with ok true: the output file must exist at entry.output with exactly entry.expected non-empty lines; compute its sha256 with shasum -a 256. ";
        updatePrompt += "A missing file or a wrong line count marks that batch failed with the reason; never count it completed. ";
        updatePrompt += "For entries with ok false record the batch as failed. ";
        updatePrompt += "Merge with the existing checkpoint: keep completed entries from earlier waves, move a previously failed batch that now passes into completed, and keep failed entries that did not pass. ";
        updatePrompt += "Write the merged JSON with keys checkpointPath, exists true, completed, failed to " + ckptPath + ".tmp and atomically rename it over " + ckptPath + ". ";
        updatePrompt += "completed items need batch, output, lineCount, and sha256. failed items need batch and reason. ";
        updatePrompt += "Do not touch any file outside " + analysisDir + ". Return the merged checkpoint. Payload: ";
        updatePrompt += json_encode(payload);
        let updated = agent(updatePrompt, #{
            label: "read:checkpoint",
            capability_mode: "execute",
            output_schema: checkpoint_read_schema,
        });
        if updated == () || updated.success != true || !is_map(updated.output) || updated.output.checkpointPath != ckptPath {
            complete(#{
                status: "blocked",
                reason: "checkpoint update failed; this wave is not counted as success",
                phase: "read",
                unit: unitLabel,
                checkpointPath: ckptPath,
                pendingBatches: pending.len(),
            });
        }
        completedNames = [];
        if is_array(updated.output.completed) {
            for entry in updated.output.completed {
                if is_map(entry) && is_string(entry.batch) && is_string(entry.output) && under_root(entry.output, analysisDir) {
                    completedNames.push(entry.batch);
                }
            }
        }
        for entry in payload {
            if !contains_str(completedNames, entry.batch) {
                skippedThisRun.push(entry.batch);
                log("batch stays failed this run: " + entry.batch);
            }
        }
    }

    let doneCount = 0;
    let readTotal = 0;
    for idx in requested {
        let expected = batch_expected(idx, totalBatches, fullBatchSize, totalFiles);
        let name = batch_name(idx, expected);
        if contains_str(completedNames, name) {
            doneCount += 1;
            readTotal += expected;
        }
    }
    if doneCount == requested.len() {
        complete(#{
            status: "completed",
            summary: "read unit " + unitLabel + " finished " + doneCount.to_string() + " batches (" + readTotal.to_string() + " files)",
            phase: "read",
            unit: unitLabel,
            requestedBatches: requested.len(),
            completedBatches: doneCount,
            filesRead: readTotal,
            checkpointPath: ckptPath,
        });
    }
    complete(#{
        status: "blocked",
        reason: "some requested batches did not complete; rerun this same unit to retry only the unfinished batches",
        phase: "read",
        unit: unitLabel,
        requestedBatches: requested.len(),
        completedBatches: doneCount,
        filesRead: readTotal,
        checkpointPath: ckptPath,
        pendingBatches: requested.len() - doneCount,
    });
} else if p == "verify" {
    let analysisDir = args.analysisDir;
    let beforeIds = args.beforeIds;
    let manifestPath = args.manifest;
    let templatesPath = args.templates;
    if !is_string(analysisDir) || blank(analysisDir) || !is_abs(analysisDir) {
        pause("verification", "phase verify needs args.analysisDir as the absolute merged analysis directory.");
        complete(#{ status: "blocked", reason: "args.analysisDir is missing or not absolute" });
    }
    if !under_root(analysisDir, runRoot) {
        pause("verification", "args.analysisDir must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.analysisDir escaped args.runRoot" });
    }
    if !is_string(beforeIds) || blank(beforeIds) || !is_abs(beforeIds) {
        pause("verification", "phase verify needs args.beforeIds as the absolute before-ids file.");
        complete(#{ status: "blocked", reason: "args.beforeIds is missing or not absolute" });
    }
    if !is_string(manifestPath) || blank(manifestPath) || !is_abs(manifestPath) {
        pause("verification", "phase verify needs args.manifest as the frozen source-manifest.jsonl under runRoot; the verify command uses it for path containment.");
        complete(#{ status: "blocked", reason: "args.manifest is missing or not absolute" });
    }
    if !under_root(manifestPath, runRoot) {
        pause("verification", "args.manifest must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.manifest escaped args.runRoot" });
    }
    if !is_string(templatesPath) || blank(templatesPath) || !is_abs(templatesPath) || !ends_with(templatesPath, ".json") {
        pause("verification", "phase verify needs args.templates as the absolute scope-templates.json under runRoot; the enhanced audit uses it for scope checks.");
        complete(#{ status: "blocked", reason: "args.templates is missing or not an absolute .json path" });
    }
    if !under_root(templatesPath, runRoot) {
        pause("verification", "args.templates must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.templates escaped args.runRoot" });
    }
    phase("Verify");
    let verifyPrompt = "In " + repo + ", run npx tsx scripts/operator-wiki-knowledge-replace.ts verify --analysis ";
    verifyPrompt += analysisDir + " --before-ids " + beforeIds + " --manifest " + manifestPath + ". ";
    verifyPrompt += "The command re-reads every source and enforces path containment against the frozen manifest. ";
    verifyPrompt += "Set passed true only when the command exits 0. evidence must quote its JSON. Do not apply or delete anything.";
    let verified = agent(verifyPrompt, #{
        label: "verify:excerpts",
        capability_mode: "execute",
        output_schema: verify_schema,
    });
    if verified == () || verified.success != true || !is_map(verified.output) || verified.output.passed != true {
        complete(#{ status: "blocked", reason: "excerpt or path verification did not pass", phase: "verify" });
    }
    // 增强 audit：同一 analysis 上重读来源、复核 hash/excerpt/scope/枚举（计划批次 4）。
    let auditOut = runRoot + "/verify-audit";
    let auditPrompt = "In " + repo + ", run npx tsx scripts/operator-wiki-knowledge-replace.ts audit --analysis ";
    auditPrompt += analysisDir + " --manifest " + manifestPath + " --before-ids " + beforeIds;
    auditPrompt += " --templates " + templatesPath + " --out " + auditOut + ". ";
    auditPrompt += "The command re-reads every frozen source, re-checks hashes, excerpts, scopes, enums and batch provenance. ";
    auditPrompt += "Return claims, valid, invalid, and missingIds exactly as printed by the command JSON. Do not modify the database.";
    let audited = agent(auditPrompt, #{
        label: "verify:audit",
        capability_mode: "execute",
        output_schema: audit_schema,
    });
    if audited == () || audited.success != true || !is_map(audited.output) || !is_int(audited.output.claims) || !is_int(audited.output.valid) || !is_int(audited.output.invalid) || !is_int(audited.output.missingIds) {
        complete(#{ status: "blocked", reason: "the enhanced audit did not return a readable summary", phase: "verify" });
    }
    if audited.output.invalid != 0 || audited.output.missingIds != 0 || audited.output.valid != audited.output.claims {
        complete(#{
            status: "blocked",
            reason: "the enhanced audit found invalid records or missing ids (claims=" + audited.output.claims.to_string() + " valid=" + audited.output.valid.to_string() + " invalid=" + audited.output.invalid.to_string() + " missingIds=" + audited.output.missingIds.to_string() + ")",
            phase: "verify",
        });
    }
    complete(#{
        status: "completed",
        summary: "verify passed for " + analysisDir + ": coverage, excerpt readback, path containment, source hash, scope and enums",
        phase: "verify",
        evidence: verified.output.evidence,
        audit: #{
            claims: audited.output.claims,
            valid: audited.output.valid,
            invalid: audited.output.invalid,
            missingIds: audited.output.missingIds,
        },
    });
} else if p == "regroup" {
    let analysisDir = args.analysisDir;
    let byScopeDir = args.byScopeDir;
    if !is_string(analysisDir) || blank(analysisDir) || !is_abs(analysisDir) {
        pause("verification", "phase regroup needs args.analysisDir as the absolute merged analysis directory.");
        complete(#{ status: "blocked", reason: "args.analysisDir is missing or not absolute" });
    }
    if !under_root(analysisDir, runRoot) {
        pause("verification", "args.analysisDir must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.analysisDir escaped args.runRoot" });
    }
    if !is_string(byScopeDir) || blank(byScopeDir) || !is_abs(byScopeDir) {
        pause("verification", "phase regroup needs args.byScopeDir as the absolute by-scope output directory.");
        complete(#{ status: "blocked", reason: "args.byScopeDir is missing or not absolute" });
    }
    if !under_root(byScopeDir, runRoot) {
        pause("verification", "args.byScopeDir must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.byScopeDir escaped args.runRoot" });
    }
    phase("Regroup");
    let regroupPrompt = "In " + repo + ", run npx tsx scripts/operator-wiki-knowledge-replace.ts regroup --analysis ";
    regroupPrompt += analysisDir + " --out " + byScopeDir + ". ";
    regroupPrompt += "Then read " + byScopeDir + "/parts.json and return every part. Do not edit the database.";
    let regrouped = agent(regroupPrompt, #{
        label: "regroup:scopes",
        capability_mode: "execute",
        output_schema: parts_schema,
    });
    if regrouped == () || regrouped.success != true || !is_map(regrouped.output) || !is_array(regrouped.output.parts) || regrouped.output.parts.len() == 0 {
        complete(#{ status: "blocked", reason: "scope regroup produced no parts", phase: "regroup" });
    }
    for part in regrouped.output.parts {
        if !is_map(part) || !is_string(part.file) || !under_root(part.file, byScopeDir) {
            complete(#{ status: "blocked", reason: "a regroup part was outside the scope directory", phase: "regroup" });
        }
    }
    complete(#{
        status: "completed",
        summary: "regroup produced " + regrouped.output.parts.len().to_string() + " scope parts in " + byScopeDir,
        phase: "regroup",
        parts: regrouped.output.parts.len(),
        partsJson: byScopeDir + "/parts.json",
    });
} else if p == "fuse" {
    let byScopeDir = args.byScopeDir;
    let wikiRoot = args.wikiRoot;
    let partListSpec = args.partList;
    let configPath = args.config;
    if !is_string(byScopeDir) || blank(byScopeDir) || !is_abs(byScopeDir) {
        pause("verification", "phase fuse needs args.byScopeDir as the absolute by-scope directory produced by regroup.");
        complete(#{ status: "blocked", reason: "args.byScopeDir is missing or not absolute" });
    }
    if !under_root(byScopeDir, runRoot) {
        pause("verification", "args.byScopeDir must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.byScopeDir escaped args.runRoot" });
    }
    if !is_string(wikiRoot) || blank(wikiRoot) || !is_abs(wikiRoot) {
        pause("verification", "phase fuse needs args.wikiRoot as the absolute wiki root; pages go under wikiRoot/final/part-NNNN.");
        complete(#{ status: "blocked", reason: "args.wikiRoot is missing or not absolute" });
    }
    if !under_root(wikiRoot, runRoot) {
        pause("verification", "args.wikiRoot must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.wikiRoot escaped args.runRoot" });
    }
    if !is_string(configPath) || blank(configPath) || !is_abs(configPath) || !ends_with(configPath, ".json") {
        pause("verification", "phase fuse needs args.config as the absolute global provider config JSON path.");
        complete(#{ status: "blocked", reason: "args.config is missing or not an absolute .json path" });
    }
    if !is_string(partListSpec) || blank(partListSpec) {
        pause("verification", "phase fuse needs args.partList: an absolute list file under runRoot or byScopeDir, or a start-end range like 0-39.");
        complete(#{ status: "blocked", reason: "args.partList is missing" });
    }
    let waveSize = as_int(args.waveSize, 12);
    if waveSize < 1 { waveSize = 1; }
    if waveSize > 24 {
        log("capped waveSize at 24");
        waveSize = 24;
    }
    let budgetReserve = as_int(args.budgetReserve, 30);
    if budgetReserve < 10 { budgetReserve = 10; }

    let requestedParts = [];
    let fuseUnit = "";
    if is_abs(partListSpec) {
        if !under_root(partListSpec, runRoot) && !under_root(partListSpec, byScopeDir) {
            pause("verification", "an args.partList file must live under args.runRoot or args.byScopeDir.");
            complete(#{ status: "blocked", reason: "args.partList file escaped the declared roots" });
        }
        let listPrompt = "Read one Mengshu wiki governance part selection file: " + partListSpec + ". ";
        listPrompt += "Use read_file or the shell. Every non-empty line holds one part index such as 012. ";
        listPrompt += "Lines starting with # are comments. Return the integer part index of every selected line in file order. ";
        listPrompt += "Do not invent indices and do not modify the file.";
        let listed = agent(listPrompt, #{
            label: "fuse:list-parts",
            capability_mode: "read-only",
            output_schema: list_schema,
        });
        if listed == () || listed.success != true || !is_map(listed.output) || !is_array(listed.output.entries) || listed.output.entries.len() == 0 {
            pause("verification", "The partList file was unreadable or selected no parts: " + partListSpec + ".");
            complete(#{ status: "blocked", reason: "args.partList file was unreadable or empty" });
        }
        for entry in listed.output.entries {
            if !is_int(entry) || entry < 0 {
                pause("verification", "args.partList contained a negative or non-integer part index.");
                complete(#{ status: "blocked", reason: "args.partList entry was invalid" });
            }
            if !contains_int(requestedParts, entry) {
                if requestedParts.len() >= 40 {
                    pause("verification", "A fuse run may cover at most 40 parts; split the partList file across runs.");
                    complete(#{ status: "blocked", reason: "args.partList selected more than 40 parts" });
                }
                requestedParts.push(entry);
            }
        }
        fuseUnit = "list";
    } else {
        let range = parse_range(partListSpec);
        if range == () {
            pause("verification", "args.partList must be an absolute list file or a start-end range like 0-39.");
            complete(#{ status: "blocked", reason: "args.partList was not a usable range or list file" });
        }
        if range.start < 0 {
            pause("verification", "args.partList range must start at 0 or later.");
            complete(#{ status: "blocked", reason: "args.partList range was negative" });
        }
        if range.end - range.start + 1 > 40 {
            pause("verification", "A fuse run may cover at most 40 parts; split the range across runs.");
            complete(#{ status: "blocked", reason: "args.partList range covered more than 40 parts" });
        }
        requestedParts = range_indices(range.start, range.end);
        fuseUnit = range.start.to_string() + "-" + range.end.to_string();
    }
    let unitArg = args.unit;
    if is_string(unitArg) && !blank(unitArg) {
        if found(unitArg, " ") || found(unitArg, "/") || has_dot_segment(unitArg) {
            pause("verification", "args.unit must be a short label without spaces, slashes, or dot segments; \"..\" would move the checkpoint outside runRoot/fuse/<unit>.");
            complete(#{ status: "blocked", reason: "args.unit was not a plain label" });
        }
        fuseUnit = unitArg;
    }
    let unitRoot = runRoot + "/fuse/" + fuseUnit;
    let fuseCkptPath = unitRoot + "/checkpoint.json";

    phase("Fuse");
    log("fuse unit " + fuseUnit + " parts=" + requestedParts.len().to_string());

    let manifestPrompt = "Read the Mengshu wiki governance part manifest: " + byScopeDir + "/parts.json. ";
    manifestPrompt += "It is a JSON array ordered by part index starting at 0; each item has file, scopeKey, and lines. ";
    manifestPrompt += "Requested part indices in JSON: " + json_encode(requestedParts) + ". ";
    manifestPrompt += "Return totalParts as the array length and, for every requested index that exists, the item copied verbatim plus index as its position in the array. ";
    manifestPrompt += "Skip requested indices beyond the end of the array. Do not modify anything.";
    let manifest = agent(manifestPrompt, #{
        label: "fuse:manifest",
        capability_mode: "read-only",
        output_schema: fuse_manifest_schema,
    });
    if manifest == () || manifest.success != true || !is_map(manifest.output) || !is_int(manifest.output.totalParts) || !is_array(manifest.output.parts) {
        complete(#{
            status: "blocked",
            reason: "the part manifest could not be read from " + byScopeDir + "/parts.json",
            phase: "fuse",
            unit: fuseUnit,
        });
    }
    let totalParts = manifest.output.totalParts;
    for idx in requestedParts {
        if idx >= totalParts {
            pause("verification", "args.partList requested part " + idx.to_string() + " but parts.json only has " + totalParts.to_string() + " parts.");
            complete(#{ status: "blocked", reason: "args.partList was out of range for parts.json" });
        }
    }
    let partEntries = [];
    let seenPartIndices = [];
    for part in manifest.output.parts {
        if !is_map(part) || !is_int(part.index) || !is_string(part.file) || !is_string(part.scopeKey) || !is_int(part.lines) {
            complete(#{ status: "blocked", reason: "a manifest part entry was malformed", phase: "fuse", unit: fuseUnit });
        }
        if !contains_int(requestedParts, part.index) {
            complete(#{ status: "blocked", reason: "the manifest returned a part that was not requested", phase: "fuse", unit: fuseUnit });
        }
        if !under_root(part.file, byScopeDir) || !ends_with(part.file, ".jsonl") || blank(part.scopeKey) || part.lines < 1 {
            complete(#{ status: "blocked", reason: "a manifest part failed path or content validation", phase: "fuse", unit: fuseUnit });
        }
        if contains_int(seenPartIndices, part.index) {
            complete(#{ status: "blocked", reason: "the manifest returned a duplicate part index", phase: "fuse", unit: fuseUnit });
        }
        seenPartIndices.push(part.index);
        partEntries.push(part);
    }
    if partEntries.len() != requestedParts.len() {
        complete(#{ status: "blocked", reason: "the manifest did not return every requested part", phase: "fuse", unit: fuseUnit });
    }

    let fuseResumePrompt = "Read the durable checkpoint of one Mengshu wiki governance fuse unit: " + fuseCkptPath + ". ";
    fuseResumePrompt += "Use read_file or the shell. If the file exists and parses as JSON, return exists true and the completed and failed arrays exactly as recorded. ";
    fuseResumePrompt += "If it does not exist, return exists false with empty arrays. ";
    fuseResumePrompt += "If it exists but does not parse, return exists true with empty arrays. ";
    fuseResumePrompt += "checkpointPath must be " + fuseCkptPath + ". Do not modify anything.";
    let fuseResumed = agent(fuseResumePrompt, #{
        label: "fuse:resume",
        capability_mode: "read-only",
        output_schema: checkpoint_fuse_schema,
    });
    let completedParts = [];
    if fuseResumed != () && fuseResumed.success == true && is_map(fuseResumed.output) && fuseResumed.output.checkpointPath == fuseCkptPath {
        if is_array(fuseResumed.output.completed) {
            for entry in fuseResumed.output.completed {
                if is_map(entry) && is_string(entry.part) && is_string(entry.pagesDir) && under_root(entry.pagesDir, wikiRoot + "/final") {
                    completedParts.push(entry.part);
                }
            }
        }
    } else {
        log("fuse resume checkpoint was unreadable; completed parts will be redone safely");
    }

    let fuseSkipped = [];
    while true {
        let pendingParts = [];
        for idx in requestedParts {
            if !contains_str(completedParts, idx.to_string()) && !contains_str(fuseSkipped, idx.to_string()) {
                pendingParts.push(idx);
            }
        }
        if pendingParts.len() == 0 { break; }
        if budget().remaining < budgetReserve {
            log("budget reserve reached with " + pendingParts.len().to_string() + " parts unfinished");
            complete(#{
                status: "blocked",
                reason: "agent budget reserve reached before the fuse unit finished",
                phase: "fuse",
                unit: fuseUnit,
                checkpointPath: fuseCkptPath,
                requestedParts: requestedParts.len(),
                completedParts: completedParts.len(),
                pendingParts: pendingParts.len(),
            });
        }
        let fuseJobs = [];
        let fuseWave = [];
        let w = 0;
        while w < waveSize && w < pendingParts.len() {
            let idx = pendingParts[w];
            let chosen = ();
            for part in partEntries {
                if part.index == idx {
                    chosen = part;
                }
            }
            if chosen == () {
                complete(#{ status: "blocked", reason: "part metadata vanished for index " + idx.to_string(), phase: "fuse", unit: fuseUnit });
            }
            let partDir = wikiRoot + "/final/part-" + pad4(idx);
            let prompt = "Fuse one scope slice of Mengshu knowledge into wiki pages. ";
            prompt += "Read " + chosen.file + " and the sibling .scope file. Scope key: " + chosen.scopeKey + ". ";
            prompt += "There are " + chosen.lines.to_string() + " records. Every id must appear in exactly one sibling .sources file. ";
            prompt += "Write only page-NNN.md files under " + partDir + "/. ";
            prompt += "Write every page and every .sources file via a .tmp sibling and an atomic rename into place; never leave a .tmp file behind and never append to an existing file. ";
            prompt += "Each page has a sibling page-NNN.sources file with one source uuid per line. ";
            prompt += "Do not write index.md, README, or any other markdown file. ";
            prompt += "If the part directory already holds files from an earlier attempt of this same part, overwrite them file for file and remove nothing else; never write outside that directory and never touch another part directory. ";
            prompt += "Each page starts with frontmatter keys scope_key, semantic_type, memory_form, and tree_type. ";
            prompt += "Values are unquoted single-line tokens. ";
            prompt += "semantic_type is profile, task_context, rules, experience, resource, or unclassified. ";
            prompt += "memory_form is event, fact, semantic, procedural, or unknown. ";
            prompt += "tree_type is source, topic, or global. Do not call those L1, L2, or L3. ";
            prompt += "Merge records that say the same thing. Keep conflicting claims visible. ";
            prompt += "For resource pages with general industry facts, use web_search and add a dated citation. ";
            prompt += "Do not replace private project evidence with a trend summary. ";
            prompt += "Use the global provider file only if you call a model command: " + configPath + ". Do not print secrets. ";
            prompt += "Return the page count and the number of source ids you wrote.";
            fuseJobs.push(#{
                prompt: prompt,
                label: "fuse:" + idx.to_string(),
                capability_mode: "all",
                output_schema: fuse_schema,
            });
            fuseWave.push(#{
                index: idx,
                part: idx.to_string(),
                pagesDir: partDir,
                lines: chosen.lines,
                scopeKey: chosen.scopeKey,
            });
            w += 1;
        }
        let fuseResults = parallel(fuseJobs);
        let fusePayload = [];
        let slot = 0;
        for fused in fuseResults {
            let m = fuseWave[slot];
            let ok = fused != () && fused.success == true && is_map(fused.output)
                && is_int(fused.output.sourceIds) && fused.output.sourceIds == m.lines
                && is_int(fused.output.pages) && fused.output.pages > 0;
            fusePayload.push(#{
                part: m.part,
                pagesDir: m.pagesDir,
                lines: m.lines,
                pages: ok ? fused.output.pages : 0,
                scopeKey: m.scopeKey,
                ok: ok,
            });
            slot += 1;
        }
        let fuseUpdPrompt = "Update the durable checkpoint of one Mengshu wiki governance fuse unit. ";
        fuseUpdPrompt += "Checkpoint file: " + fuseCkptPath + ". ";
        fuseUpdPrompt += "Wave payload JSON follows. For every entry with ok true: ";
        fuseUpdPrompt += "its pagesDir must exist; list the directory: every file must match page-NNN.md or page-NNN.sources naming, every page-NNN.md must have its page-NNN.sources pair and vice versa, ";
        fuseUpdPrompt += "every non-empty .sources line must look like a uuid, the total number of non-empty lines across all .sources files must equal entry.lines, ";
        fuseUpdPrompt += "and the number of page-NNN.md files must equal entry.pages, so leftover paired files from an earlier larger attempt are flagged too. ";
        fuseUpdPrompt += "Parse the content of every page-NNN.md: it must open with a --- frontmatter block closed by a second --- line holding single-line unquoted scope_key, semantic_type, memory_form, and tree_type; ";
        fuseUpdPrompt += "semantic_type must be one of profile, task_context, rules, experience, resource, unclassified; ";
        fuseUpdPrompt += "memory_form must be one of event, fact, semantic, procedural, unknown; ";
        fuseUpdPrompt += "tree_type must be one of source, topic, global; ";
        fuseUpdPrompt += "scope_key must equal entry.scopeKey; the body after the frontmatter must hold at least 20 characters. ";
        fuseUpdPrompt += "Compute the part digest: shasum -a 256 of every file in pagesDir in sorted name order piped to shasum -a 256; record the final hash and the file count. ";
        fuseUpdPrompt += "Any missing directory, unpaired or extra file, non-uuid source line, wrong source line count, wrong page count, unparsable frontmatter, bad enum value, mismatched scope_key, or leftover .tmp file marks the part failed with the reason; never count it completed. ";
        fuseUpdPrompt += "For entries with ok false record the part as failed. ";
        fuseUpdPrompt += "Merge with the existing checkpoint: keep completed entries from earlier waves, move a previously failed part that now passes into completed, and keep failed entries that did not pass. ";
        fuseUpdPrompt += "Write the merged JSON with keys checkpointPath, exists true, completed, failed to " + fuseCkptPath + ".tmp and atomically rename it over " + fuseCkptPath + ". ";
        fuseUpdPrompt += "completed items need part, pagesDir, fileCount, sourcesLines, and digest. failed items need part and reason. ";
        fuseUpdPrompt += "Never modify any page or sources file. Return the merged checkpoint. Payload: ";
        fuseUpdPrompt += json_encode(fusePayload);
        let fuseUpdated = agent(fuseUpdPrompt, #{
            label: "fuse:checkpoint",
            capability_mode: "execute",
            output_schema: checkpoint_fuse_schema,
        });
        if fuseUpdated == () || fuseUpdated.success != true || !is_map(fuseUpdated.output) || fuseUpdated.output.checkpointPath != fuseCkptPath {
            complete(#{
                status: "blocked",
                reason: "fuse checkpoint update failed; this wave is not counted as success",
                phase: "fuse",
                unit: fuseUnit,
                checkpointPath: fuseCkptPath,
                pendingParts: pendingParts.len(),
            });
        }
        completedParts = [];
        if is_array(fuseUpdated.output.completed) {
            for entry in fuseUpdated.output.completed {
                if is_map(entry) && is_string(entry.part) && is_string(entry.pagesDir) && under_root(entry.pagesDir, wikiRoot + "/final") {
                    completedParts.push(entry.part);
                }
            }
        }
        for entry in fusePayload {
            if !contains_str(completedParts, entry.part) {
                fuseSkipped.push(entry.part);
                log("part stays failed this run: " + entry.part);
            }
        }
    }

    let doneParts = 0;
    let fusedIds = 0;
    for part in partEntries {
        if contains_str(completedParts, part.index.to_string()) {
            doneParts += 1;
            fusedIds += part.lines;
        }
    }
    if doneParts == requestedParts.len() {
        complete(#{
            status: "completed",
            summary: "fuse unit " + fuseUnit + " finished " + doneParts.to_string() + " parts (" + fusedIds.to_string() + " source ids)",
            phase: "fuse",
            unit: fuseUnit,
            requestedParts: requestedParts.len(),
            completedParts: doneParts,
            fusedIds: fusedIds,
            checkpointPath: fuseCkptPath,
        });
    }
    complete(#{
        status: "blocked",
        reason: "some requested parts did not complete; rerun this same unit to retry only the unfinished parts",
        phase: "fuse",
        unit: fuseUnit,
        requestedParts: requestedParts.len(),
        completedParts: doneParts,
        fusedIds: fusedIds,
        checkpointPath: fuseCkptPath,
        pendingParts: requestedParts.len() - doneParts,
    });
} else if p == "replace" {
    let configPath = args.config;
    let wikiRoot = args.wikiRoot;
    let templates = args.templates;
    let beforeIds = args.beforeIds;
    let mergedManifest = args.mergedManifest;
    let preflightPath = args.preflight;
    let expectedCount = as_int(args.expectedCount, 0);
    if !is_string(configPath) || blank(configPath) || !is_abs(configPath) || !ends_with(configPath, ".json") {
        pause("verification", "phase replace needs args.config as the absolute global provider config JSON path.");
        complete(#{ status: "blocked", reason: "args.config is missing or not an absolute .json path" });
    }
    if !is_string(wikiRoot) || blank(wikiRoot) || !is_abs(wikiRoot) {
        pause("verification", "phase replace needs args.wikiRoot as the absolute wiki root.");
        complete(#{ status: "blocked", reason: "args.wikiRoot is missing or not absolute" });
    }
    if !under_root(wikiRoot, runRoot) {
        pause("verification", "args.wikiRoot must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.wikiRoot escaped args.runRoot" });
    }
    if !is_string(templates) || blank(templates) || !is_abs(templates) {
        pause("verification", "phase replace needs args.templates as the absolute scope-templates file.");
        complete(#{ status: "blocked", reason: "args.templates is missing or not absolute" });
    }
    if !is_string(beforeIds) || blank(beforeIds) || !is_abs(beforeIds) {
        pause("verification", "phase replace needs args.beforeIds as the absolute before-ids file.");
        complete(#{ status: "blocked", reason: "args.beforeIds is missing or not absolute" });
    }
    if !is_string(mergedManifest) || blank(mergedManifest) || !is_abs(mergedManifest) || !ends_with(mergedManifest, ".json") {
        pause("verification", "phase replace needs args.mergedManifest as the merged manifest JSON under runRoot; apply requires it for the provenance contract.");
        complete(#{ status: "blocked", reason: "args.mergedManifest is missing or not an absolute .json path" });
    }
    if !under_root(mergedManifest, runRoot) {
        pause("verification", "args.mergedManifest must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.mergedManifest escaped args.runRoot" });
    }
    if !is_string(preflightPath) || blank(preflightPath) || !is_abs(preflightPath) || !ends_with(preflightPath, ".json") {
        pause("verification", "phase replace needs args.preflight as the preflight receipt JSON under runRoot; apply runs only after status ready.");
        complete(#{ status: "blocked", reason: "args.preflight is missing or not an absolute .json path" });
    }
    if !under_root(preflightPath, runRoot) {
        pause("verification", "args.preflight must stay under args.runRoot.");
        complete(#{ status: "blocked", reason: "args.preflight escaped args.runRoot" });
    }
    if expectedCount < 1 {
        pause("verification", "phase replace needs args.expectedCount as the frozen knowledge row count.");
        complete(#{ status: "blocked", reason: "args.expectedCount was missing or below 1" });
    }
    phase("Replace");
    // preflight-ready 前置门禁：不依赖调用纪律，回执不是 status ready 就拒绝进入 apply。
    let preflightPrompt = "Read the Mengshu wiki governance preflight receipt: " + preflightPath + ". ";
    preflightPrompt += "Use read_file or the shell. It is JSON with a status field. ";
    preflightPrompt += "Return status exactly as recorded and preflightPath exactly " + preflightPath + ". Do not modify anything.";
    let preflighted = agent(preflightPrompt, #{
        label: "replace:preflight-gate",
        capability_mode: "read-only",
        output_schema: preflight_schema,
    });
    if preflighted == () || preflighted.success != true || !is_map(preflighted.output) || preflighted.output.preflightPath != preflightPath || preflighted.output.status != "ready" {
        complete(#{ status: "blocked", reason: "preflight receipt was unreadable or not status ready; run the preflight phase and resolve its violations first", phase: "replace" });
    }
    let applyPrompt = "Replace the Mengshu knowledge table with the fused wiki. Work in " + repo + ". ";
    applyPrompt += "Run npx tsx scripts/operator-wiki-knowledge-replace.ts apply --config " + configPath;
    applyPrompt += " --wiki " + wikiRoot + "/final --templates " + templates;
    applyPrompt += " --before-ids " + beforeIds + " --expected-count " + expectedCount.to_string();
    applyPrompt += " --merged-manifest " + mergedManifest;
    applyPrompt += " --confirmation-token APPLY-WIKI-KNOWLEDGE-REPLACE. ";
    applyPrompt += "The script embeds with the global config and deletes only the listed knowledge ids. It must not modify memories. ";
    applyPrompt += "Set status to applied only if the command prints status applied and exits 0. Otherwise set status to blocked. ";
    applyPrompt += "evidence quotes the command JSON and must not include API keys.";
    let applied = agent(applyPrompt, #{
        label: "replace:knowledge",
        capability_mode: "execute",
        output_schema: apply_schema,
    });
    if applied == () || applied.success != true || !is_map(applied.output) || applied.output.status != "applied" {
        complete(#{ status: "blocked", reason: "knowledge replacement did not apply", phase: "replace" });
    }
    complete(#{
        status: "completed",
        summary: "knowledge replacement applied: " + applied.output.evidence,
        phase: "replace",
        evidence: applied.output.evidence,
    });
} else if p == "report" {
    phase("Report");
    let reportPrompt = "Compile the Mengshu wiki governance report for one run root. Work in " + repo + ". ";
    reportPrompt += "Run root: " + runRoot + ". Use the shell and read_file only on paths inside " + runRoot + ". ";
    reportPrompt += "Read every checkpoint.json under " + runRoot + "/read and " + runRoot + "/fuse, ";
    reportPrompt += runRoot + "/by-scope/parts.json if it exists, and every JSON receipt under " + runRoot + "/receipts if that directory exists. ";
    reportPrompt += "The report must keep five sections separate: read (per unit completed and failed batch counts), ";
    reportPrompt += "fused (per unit completed and failed part counts with source id totals), ";
    reportPrompt += "replaced (quote the replacement receipt status, deleted, and inserted counts), ";
    reportPrompt += "kept or deferred (records still unclassified or left on source-only lookup pages), ";
    reportPrompt += "and failed retries (every failed batch or part with its reason and the exact rerun command). ";
    reportPrompt += "Quote the numbers from the artifacts; never estimate; write not started for a section with no artifacts. ";
    reportPrompt += "Write only " + runRoot + "/report.md via a .tmp file and an atomic rename. Do not modify any other file. ";
    reportPrompt += "Return status completed with reportPath and evidence quoting one line per section. ";
    reportPrompt += "If " + runRoot + " is unreadable, return status blocked instead.";
    let reported = agent(reportPrompt, #{
        label: "report:coverage",
        capability_mode: "execute",
        output_schema: report_schema,
    });
    if reported == () || reported.success != true || !is_map(reported.output) || reported.output.status != "completed" || !is_string(reported.output.reportPath) || !under_root(reported.output.reportPath, runRoot) || !ends_with(reported.output.reportPath, ".md") {
        complete(#{ status: "blocked", reason: "the coverage report could not be compiled", phase: "report" });
    }
    complete(#{
        status: "completed",
        summary: "coverage report written to " + reported.output.reportPath,
        phase: "report",
        reportPath: reported.output.reportPath,
        evidence: reported.output.evidence,
    });
}
