let meta = #{
    name: "wiki-memory-upgrade",
    description: "Upgrade Mengshu from the 2026-09 wiki compilation plan, compile existing rows into a 5-type memory-tree wiki, and re-embed only through Mengshu operators",
    when_to_use: "Run after reading mengshu-wiki-memory-compilation-upgrade-2026-09.md when the repo needs the P0-P2 vertical slice plus a staging export, per-file wiki compile, and a gated re-embed. Pass throughPhase P6 only when the earlier phases are already in the tree.",
    phases: [
        #{ title: "Spec", detail: "Read the upgrade plan against the current tree" },
        #{ title: "Code", detail: "Implement the next bounded phase tasks" },
        #{ title: "Verify", detail: "Typecheck and tests must pass before any data move" },
        #{ title: "Export", detail: "Extract the PostgreSQL workset to Markdown" },
        #{ title: "Read", detail: "Read every exported Markdown in bounded batches" },
        #{ title: "Wiki", detail: "Compile staging pages by 5 type and memory tree" },
        #{ title: "Ingest", detail: "Dry-run Mengshu operators; write vectors only after the gate" },
        #{ title: "Report", detail: "Record coverage, drops, and what was not written" },
    ],
};

let spec_schema = #{
    "type": "object",
    "required": ["warnings", "gaps"],
    "properties": #{
        "warnings": #{ "type": "array", "maxItems": 8, "items": #{ "type": "string" } },
        "gaps": #{
            "type": "array",
            "maxItems": 8,
            "items": #{
                "type": "object",
                "required": ["file", "issue"],
                "properties": #{
                    "file": #{ "type": "string" },
                    "issue": #{ "type": "string" },
                },
            },
        },
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

let export_schema = #{
    "type": "object",
    "required": ["status", "exportDir", "manifestPath", "fileCount", "evidence"],
    "properties": #{
        "status": #{ "type": "string" },
        "exportDir": #{ "type": "string" },
        "manifestPath": #{ "type": "string" },
        "manifestSha256": #{ "type": "string" },
        "fileCount": #{ "type": "integer" },
        "evidence": #{ "type": "string" },
    },
};

let read_schema = #{
    "type": "object",
    "required": ["items", "totalFiles"],
    "properties": #{
        "totalFiles": #{ "type": "integer" },
        "items": #{
            "type": "array",
            "maxItems": 8,
            "items": #{
                "type": "object",
                "required": ["path", "semanticType", "memoryForm", "treeType", "evidenceNote", "title", "disposition"],
                "properties": #{
                    "path": #{ "type": "string" },
                    "semanticType": #{ "type": "string" },
                    "memoryForm": #{ "type": "string" },
                    "treeType": #{ "type": "string" },
                    "evidenceNote": #{ "type": "string" },
                    "title": #{ "type": "string" },
                    "disposition": #{ "type": "string" },
                },
            },
        },
    },
};

let page_schema = #{
    "type": "object",
    "required": ["pages", "unreadCount"],
    "properties": #{
        "unreadCount": #{ "type": "integer" },
        "pages": #{
            "type": "array",
            "maxItems": 8,
            "items": #{
                "type": "object",
                "required": ["path", "kind"],
                "properties": #{
                    "path": #{ "type": "string" },
                    "kind": #{ "type": "string" },
                },
            },
        },
    },
};

let audit_schema = #{
    "type": "object",
    "required": ["accepted", "evidence"],
    "properties": #{
        "accepted": #{ "type": "boolean" },
        "evidence": #{ "type": "string" },
    },
};

let ingest_schema = #{
    "type": "object",
    "required": ["status", "commands", "evidence", "vectorTouched"],
    "properties": #{
        "status": #{ "type": "string" },
        "vectorTouched": #{ "type": "boolean" },
        "evidence": #{ "type": "string" },
        "commands": #{ "type": "array", "maxItems": 12, "items": #{ "type": "string" } },
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
fn under_root(path, root) {
    if !is_string(path) || !is_string(root) || root == "" { return false; }
    if path == root { return true; }
    let rooted = root;
    let last = root.sub_string(root.len() - 1, 1);
    if last != "/" { rooted = root + "/"; }
    if path.len() < rooted.len() { return false; }
    path.sub_string(0, rooted.len()) == rooted
}
fn found(hay, needle) {
    if !is_string(hay) || !is_string(needle) { return false; }
    let at = hay.index_of(needle);
    is_int(at) && at >= 0
}
fn phase_rank(p) {
    if p == "P0" { return 0; }
    if p == "P1" { return 1; }
    if p == "P2" { return 2; }
    if p == "P3" { return 3; }
    if p == "P4" { return 4; }
    if p == "P5" { return 5; }
    if p == "P6" { return 6; }
    -1
}
fn take(items, limit) {
    let kept = [];
    let dropped = 0;
    let n = 0;
    for item in items {
        if n < limit { kept.push(item); } else { dropped += 1; }
        n += 1;
    }
    #{ kept: kept, dropped: dropped }
}
fn chunk_items(items, size) {
    let chunks = [];
    let current = [];
    let n = 0;
    for item in items {
        current.push(item);
        n += 1;
        if n >= size {
            chunks.push(current);
            current = [];
            n = 0;
        }
    }
    if current.len() > 0 { chunks.push(current); }
    chunks
}
fn command_ok(cmd, root, allow_apply) {
    if !is_string(cmd) || blank(cmd) { return false; }
    if found(cmd, "activate-import") { return false; }
    if found(cmd, "rollback-import") { return false; }
    if found(cmd, "DROP") { return false; }
    if found(cmd, "TRUNCATE") { return false; }
    if found(cmd, "migrate-history") { return false; }
    if found(cmd, "rm -rf") { return false; }
    if found(cmd, "git reset") { return false; }
    let scanning = found(cmd, " scan ");
    let applying = found(cmd, "--apply");
    if (scanning || applying) && allow_apply != true { return false; }
    if scanning && !found(cmd, root) { return false; }
    true
}
fn normalize_item(raw, exportRoot) {
    if !is_map(raw) || !under_root(raw.path, exportRoot) { return (); }
    let semantic = raw.semanticType;
    let note = "";
    if is_string(raw.evidenceNote) { note = raw.evidenceNote; }
    note.trim();
    let allowed = semantic == "profile" || semantic == "task_context" || semantic == "rules" || semantic == "experience" || semantic == "resource";
    if semantic == "experience" && note == "" { allowed = false; }
    if !allowed { semantic = "unclassified"; }
    let form = raw.memoryForm;
    if form != "event" && form != "episodic" && form != "fact" && form != "claim" && form != "semantic" && form != "procedural" {
        form = "unknown";
    }
    let tree = raw.treeType;
    if tree != "source" && tree != "topic" && tree != "global" { tree = "none"; }
    let title = raw.path;
    if is_string(raw.title) && !blank(raw.title) { title = raw.title; }
    let disposition = "keep";
    if is_string(raw.disposition) && !blank(raw.disposition) { disposition = raw.disposition; }
    #{
        path: raw.path,
        semanticType: semantic,
        memoryForm: form,
        treeType: tree,
        evidenceNote: note,
        title: title,
        disposition: disposition,
    }
}

let repo = if args == () { () } else { args.repo };
let doc = if args == () { () } else { args.doc };
let containment = if args == () { () } else { args.containmentRoot };
if !is_string(repo) || blank(repo) || !is_string(doc) || blank(doc) || !is_string(containment) || blank(containment) {
    pause("verification", "Pass args.repo, args.doc, and args.containmentRoot (absolute staging directory).");
}
if !under_root(containment, "/") && containment.sub_string(0, 1) != "/" {
    pause("verification", "args.containmentRoot must be an absolute path.");
}
if containment.sub_string(0, 1) != "/" {
    pause("verification", "args.containmentRoot must be an absolute path.");
}

let throughPhase = "P2";
if args.throughPhase != () && is_string(args.throughPhase) { throughPhase = args.throughPhase; }
let ceiling = phase_rank(throughPhase);
if ceiling < 0 {
    pause("verification", "args.throughPhase must be P0, P1, P2, P3, P4, P5, or P6.");
}
let maxTasks = as_int(if args.maxCodeTasks == () { () } else { args.maxCodeTasks }, 3);
if maxTasks < 1 { maxTasks = 1; }
if maxTasks > 6 {
    log("capped maxCodeTasks at 6");
    maxTasks = 6;
}
let maxBatches = as_int(if args.maxReadBatches == () { () } else { args.maxReadBatches }, 8);
if maxBatches < 1 { maxBatches = 1; }
if maxBatches > 24 {
    log("capped maxReadBatches at 24; later files stay unread in this run");
    maxBatches = 24;
}
let batchSize = as_int(if args.filesPerBatch == () { () } else { args.filesPerBatch }, 6);
if batchSize < 1 { batchSize = 1; }
if batchSize > 8 {
    log("capped filesPerBatch at 8");
    batchSize = 8;
}
let applyMode = "plan";
if args.applyMode != () { applyMode = args.applyMode; }
if applyMode != "plan" && applyMode != "apply" {
    pause("verification", "args.applyMode must be plan or apply.");
}
let allowApply = applyMode == "apply";
let configPath = if args.config == () { "" } else { args.config };
if configPath != "" && !is_string(configPath) {
    pause("verification", "args.config must be an absolute file path when set.");
}
if configPath != "" && configPath.sub_string(0, 1) != "/" {
    pause("verification", "args.config must be an absolute file path when set.");
}
let providerRule = "";
if configPath != "" {
    providerRule = "Provider config is only " + configPath + ". ";
    providerRule += "Pass that absolute path as --config on every ms, tsx, or operator command. ";
    providerRule += "Use its embedding and llm fields for model, baseURL, and credentials. ";
    providerRule += "Do not read a project .mengshu/config.json for providers, do not print secrets, and do not write keys into the repo. ";
}
let embeddingManifest = if args.embeddingManifest == () { "" } else { args.embeddingManifest };
if embeddingManifest != "" && !is_string(embeddingManifest) {
    pause("verification", "args.embeddingManifest must be a path when set.");
}
let runId = "wiki-upgrade-20261003";
if args.runId != () && is_string(args.runId) && !blank(args.runId) && !found(args.runId, " ") {
    runId = args.runId;
}

if !under_root(containment + "/export/a.md", containment) { throw "under_root missed a child path"; }
if under_root(containment + "bar/x.md", containment) { throw "under_root accepted a prefix collision"; }
if under_root("/etc/passwd", containment) { throw "under_root accepted an outside path"; }
let probe = "migrate-semantic-types";
if found(probe, "activate-import") { throw "found() false-positive"; }
if !found("ms scan /tmp", " scan ") { throw "found() missed scan"; }
if command_ok("npx tsx bin/ms.ts scan " + containment + "/wiki", containment, false) {
    throw "plan mode accepted ms scan";
}
if !command_ok("npx tsx bin/ms.ts migrate-semantic-types --manifest " + containment + "/m.json", containment, false) {
    throw "plan mode rejected a dry-run type migration";
}
if command_ok("npx tsx bin/ms.ts migrate-markdown-workset activate-import", containment, true) {
    throw "activate-import must stay banned";
}
let sampleNorm = normalize_item(#{
    path: containment + "/export/a.md",
    semanticType: "experience",
    memoryForm: "fact",
    treeType: "L1",
    evidenceNote: "",
    title: "sample",
    disposition: "keep",
}, containment + "/export");
if sampleNorm == () || sampleNorm.semanticType != "unclassified" || sampleNorm.treeType != "none" {
    throw "experience without evidence must stay unclassified and Lx is not a treeType";
}
let sampleChunks = chunk_items([sampleNorm], 8);
if sampleChunks.len() != 1 || sampleChunks[0].len() != 1 { throw "chunk_items failed"; }

log("throughPhase=" + throughPhase + " codeTasks=" + maxTasks.to_string() + " readBatches=" + maxBatches.to_string() + " filesPerBatch=" + batchSize.to_string() + " applyMode=" + applyMode);

let catalog = [];
catalog.push(#{
    id: "P0",
    phase: "P0",
    title: "Freeze additive wiki contracts and reproduce the section 2.2 entry gaps",
    acceptance: "Additive memoryForm, asOf/knownAt, readEpoch, and source watermark types exist without changing scoring weights. Contract tests reproduce the observeLight enqueue gap and the sessionCommit payload drop. No new persisted wiki directory is created.",
});
catalog.push(#{
    id: "P1",
    phase: "P1",
    title: "Raw archive, source revision, and outbox capture",
    acceptance: "Accepted input is recoverable with LLM calls disabled. session close does not create an active wiki claim. Duplicate capture and duplicate promotion are idempotent. A crash between file rename and the database transaction is recoverable or marked damaged.",
});
catalog.push(#{
    id: "P2",
    phase: "P2",
    title: "Single typed-page compiler on the existing write kernel",
    acceptance: "Two updates to the same task_context or resource page change only the affected section. Unchanged section id, hash, and evidence stay put. Old heads remain readable. A drifted source revision cannot publish. ms wiki is not added as a real command.",
});
catalog.push(#{
    id: "P3",
    phase: "P3",
    title: "Native tree summarize outside the database lock",
    acceptance: "postgres build-tree prepare, external summarize, and commit are separate. Extractive fallback is labeled and stays within 500 tokens. A stale input snapshot cannot seal. source, topic, and global stay tree types, not L1/L2/L3 aliases.",
});
catalog.push(#{
    id: "P4",
    phase: "P4",
    title: "5-type and memoryForm promotion contracts",
    acceptance: "Representative samples exist for five semantic types and event/fact/semantic/procedural forms. Experience is not backfilled by renaming facts. Unclassified, deferred, and conflict stay explainable.",
});
catalog.push(#{
    id: "P5",
    phase: "P5",
    title: "Staging checkpoint for historical backfill",
    acceptance: "Checkpoint and input hash can stop a drifted batch. The tool does not activate an import, wipe native rows, or switch recall.",
});
catalog.push(#{
    id: "P6",
    phase: "P6",
    title: "Compiler eval manifest skeleton",
    acceptance: "A W-track fixture lists source revision to expected claim/page/tree cases, including abstain and temporal cases. Missing scorers are marked diagnostic. Scoring weights stay unchanged.",
});

let chosen = [];
let droppedTasks = 0;
for task in catalog {
    if phase_rank(task.phase) < 0 || phase_rank(task.phase) > ceiling || chosen.len() >= maxTasks {
        droppedTasks += 1;
    } else {
        chosen.push(task);
    }
}
if droppedTasks > 0 {
    log("dropped " + droppedTasks.to_string() + " code tasks beyond throughPhase or maxCodeTasks");
}

phase("Spec");
let specPrompt = "Read the Mengshu wiki compilation upgrade before you answer. ";
specPrompt += "Use read_file on " + doc + " and grep the source files it cites under " + repo + ". ";
specPrompt += "Do not edit files. Do not claim a gap you did not open. ";
specPrompt += "The implementation ceiling for this run is " + throughPhase + ". ";
specPrompt += "Return at most 8 warnings and 8 gaps. ";
specPrompt += "Each gap needs the repo-relative file and the concrete missing contract. ";
specPrompt += "An empty gap list is valid only after you have read the document and the cited files. ";
specPrompt += "Do not propose threshold or weight edits in packages/core/src/scoring/scoring-weights.ts. ";
specPrompt += "Do not treat ms wiki compile as an existing command.";
let spec = agent(specPrompt, #{
    label: "spec:upgrade-plan",
    capability_mode: "read-only",
    output_schema: spec_schema,
});
if spec == () || spec.success != true || !is_map(spec.output) {
    complete(#{
        status: "blocked",
        reason: "upgrade plan was not read against the tree",
    });
}
let warnings = [];
if is_array(spec.output.warnings) { warnings = spec.output.warnings; }
let gaps = [];
if is_array(spec.output.gaps) { gaps = spec.output.gaps; }

phase("Code");
let codeFailed = false;
for task in chosen {
    let codePrompt = "Implement one Mengshu code task in " + repo + ". ";
    codePrompt += "First use read_file on " + doc + " and on every file you will change. ";
    codePrompt += "Task JSON follows. ";
    codePrompt += json_encode(task);
    codePrompt += " Spec warnings: ";
    codePrompt += json_encode(warnings);
    codePrompt += " Spec gaps: ";
    codePrompt += json_encode(gaps);
    codePrompt += " Hard rules: do not edit scoring weights or admission thresholds; LLM temperature stays 0; ";
    codePrompt += "do not add a second wiki asset store; reuse GovernedDocumentAsset, the document write kernel, and RuntimeHost durable jobs; ";
    codePrompt += "do not register an ms wiki command; do not export or rewrite production memory rows; ";
    codePrompt += "do not force fact records into experience; ";
    codePrompt += "add or update unit tests for the behavior you change; ";
    codePrompt += "run the narrowest vitest file that covers the change and fix failures you cause. ";
    codePrompt += "Stop when this task acceptance is met. Leave later phases untouched. ";
    codePrompt += providerRule;
    let coded = agent(codePrompt, #{
        label: "code:" + task.id,
        capability_mode: "all",
    });
    if coded == () || coded.success != true {
        codeFailed = true;
        log("code task failed: " + task.id);
    }
}
if chosen.len() == 0 {
    complete(#{ status: "blocked", reason: "no code task was inside the phase ceiling" });
}
if codeFailed {
    complete(#{ status: "blocked", reason: "a code task failed before data governance" });
}

phase("Verify");
let verifyPrompt = "Verify the code tasks just implemented in " + repo + ". ";
verifyPrompt += "Use the shell. Run npx tsc --noEmit from the repo root. ";
verifyPrompt += "Run the vitest files that cover the touched contracts. ";
verifyPrompt += "Run git diff -- packages/core/src/scoring/scoring-weights.ts and treat any diff as failure. ";
verifyPrompt += "Set passed true only if the typecheck exit is 0, the targeted tests exit 0, and the weight file is unchanged. ";
verifyPrompt += "evidence must quote the command and the exit you observed. ";
verifyPrompt += "If you cannot run a command, set passed false. ";
verifyPrompt += providerRule;
verifyPrompt += "Tasks: ";
verifyPrompt += json_encode(chosen);
let verified = agent(verifyPrompt, #{
    label: "verify:code",
    capability_mode: "execute",
    output_schema: verify_schema,
});
let codeOk = verified != () && verified.success == true && is_map(verified.output) && verified.output.passed == true && !blank(verified.output.evidence);
if !codeOk {
    complete(#{ status: "blocked", reason: "code verification did not pass" });
}
let codeEvidence = verified.output.evidence;

phase("Export");
let exportDir = containment + "/export";
let wikiRoot = containment + "/wiki";
let exportPrompt = "Export the existing Mengshu PostgreSQL workset to Markdown. ";
exportPrompt += "Work in " + repo + ". Staging root is " + containment + ". ";
exportPrompt += "Run npx tsx bin/ms.ts migrate-markdown-workset export with absolute --config, --containment-root ";
exportPrompt += containment + ", --output " + exportDir + ", --run-id " + runId;
exportPrompt += ", and --policy-version wiki-compile-2026-09. ";
if configPath != "" {
    exportPrompt += providerRule;
} else {
    exportPrompt += "Resolve the existing Mengshu config the CLI already uses. Do not print secrets. ";
}
exportPrompt += "The output directory must be a fresh absolute path with no trailing slash. ";
exportPrompt += "If that directory already exists, do not delete it. If its manifest is readable, return status already_present and the manifest path. ";
exportPrompt += "Do not run activate-import, ms scan, DROP, TRUNCATE, or migrate-history. ";
exportPrompt += "Do not invent Markdown for rows you did not export. ";
exportPrompt += "If Postgres or the config is unavailable, return status blocked and the command stderr. ";
exportPrompt += "fileCount is the number of exported Markdown files. evidence quotes the operator JSON.";
let exported = agent(exportPrompt, #{
    label: "export:workset",
    capability_mode: "execute",
    output_schema: export_schema,
});
let exportOk = exported != () && exported.success == true && is_map(exported.output) && !blank(exported.output.evidence) && under_root(exported.output.exportDir, containment) && (exported.output.status == "exported" || exported.output.status == "already_present");
if !exportOk {
    complete(#{ status: "blocked", reason: "workset export did not produce a staging manifest" });
}
let manifestPath = "";
if is_string(exported.output.manifestPath) { manifestPath = exported.output.manifestPath; }
let manifestSha = "";
if is_string(exported.output.manifestSha256) { manifestSha = exported.output.manifestSha256; }
let exportedCount = 0;
if is_int(exported.output.fileCount) { exportedCount = exported.output.fileCount; }
exportDir = exported.output.exportDir;

phase("Read");
let readJobs = [];
let batchIndex = 0;
while batchIndex < maxBatches {
    let readPrompt = "Read one slice of the exported Mengshu Markdown. ";
    readPrompt += "Export directory: " + exportDir + ". Batch index " + batchIndex.to_string();
    readPrompt += " of " + maxBatches.to_string() + ", with " + batchSize.to_string() + " files per batch. ";
    readPrompt += "Use the shell only to list .md files under that directory, sort them by full path, and select the slice ";
    readPrompt += "[index * size, index * size + size). ";
    readPrompt += "Use read_file on every file in the slice before you answer. ";
    readPrompt += "Do not classify a file you did not open. If the slice is empty, return items [] and totalFiles. ";
    readPrompt += "semanticType is profile, task_context, rules, experience, resource, or unclassified. ";
    readPrompt += "experience requires a non-empty evidenceNote with result support. Otherwise use unclassified. ";
    readPrompt += "memoryForm is event, episodic, fact, claim, semantic, procedural, or unknown. ";
    readPrompt += "treeType is source, topic, or global only when the file is an aggregation nav point; otherwise none. ";
    readPrompt += "Never use L0, L1, L2, or L3 as treeType. ";
    readPrompt += "Do not invent raw transcript text. disposition is keep, defer, conflict, or index_only. ";
    readPrompt += "path must be the absolute file you read. totalFiles is the full sorted count, not the slice size.";
    readJobs.push(#{
        prompt: readPrompt,
        label: "read:" + batchIndex.to_string(),
        capability_mode: "read-only",
        output_schema: read_schema,
    });
    batchIndex += 1;
}
let readResults = parallel(readJobs);
let profileItems = [];
let taskItems = [];
let ruleItems = [];
let experienceItems = [];
let resourceItems = [];
let unclassifiedItems = [];
let sourceItems = [];
let topicItems = [];
let globalItems = [];
let keptItems = 0;
let droppedItems = 0;
let reportedTotal = 0;
let readFailures = 0;
for readResult in readResults {
    if readResult == () || readResult.success != true || !is_map(readResult.output) || !is_array(readResult.output.items) {
        readFailures += 1;
    } else {
        if is_int(readResult.output.totalFiles) && readResult.output.totalFiles > reportedTotal {
            reportedTotal = readResult.output.totalFiles;
        }
        for rawItem in readResult.output.items {
            let item = normalize_item(rawItem, exportDir);
            if item == () {
                droppedItems += 1;
            } else {
                keptItems += 1;
                if item.semanticType == "profile" { profileItems.push(item); }
                else if item.semanticType == "task_context" { taskItems.push(item); }
                else if item.semanticType == "rules" { ruleItems.push(item); }
                else if item.semanticType == "experience" { experienceItems.push(item); }
                else if item.semanticType == "resource" { resourceItems.push(item); }
                else { unclassifiedItems.push(item); }
                if item.treeType == "source" { sourceItems.push(item); }
                else if item.treeType == "topic" { topicItems.push(item); }
                else if item.treeType == "global" { globalItems.push(item); }
            }
        }
    }
}
if readFailures > 0 {
    log("read batches failed: " + readFailures.to_string());
}
if droppedItems > 0 {
    log("dropped " + droppedItems.to_string() + " read items outside the export root or missing a path");
}
let coveredCap = maxBatches * batchSize;
if reportedTotal > coveredCap {
    log("unread export files remain: reported " + reportedTotal.to_string() + " with cap " + coveredCap.to_string());
}
if exportedCount > 0 && keptItems == 0 {
    complete(#{ status: "blocked", reason: "export produced files but none were read" });
}

phase("Wiki");
let wikiJobs = [];
let folders = [
    #{ name: "profile", dir: "Memory/Profile", items: profileItems },
    #{ name: "task_context", dir: "Memory/Task Context", items: taskItems },
    #{ name: "rules", dir: "Memory/Rules", items: ruleItems },
    #{ name: "experience", dir: "Memory/Experience", items: experienceItems },
    #{ name: "resource", dir: "Memory/Resource", items: resourceItems },
    #{ name: "unclassified", dir: "Indexes/Unclassified", items: unclassifiedItems },
    #{ name: "source", dir: "Trees/Source", items: sourceItems },
    #{ name: "topic", dir: "Trees/Topic", items: topicItems },
    #{ name: "global", dir: "Trees/Global", items: globalItems },
];
for folder in folders {
    let chunks = chunk_items(folder.items, batchSize);
    let part = 0;
    for ch in chunks {
        let wikiPrompt = "Write one staging wiki batch for Mengshu. ";
        wikiPrompt += "Read every source path in the JSON with read_file before writing. ";
        wikiPrompt += "Wiki root: " + wikiRoot + ". Folder: " + folder.dir + "/part-" + part.to_string() + ". ";
        wikiPrompt += "Bucket: " + folder.name + ". ";
        wikiPrompt += "Create Markdown only under that folder. ";
        wikiPrompt += "A memory page has exactly one semanticType. ";
        wikiPrompt += "A tree page may be written only for source, topic, or global and must link to source paths; do not call it L1, L2, or L3. ";
        wikiPrompt += "Unclassified items stay index entries that point at the export path. Do not assign them a type. ";
        wikiPrompt += "Do not invent evidence, raw transcripts, or experience results. ";
        wikiPrompt += "Keep record ids and source paths in the page. ";
        wikiPrompt += "If you cannot read an item, leave it out and increase unreadCount. ";
        wikiPrompt += "Return absolute page paths. Items: ";
        wikiPrompt += json_encode(ch);
        wikiJobs.push(#{
            prompt: wikiPrompt,
            label: "wiki:" + folder.name + ":" + part.to_string(),
            capability_mode: "read-write",
            output_schema: page_schema,
        });
        part += 1;
    }
}
let wikiLimited = take(wikiJobs, 24);
if wikiLimited.dropped > 0 {
    log("capped wiki jobs at 24; dropped " + wikiLimited.dropped.to_string());
}
wikiJobs = wikiLimited.kept;
let pagePaths = [];
let unreadPages = 0;
let wikiFailures = 0;
if wikiJobs.len() > 0 {
    let wikiResults = parallel(wikiJobs);
    for wikiResult in wikiResults {
        if wikiResult == () || wikiResult.success != true || !is_map(wikiResult.output) {
            wikiFailures += 1;
        } else {
            if is_int(wikiResult.output.unreadCount) { unreadPages += wikiResult.output.unreadCount; }
            if is_array(wikiResult.output.pages) {
                for page in wikiResult.output.pages {
                    if is_map(page) && under_root(page.path, wikiRoot) {
                        pagePaths.push(page.path);
                    } else {
                        droppedItems += 1;
                    }
                }
            }
        }
    }
}
if wikiFailures > 0 { log("wiki batches failed: " + wikiFailures.to_string()); }
if unreadPages > 0 { log("wiki unread items: " + unreadPages.to_string()); }
let auditOk = keptItems == 0;
let auditEvidence = "no exported items to compile";
if keptItems > 0 {
    if pagePaths.len() == 0 {
        complete(#{ status: "blocked", reason: "read items produced no in-root wiki pages" });
    }
    let auditPrompt = "Audit the staging wiki under " + wikiRoot + ". ";
    auditPrompt += "Use read_file on the page paths below. ";
    auditPrompt += "Set accepted true only if each opened page keeps a source path, ";
    auditPrompt += "experience pages include result evidence, unclassified pages do not pretend to be one of the five types, ";
    auditPrompt += "and tree pages do not relabel source topic or global as L1 L2 or L3. ";
    auditPrompt += "Otherwise set accepted false. evidence must name the page you opened. Paths: ";
    auditPrompt += json_encode(take(pagePaths, 8).kept);
    let audit = agent(auditPrompt, #{
        label: "wiki:audit",
        capability_mode: "read-only",
        output_schema: audit_schema,
    });
    auditOk = audit != () && audit.success == true && is_map(audit.output) && audit.output.accepted == true && !blank(audit.output.evidence);
    if auditOk { auditEvidence = audit.output.evidence; }
}
if !auditOk {
    complete(#{ status: "blocked", reason: "wiki audit did not accept the staging pages" });
}

phase("Ingest");
let ingestPrompt = "Plan Mengshu re-embedding for the staging wiki. Repo: " + repo + ". ";
ingestPrompt += "Export dir: " + exportDir + ". Manifest: " + manifestPath + ". Manifest sha: " + manifestSha + ". ";
ingestPrompt += "Wiki root: " + wikiRoot + ". Apply mode: " + applyMode + ". ";
if configPath != "" { ingestPrompt += providerRule; }
if embeddingManifest != "" { ingestPrompt += "Embedding manifest: " + embeddingManifest + ". "; }
ingestPrompt += "In plan mode, execute only read-only or staging-file commands: ";
ingestPrompt += "migrate-markdown-workset plan-import with the exported manifest and sha when both exist; ";
ingestPrompt += "ms migrate-semantic-types without --apply; ms migrate-topic-tree without --apply; ";
ingestPrompt += "npx tsx scripts/operator-embedding-migrate.ts without --apply only when an embedding manifest was given. ";
ingestPrompt += "Do not create an embedding manifest. Do not run ms scan. Do not run activate-import, rollback-import, or migrate-history. ";
ingestPrompt += "In apply mode, you may additionally run ms scan only on the wiki root, ";
ingestPrompt += "and --apply for semantic types, topic tree, and embedding migrate only with the confirmation token printed by the dry-run you just ran. ";
ingestPrompt += "Never pass a token you invented. Never delete or truncate rows. ";
ingestPrompt += "vectorTouched is true only if a command in this run wrote embeddings or new memory rows. ";
ingestPrompt += "Return the exact commands executed. If a prerequisite manifest is missing, return status blocked and do not improvise.";
if allowApply {
    if !auditOk {
        complete(#{ status: "blocked", reason: "apply was requested without an accepted wiki audit" });
    }
    await_user("verification", "Resume to re-embed: dry-run tokens may be applied, and ms scan may ingest only the staging wiki. activate-import stays disabled.");
}
let ingested = agent(ingestPrompt, #{
    label: "ingest:" + applyMode,
    capability_mode: "execute",
    output_schema: ingest_schema,
});
let ingestOk = ingested != () && ingested.success == true && is_map(ingested.output) && !blank(ingested.output.evidence);
let acceptedCommands = [];
let rejectedCommands = 0;
if ingestOk && is_array(ingested.output.commands) {
    for cmd in ingested.output.commands {
        if command_ok(cmd, wikiRoot, allowApply) || command_ok(cmd, containment, allowApply) {
            acceptedCommands.push(cmd);
        } else {
            rejectedCommands += 1;
        }
    }
}
if rejectedCommands > 0 {
    log("rejected " + rejectedCommands.to_string() + " ingest commands");
}
if !ingestOk {
    complete(#{ status: "blocked", reason: "ingest plan did not return evidence" });
}
let ingestStatus = "";
if is_string(ingested.output.status) { ingestStatus = ingested.output.status; }
if ingestStatus != "planned" && ingestStatus != "applied" {
    complete(#{ status: "blocked", reason: "ingest operator returned " + ingestStatus });
}
if ingested.output.vectorTouched == true && allowApply != true {
    complete(#{ status: "blocked", reason: "plan mode recorded a vector write" });
}
if rejectedCommands > 0 {
    complete(#{ status: "blocked", reason: "ingest command list included a banned operation" });
}
if allowApply && ingested.output.vectorTouched != true {
    log("apply mode finished without a vector write");
}

phase("Report");
let report = "# Wiki memory upgrade\n\n";
report += "Mode: " + applyMode + "\n";
report += "Phase ceiling: " + throughPhase + "\n";
report += "Code tasks run: " + chosen.len().to_string() + "\n";
report += "Code evidence: " + codeEvidence + "\n";
report += "Export dir: " + exportDir + "\n";
report += "Exported file count: " + exportedCount.to_string() + "\n";
report += "Items kept: " + keptItems.to_string() + "\n";
report += "Items dropped: " + droppedItems.to_string() + "\n";
report += "Reported export total: " + reportedTotal.to_string() + "\n";
report += "Wiki pages in root: " + pagePaths.len().to_string() + "\n";
report += "Wiki audit: " + auditEvidence + "\n";
report += "Accepted ingest commands: " + acceptedCommands.len().to_string() + "\n";
report += "Rejected ingest commands: " + rejectedCommands.to_string() + "\n";
if allowApply {
    report += "Vector writes were allowed only after the resume gate.\n";
} else {
    report += "Plan mode did not scan the wiki or activate an import.\n";
}
report += "activate-import and history rebuild stay disabled.\n";
let reportPath = write_scratch_file("report.md", report);
complete(#{
    status: "completed",
    summary: "code verified, staging wiki compiled, ingest " + applyMode,
    reportPath: reportPath,
    codeTasks: chosen.len(),
    itemsKept: keptItems,
    wikiPages: pagePaths.len(),
    ingestCommands: acceptedCommands.len(),
});
