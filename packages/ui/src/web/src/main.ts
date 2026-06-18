/**
 * Memory Console browser entry.
 *
 * 原生 TypeScript 渲染 Overview、Quick Lookup、Graph、Jobs 四个基础视图，
 * 面向本机中间件运维和知识速查，不引入前端框架依赖。
 */

import {
  defaultScope,
  fetchCandidates,
  fetchGraph,
  fetchJobs,
  fetchOverview,
  lookup,
  reviewCandidates,
  type CandidateReviewAction,
  type Scope,
} from "./api";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root");
}
const root = app;

let activeTab = "overview";
let scope: Scope = { ...defaultScope };
let selectedRaw = "";

function h(tag: string, className = "", text = ""): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function renderShell() {
  root.innerHTML = "";
  const layout = h("div", "layout");
  const sidebar = h("aside", "sidebar");
  sidebar.append(h("div", "brand", "Memory Console"));
  for (const tab of ["overview", "lookup", "graph", "candidates", "jobs"]) {
    const button = h("button", `nav ${activeTab === tab ? "active" : ""}`, tab);
    button.addEventListener("click", () => {
      activeTab = tab;
      void render();
    });
    sidebar.append(button);
  }

  const main = h("main", "main");
  const scopeBar = h("section", "scopebar");
  for (const key of ["tenantId", "appId", "userId", "projectId", "agentId", "namespace"] as const) {
    const label = h("label", "field");
    label.append(h("span", "", key));
    const input = document.createElement("input");
    input.value = scope[key];
    input.addEventListener("change", () => {
      scope = { ...scope, [key]: input.value || "default" };
      void render();
    });
    label.append(input);
    scopeBar.append(label);
  }
  main.append(scopeBar);
  const view = h("section", "view");
  view.id = "view";
  main.append(view);
  layout.append(sidebar, main);
  root.append(layout);
}

function metricCard(label: string, value: unknown) {
  const card = h("div", "metric");
  card.append(h("span", "metric-label", label));
  card.append(h("strong", "", String(value ?? 0)));
  return card;
}

async function renderOverview(view: HTMLElement) {
  const data = await fetchOverview(scope);
  const health = h("div", `health ${data.health.ok ? "ok" : "bad"}`, data.health.ok ? "healthy" : data.health.error ?? "unhealthy");
  const metrics = h("div", "metrics");
  for (const [key, value] of Object.entries(data.metrics)) {
    metrics.append(metricCard(key, value));
  }
  const topics = h("div", "panel");
  topics.append(h("h2", "", "Hot Topics"));
  for (const topic of data.hotTopics) {
    topics.append(h("div", "row", `${topic.label}  ${topic.hotness.toFixed(2)}`));
  }
  const digest = h("div", "panel");
  digest.append(h("h2", "", "Daily Digest"));
  digest.append(h("p", "", data.dailyDigest?.summary ?? ""));
  view.append(health, metrics, topics, digest);
}

async function renderLookup(view: HTMLElement) {
  const toolbar = h("div", "toolbar");
  const input = document.createElement("input");
  input.placeholder = "Search memories, chunks, summaries, entities";
  input.value = "";
  const run = h("button", "primary", "Run");
  toolbar.append(input, run);
  const body = h("div", "lookup-grid");
  const results = h("div", "panel results");
  const evidence = h("div", "panel evidence");
  evidence.append(h("h2", "", "Evidence"));
  evidence.append(h("pre", "", selectedRaw));
  body.append(results, evidence);
  view.append(toolbar, body);
  run.addEventListener("click", async () => {
    results.innerHTML = "";
    const data = await lookup(scope, input.value);
    for (const result of data.results) {
      const item = h("button", "result");
      item.append(h("strong", "", result.title));
      item.append(h("span", "", `${result.kind}  ${result.score.toFixed(2)}  ${result.sourceLabel}`));
      item.append(h("p", "", result.preview));
      item.addEventListener("click", () => {
        selectedRaw = result.raw ?? result.preview;
        evidence.querySelector("pre")!.textContent = selectedRaw;
      });
      results.append(item);
    }
  });
}

async function renderGraph(view: HTMLElement) {
  const toolbar = h("div", "toolbar");
  const input = document.createElement("input");
  input.placeholder = "Entity query";
  const run = h("button", "primary", "Run");
  toolbar.append(input, run);
  const table = h("div", "panel");
  view.append(toolbar, table);
  run.addEventListener("click", async () => {
    table.innerHTML = "";
    const data = await fetchGraph(scope, input.value);
    table.append(h("h2", "", "Entities"));
    for (const entity of data.entities) {
      table.append(h("div", "row", `${entity.displayName}  ${entity.type}  hotness ${entity.hotness.toFixed(2)}`));
    }
    table.append(h("h2", "", "Relations"));
    for (const relation of data.relations) {
      table.append(h("div", "row", `${relation.subjectId} ${relation.predicate} ${relation.objectId}  ${relation.confidence.toFixed(2)}`));
    }
  });
}

async function renderCandidates(view: HTMLElement) {
  // 候选区审核视图：只展示 pending 候选，approve 才会经 promoteCandidate 进入主库。
  // pending 候选不进入 5 槽位（由 context_fast 侧保证），这里仅做治理入口。
  const data = await fetchCandidates(scope, { status: "pending", limit: 50 });

  const summary = h("div", "metrics");
  summary.append(metricCard("pending", data.total));
  view.append(summary);

  if (data.candidates.length === 0) {
    view.append(h("div", "panel", "没有待审核候选"));
    return;
  }

  const list = h("div", "panel");
  const selected = new Set<string>();

  async function applyAction(action: CandidateReviewAction) {
    await reviewCandidates(action);
    await render();
  }

  const toolbar = h("div", "toolbar");
  const approveAll = h("button", "primary", "批量通过所选");
  approveAll.addEventListener("click", () => {
    if (selected.size === 0) return;
    void applyAction({ action: "approve", ids: [...selected] });
  });
  const rejectAll = h("button", "", "批量拒绝所选");
  rejectAll.addEventListener("click", () => {
    if (selected.size === 0) return;
    void applyAction({ action: "reject", ids: [...selected] });
  });
  toolbar.append(approveAll, rejectAll);
  view.append(toolbar);

  for (const candidate of data.candidates) {
    const row = h("div", "row candidate");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.addEventListener("change", () => {
      if (check.checked) selected.add(candidate.id);
      else selected.delete(candidate.id);
    });
    row.append(check);
    row.append(
      h(
        "span",
        "",
        `${candidate.semanticType ?? candidate.kind}  ${candidate.confidence.toFixed(2)}`
      )
    );
    row.append(h("p", "", candidate.preview));

    const approve = h("button", "primary", "通过");
    approve.addEventListener("click", () =>
      applyAction({ action: "approve", ids: [candidate.id] })
    );
    const reject = h("button", "", "拒绝");
    reject.addEventListener("click", () =>
      applyAction({ action: "reject", ids: [candidate.id] })
    );
    const archive = h("button", "", "归档");
    archive.addEventListener("click", () =>
      applyAction({ action: "archive", ids: [candidate.id] })
    );
    row.append(approve, reject, archive);
    list.append(row);
  }
  view.append(list);
}

async function renderJobs(view: HTMLElement) {
  const data = await fetchJobs();
  const metrics = h("div", "metrics");
  for (const [key, value] of Object.entries(data.counts)) {
    metrics.append(metricCard(key, value));
  }
  const list = h("div", "panel");
  for (const job of data.jobs) {
    list.append(h("div", "row", `${job.type}  ${job.status}  attempts ${job.attempts}`));
  }
  view.append(metrics, list);
}

async function render() {
  renderShell();
  const view = document.querySelector<HTMLElement>("#view")!;
  try {
    if (activeTab === "overview") await renderOverview(view);
    if (activeTab === "lookup") await renderLookup(view);
    if (activeTab === "graph") await renderGraph(view);
    if (activeTab === "candidates") await renderCandidates(view);
    if (activeTab === "jobs") await renderJobs(view);
  } catch (error) {
    view.append(h("div", "error", error instanceof Error ? error.message : String(error)));
  }
}

void render();
