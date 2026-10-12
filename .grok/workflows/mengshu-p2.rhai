let meta = #{
    name: "mengshu-p2",
    description: "Finish mengshu P2: W2 CLI directory governance, W3 session hooks, then review and fix. Requirements live in docs/plans only.",
    when_to_use: "Continue P2 after W1 MCP. /mengshu-p2",
    phases: [
        #{ title: "W2-CLI", detail: "directory scan → report → dry-run → apply into memory" },
        #{ title: "W3-Hooks", detail: "passive session hooks map and docs" },
        #{ title: "Review", detail: "adversarial review of W1–W3 diffs" },
        #{ title: "Fix", detail: "apply confirmed fixes and re-test" },
        #{ title: "Report", detail: "commits, tests, leftovers" },
    ],
};

const PLAN = "docs/plans/dev-plan-p2-mcp-cli-hooks-20261011.md";
const NEXT = "docs/plans/upgrade-next-20261011.md";
const BRANCH = "1.0.7";

phase("W2-CLI");
let w2 = agent(#{
    prompt: "You are implementing ONLY W2 from " + PLAN + " (also skim " + NEXT + " constraints). Branch " + BRANCH + ". Hard locks: no npm publish; no Graphiti/third-party memory bridges; writes must go through authority→admission; dry-run must not write DB; do not invent host flush-plan APIs. Implement CLI directory analysis → report → dry-run → apply into mengshu memory with 5type labels and rejection summaries; add focused tests. Commit and push origin/" + BRANCH + ". Do not start W3. Report commit hashes and test results.",
    label: "w2-cli",
});

phase("W3-Hooks");
let w3 = agent(#{
    prompt: "You are implementing ONLY W3 from " + PLAN + ". Branch " + BRANCH + ". Extend passive session hooks (session_start / pre_compact / task_complete / session_end): unified payload, map real host events only, fail observably without blocking turns, update docs/guides/agent-session-hooks.md and Skill if needed. flush-plan may remain null. Hard locks same as plan. Commit and push origin/" + BRANCH + ". Report commits and tests.",
    label: "w3-hooks",
});

phase("Review");
let review_schema = #{
    "type": "object",
    "required": ["findings"],
    "properties": #{
        "findings": #{
            "type": "array",
            "maxItems": 12,
            "items": #{
                "type": "object",
                "required": ["severity", "issue", "evidence"],
                "properties": #{
                    "severity": #{ "type": "string" },
                    "issue": #{ "type": "string" },
                    "evidence": #{ "type": "string" },
                },
            },
        },
    },
};
let review = agent(#{
    prompt: "Adversarially review commits on " + BRANCH + " since 31ddf96 (W1) plus W2/W3 just landed. Read real diffs with git/read tools. Check: MCP default list purity; empty-recall states; CLI dry-run safety; admission path; secret leakage; fake host APIs; 5type continuity. Return at most 12 findings as {severity, issue, evidence}. Empty list only after reading the diffs.",
    label: "review",
    schema: review_schema,
});

phase("Fix");
let fix = agent(#{
    prompt: "Apply confirmed review findings from prior phase (skip speculative ones). Re-run focused vitest for touched areas. Commit and push origin/" + BRANCH + ". Do not do npm or Graphiti work.",
    label: "fix",
});

phase("Report");
let report = agent(#{
    prompt: "Summarize P2 status for branch " + BRANCH + ": commits since 6b89ed7, tests, remaining gaps. Note Mac ~/.mengshu migrate/wiki only if schema or CLI contracts require it (do not print secrets).",
    label: "report",
});

complete(#{
    w2: w2,
    w3: w3,
    review: review,
    fix: fix,
    report: report,
});
