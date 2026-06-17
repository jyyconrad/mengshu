#!/usr/bin/env node
/**
 * Golden Set 标注工具
 *
 * 功能：
 * 1. 加载 jsonl 文件进行标注
 * 2. 支持双人独立标注
 * 3. 计算标注一致性（Cohen's Kappa）
 * 4. 仲裁分歧样例
 * 5. 导出带标注元数据的 jsonl
 *
 * 使用方式：
 *   # 标注模式
 *   node eval/tools/annotator.js annotate --suite mengshu-dedup --annotator human_001
 *
 *   # 一致性计算
 *   node eval/tools/annotator.js consistency --suite mengshu-dedup \
 *     --file1 results/human_001.jsonl --file2 results/human_002.jsonl
 *
 *   # 仲裁模式
 *   node eval/tools/annotator.js arbitrate --suite mengshu-dedup \
 *     --conflicts results/conflicts.json --arbitrator human_003
 *
 *   # 合并模式
 *   node eval/tools/annotator.js merge --suite mengshu-dedup \
 *     --file1 results/human_001.jsonl --file2 results/human_002.jsonl \
 *     --output goldens/mengshu-dedup-annotated.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types
// ============================================================================

/**
 * @typedef {Object} AnnotationMetadata
 * @property {string} annotator - 标注人 ID
 * @property {string} annotatedAt - 标注时间
 * @property {string} [reviewedBy] - 审核人
 * @property {string} [reviewedAt] - 审核时间
 * @property {string} agreement - 一致性状态（full/partial/conflict）
 * @property {boolean} [boundaryCase] - 是否边界样例
 * @property {number} [lexicalSimilarity] - lexical 相似度（dedup 用）
 * @property {string} [notes] - 备注
 */

/**
 * @typedef {Object} DedupAnnotation
 * @property {string} annotator_1
 * @property {string} annotator_1_label
 * @property {string} annotator_2
 * @property {string} annotator_2_label
 * @property {string} agreement
 * @property {string} [arbitrator]
 * @property {string} [finalLabel]
 * @property {string} [arbitrationReason]
 * @property {string} annotatedAt
 * @property {string} [arbitratedAt]
 * @property {boolean} [boundaryCase]
 * @property {number} [lexicalSimilarity]
 */

// ============================================================================
// Utilities
// ============================================================================

function loadJsonl(filePath) {
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  return lines
    .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("//"))
    .map((line) => JSON.parse(line));
}

function saveJsonl(filePath, cases) {
  const lines = cases.map((c) => JSON.stringify(c)).join("\n");
  fs.writeFileSync(filePath, lines + "\n", "utf-8");
  console.log(`✓ 已保存 ${cases.length} 条到 ${filePath}`);
}

function timestamp() {
  return new Date().toISOString();
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// Annotate 模式
// ============================================================================

async function annotateMode(options) {
  const { suite, annotator } = options;
  const inputFile = path.join(__dirname, `../goldens/${suite}.jsonl`);
  const outputFile = path.join(__dirname, `../results/${annotator}_${suite}_${Date.now()}.jsonl`);

  if (!fs.existsSync(inputFile)) {
    console.error(`✗ 文件不存在: ${inputFile}`);
    process.exit(1);
  }

  const cases = loadJsonl(inputFile);
  console.log(`\n加载了 ${cases.length} 条 case，开始标注...\n`);

  const annotated = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    console.log(`\n[${ i + 1}/${cases.length}] ID: ${c.id}`);
    console.log(`Task: ${c.task || c.expected?.candidates?.[0]?.body || "N/A"}`);

    if (suite.includes("dedup")) {
      console.log(`Memory A: ${c.memoryA.body}`);
      console.log(`Memory B: ${c.memoryB.body}`);
      console.log(`Expected: ${c.expected.relation}`);

      const label = await prompt("你的标注 (duplicate/update/conflict/related/distinct, 回车=同意预期): ");
      const finalLabel = label || c.expected.relation;
      const boundaryCase = await prompt("是否边界样例？(y/n, 默认 n): ");

      c.annotation = {
        annotator,
        label: finalLabel,
        boundaryCase: boundaryCase.toLowerCase() === "y",
        annotatedAt: timestamp(),
      };
    } else if (suite.includes("extraction")) {
      console.log(`Scope: ${JSON.stringify(c.scope)}`);
      console.log(`Input: ${JSON.stringify(c.input?.conversation || c.input).slice(0, 200)}...`);
      console.log(`Expected candidates: ${c.expected.candidates?.length || 0}`);

      const verify = await prompt("验证通过？(y/n/s=跳过, 默认 y): ");
      if (verify.toLowerCase() === "s") {
        continue;
      }

      const notes = await prompt("备注（可选）: ");

      c.annotation = {
        annotator,
        verified: verify.toLowerCase() !== "n",
        annotatedAt: timestamp(),
        notes: notes || undefined,
      };
    } else {
      // 其他套件通用标注
      const verify = await prompt("验证通过？(y/n/s=跳过, 默认 y): ");
      if (verify.toLowerCase() === "s") {
        continue;
      }

      c.annotation = {
        annotator,
        verified: verify.toLowerCase() !== "n",
        annotatedAt: timestamp(),
      };
    }

    annotated.push(c);
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  saveJsonl(outputFile, annotated);
  console.log(`\n✓ 标注完成！共 ${annotated.length} 条`);
}

// ============================================================================
// Consistency 模式
// ============================================================================

function calculateCohenKappa(labels1, labels2) {
  if (labels1.length !== labels2.length) {
    throw new Error("标注数量不一致");
  }

  const n = labels1.length;
  const categories = [...new Set([...labels1, ...labels2])];
  const k = categories.length;

  // 观察到的一致比例
  let agree = 0;
  for (let i = 0; i < n; i++) {
    if (labels1[i] === labels2[i]) agree++;
  }
  const p_o = agree / n;

  // 随机一致比例
  const counts1 = {};
  const counts2 = {};
  for (const cat of categories) {
    counts1[cat] = labels1.filter((l) => l === cat).length;
    counts2[cat] = labels2.filter((l) => l === cat).length;
  }

  let p_e = 0;
  for (const cat of categories) {
    p_e += (counts1[cat] / n) * (counts2[cat] / n);
  }

  const kappa = (p_o - p_e) / (1 - p_e);
  return { kappa, p_o, p_e, agree, total: n };
}

function consistencyMode(options) {
  const { file1, file2, suite } = options;

  if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
    console.error("✗ 文件不存在");
    process.exit(1);
  }

  const cases1 = loadJsonl(file1);
  const cases2 = loadJsonl(file2);

  if (cases1.length !== cases2.length) {
    console.error(`✗ 标注数量不一致: ${cases1.length} vs ${cases2.length}`);
    process.exit(1);
  }

  // 对齐 case（按 id）
  const map1 = Object.fromEntries(cases1.map((c) => [c.id, c]));
  const map2 = Object.fromEntries(cases2.map((c) => [c.id, c]));
  const ids = cases1.map((c) => c.id).filter((id) => map1[id] && map2[id]);

  const labels1 = ids.map((id) => map1[id].annotation?.label || map1[id].expected?.relation);
  const labels2 = ids.map((id) => map2[id].annotation?.label || map2[id].expected?.relation);

  const result = calculateCohenKappa(labels1, labels2);

  console.log("\n=== 一致性报告 ===");
  console.log(`总样本数: ${result.total}`);
  console.log(`一致数量: ${result.agree}`);
  console.log(`观察一致率 (P_o): ${(result.p_o * 100).toFixed(2)}%`);
  console.log(`随机一致率 (P_e): ${(result.p_e * 100).toFixed(2)}%`);
  console.log(`Cohen's Kappa: ${result.kappa.toFixed(3)}`);

  if (result.kappa >= 0.85) {
    console.log("✓ 一致性优秀（>= 0.85），可直接合并");
  } else if (result.kappa >= 0.70) {
    console.log("⚠️  一致性良好（0.70-0.85），建议审核分歧样例");
  } else {
    console.log("✗ 一致性不足（< 0.70），需重新标注");
  }

  // 导出分歧样例
  const conflicts = [];
  for (const id of ids) {
    const label1 = map1[id].annotation?.label || map1[id].expected?.relation;
    const label2 = map2[id].annotation?.label || map2[id].expected?.relation;
    if (label1 !== label2) {
      conflicts.push({
        id,
        task: map1[id].task,
        annotator_1_label: label1,
        annotator_2_label: label2,
        case: map1[id],
      });
    }
  }

  if (conflicts.length > 0) {
    const conflictFile = path.join(__dirname, `../results/conflicts_${suite}_${Date.now()}.json`);
    fs.mkdirSync(path.dirname(conflictFile), { recursive: true });
    fs.writeFileSync(conflictFile, JSON.stringify(conflicts, null, 2), "utf-8");
    console.log(`\n⚠️  导出 ${conflicts.length} 个分歧样例到: ${conflictFile}`);
  } else {
    console.log("\n✓ 无分歧样例");
  }
}

// ============================================================================
// Arbitrate 模式
// ============================================================================

async function arbitrateMode(options) {
  const { conflicts: conflictFile, arbitrator } = options;

  if (!fs.existsSync(conflictFile)) {
    console.error(`✗ 冲突文件不存在: ${conflictFile}`);
    process.exit(1);
  }

  const conflicts = JSON.parse(fs.readFileSync(conflictFile, "utf-8"));
  console.log(`\n加载了 ${conflicts.length} 个分歧样例，开始仲裁...\n`);

  const arbitrated = [];

  for (let i = 0; i < conflicts.length; i++) {
    const c = conflicts[i];
    console.log(`\n[${i + 1}/${conflicts.length}] ID: ${c.id}`);
    console.log(`Task: ${c.task}`);
    console.log(`Annotator 1: ${c.annotator_1_label}`);
    console.log(`Annotator 2: ${c.annotator_2_label}`);

    if (c.case.memoryA) {
      console.log(`Memory A: ${c.case.memoryA.body}`);
      console.log(`Memory B: ${c.case.memoryB.body}`);
    }

    const choice = await prompt("仲裁决定 (1/2/new, 回车=跳过): ");
    if (!choice) continue;

    let finalLabel;
    if (choice === "1") {
      finalLabel = c.annotator_1_label;
    } else if (choice === "2") {
      finalLabel = c.annotator_2_label;
    } else {
      finalLabel = choice;
    }

    const reason = await prompt("仲裁理由: ");

    arbitrated.push({
      ...c,
      arbitrator,
      finalLabel,
      arbitrationReason: reason,
      arbitratedAt: timestamp(),
    });
  }

  const outputFile = path.join(__dirname, `../results/arbitrated_${Date.now()}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(arbitrated, null, 2), "utf-8");
  console.log(`\n✓ 仲裁完成！共 ${arbitrated.length} 条，已保存到 ${outputFile}`);
}

// ============================================================================
// Merge 模式
// ============================================================================

function mergeMode(options) {
  const { file1, file2, output, arbitrated } = options;

  if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
    console.error("✗ 文件不存在");
    process.exit(1);
  }

  const cases1 = loadJsonl(file1);
  const cases2 = loadJsonl(file2);

  const map1 = Object.fromEntries(cases1.map((c) => [c.id, c]));
  const map2 = Object.fromEntries(cases2.map((c) => [c.id, c]));

  // 加载仲裁结果
  let arbitrationMap = {};
  if (arbitrated && fs.existsSync(arbitrated)) {
    const arb = JSON.parse(fs.readFileSync(arbitrated, "utf-8"));
    arbitrationMap = Object.fromEntries(arb.map((a) => [a.id, a]));
  }

  const merged = [];
  const ids = [...new Set([...cases1.map((c) => c.id), ...cases2.map((c) => c.id)])];

  for (const id of ids) {
    const c1 = map1[id];
    const c2 = map2[id];

    if (!c1 || !c2) {
      console.warn(`⚠️  ID ${id} 仅在一个文件中存在，跳过`);
      continue;
    }

    const label1 = c1.annotation?.label || c1.expected?.relation;
    const label2 = c2.annotation?.label || c2.expected?.relation;

    let finalCase = { ...c1 };

    if (label1 === label2) {
      // 一致，直接合并
      finalCase.annotation = {
        annotator_1: c1.annotation?.annotator || "unknown",
        annotator_1_label: label1,
        annotator_2: c2.annotation?.annotator || "unknown",
        annotator_2_label: label2,
        agreement: "full",
        annotatedAt: c1.annotation?.annotatedAt || timestamp(),
      };
    } else if (arbitrationMap[id]) {
      // 有仲裁结果
      const arb = arbitrationMap[id];
      finalCase.annotation = {
        annotator_1: c1.annotation?.annotator || "unknown",
        annotator_1_label: label1,
        annotator_2: c2.annotation?.annotator || "unknown",
        annotator_2_label: label2,
        agreement: "arbitrated",
        arbitrator: arb.arbitrator,
        finalLabel: arb.finalLabel,
        arbitrationReason: arb.arbitrationReason,
        annotatedAt: c1.annotation?.annotatedAt || timestamp(),
        arbitratedAt: arb.arbitratedAt,
      };
      // 更新 expected
      if (finalCase.expected?.relation) {
        finalCase.expected.relation = arb.finalLabel;
      }
    } else {
      // 无仲裁，标记冲突
      finalCase.annotation = {
        annotator_1: c1.annotation?.annotator || "unknown",
        annotator_1_label: label1,
        annotator_2: c2.annotation?.annotator || "unknown",
        annotator_2_label: label2,
        agreement: "conflict",
        annotatedAt: c1.annotation?.annotatedAt || timestamp(),
      };
    }

    merged.push(finalCase);
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  saveJsonl(output, merged);
  console.log(`\n✓ 合并完成！共 ${merged.length} 条`);
}

// ============================================================================
// CLI
// ============================================================================

function printHelp() {
  console.log(`
Golden Set 标注工具

用法:
  node eval/tools/annotator.js <command> [options]

命令:
  annotate       标注模式（单人标注）
  consistency    计算一致性（双人标注对比）
  arbitrate      仲裁模式（解决分歧）
  merge          合并模式（生成最终标注结果）

示例:
  # 标注
  node eval/tools/annotator.js annotate --suite mengshu-dedup --annotator human_001

  # 一致性
  node eval/tools/annotator.js consistency --suite mengshu-dedup \\
    --file1 results/human_001_mengshu-dedup.jsonl \\
    --file2 results/human_002_mengshu-dedup.jsonl

  # 仲裁
  node eval/tools/annotator.js arbitrate \\
    --conflicts results/conflicts_mengshu-dedup.json \\
    --arbitrator human_003

  # 合并
  node eval/tools/annotator.js merge --suite mengshu-dedup \\
    --file1 results/human_001_mengshu-dedup.jsonl \\
    --file2 results/human_002_mengshu-dedup.jsonl \\
    --arbitrated results/arbitrated.json \\
    --output goldens/mengshu-dedup-annotated.jsonl
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    options[key] = args[i + 1];
  }

  switch (command) {
    case "annotate":
      await annotateMode(options);
      break;
    case "consistency":
      consistencyMode(options);
      break;
    case "arbitrate":
      await arbitrateMode(options);
      break;
    case "merge":
      mergeMode(options);
      break;
    default:
      console.error(`✗ 未知命令: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("✗ 错误:", err);
  process.exit(1);
});
