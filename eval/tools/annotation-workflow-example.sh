#!/bin/bash
# Golden Set 标注流程示例
#
# 本脚本演示如何使用标注工具进行双人标注、一致性计算、仲裁和合并
#
# 使用方式：
#   bash eval/tools/annotation-workflow-example.sh

set -e

SUITE="mengshu-dedup"
ANNOTATOR_1="human_001"
ANNOTATOR_2="human_002"
ARBITRATOR="human_003"
TIMESTAMP=$(date +%s)

echo "=========================================="
echo "Golden Set 标注流程示例"
echo "套件: $SUITE"
echo "=========================================="
echo

# Step 1: 双人独立标注
echo "步骤 1: 双人独立标注"
echo "----------------------------------------"
echo
echo "Annotator 1 ($ANNOTATOR_1) 开始标注..."
echo "命令: node eval/tools/annotator.js annotate --suite $SUITE --annotator $ANNOTATOR_1"
echo
echo "⚠️  实际执行时，两位标注人需要在不同终端独立标注，不要讨论。"
echo
echo "Annotator 2 ($ANNOTATOR_2) 开始标注..."
echo "命令: node eval/tools/annotator.js annotate --suite $SUITE --annotator $ANNOTATOR_2"
echo
echo "✓ 标注完成后会生成以下文件："
echo "  - eval/results/${ANNOTATOR_1}_${SUITE}_${TIMESTAMP}.jsonl"
echo "  - eval/results/${ANNOTATOR_2}_${SUITE}_${TIMESTAMP}.jsonl"
echo
read -p "按回车继续到下一步..."
echo

# Step 2: 计算一致性
echo "步骤 2: 计算一致性"
echo "----------------------------------------"
echo
FILE_1="eval/results/${ANNOTATOR_1}_${SUITE}_${TIMESTAMP}.jsonl"
FILE_2="eval/results/${ANNOTATOR_2}_${SUITE}_${TIMESTAMP}.jsonl"
echo "命令: node eval/tools/annotator.js consistency \\"
echo "  --suite $SUITE \\"
echo "  --file1 $FILE_1 \\"
echo "  --file2 $FILE_2"
echo
echo "✓ 一致性报告示例："
echo "=== 一致性报告 ==="
echo "总样本数: 80"
echo "一致数量: 72"
echo "观察一致率 (P_o): 90.00%"
echo "随机一致率 (P_e): 24.50%"
echo "Cohen's Kappa: 0.867"
echo "✓ 一致性优秀（>= 0.85），可直接合并"
echo
echo "⚠️  导出 8 个分歧样例到: eval/results/conflicts_${SUITE}_${TIMESTAMP}.json"
echo
read -p "按回车继续到下一步..."
echo

# Step 3: 仲裁分歧样例
echo "步骤 3: 仲裁分歧样例"
echo "----------------------------------------"
echo
CONFLICT_FILE="eval/results/conflicts_${SUITE}_${TIMESTAMP}.json"
echo "命令: node eval/tools/annotator.js arbitrate \\"
echo "  --conflicts $CONFLICT_FILE \\"
echo "  --arbitrator $ARBITRATOR"
echo
echo "✓ 仲裁示例："
echo "[1/8] ID: dd-035"
echo "Task: update：增加原因"
echo "Annotator 1: update"
echo "Annotator 2: related"
echo "Memory A: 用 Vite"
echo "Memory B: 用 Vite 因为启动快"
echo "仲裁决定 (1/2/new, 回车=跳过): 1"
echo "仲裁理由: B 增加了 why（因为启动快），属于增量信息，判定为 update"
echo
echo "✓ 仲裁完成！共 8 条，已保存到 eval/results/arbitrated_${TIMESTAMP}.json"
echo
read -p "按回车继续到下一步..."
echo

# Step 4: 合并标注结果
echo "步骤 4: 合并标注结果"
echo "----------------------------------------"
echo
ARBITRATED_FILE="eval/results/arbitrated_${TIMESTAMP}.json"
OUTPUT_FILE="eval/goldens/${SUITE}-annotated.jsonl"
echo "命令: node eval/tools/annotator.js merge \\"
echo "  --suite $SUITE \\"
echo "  --file1 $FILE_1 \\"
echo "  --file2 $FILE_2 \\"
echo "  --arbitrated $ARBITRATED_FILE \\"
echo "  --output $OUTPUT_FILE"
echo
echo "✓ 合并完成！共 80 条"
echo "✓ 已保存 80 条到 $OUTPUT_FILE"
echo
echo "生成的标注元数据示例："
cat <<'EOF'
{
  "id": "dd-002",
  "suite": "mengshu-dedup",
  "task": "duplicate：同义表达中文",
  "memoryA": {"body": "交流用中文", "type": "profile"},
  "memoryB": {"body": "用中文交流", "type": "profile"},
  "expected": {"relation": "duplicate", "canonical": "交流用中文"},
  "annotation": {
    "annotator_1": "human_001",
    "annotator_1_label": "duplicate",
    "annotator_2": "human_002",
    "annotator_2_label": "duplicate",
    "agreement": "full",
    "boundaryCase": true,
    "lexicalSimilarity": 0.89,
    "annotatedAt": "2026-06-17T10:30:00Z",
    "notes": "中文近义词，0.88 阈值边界"
  }
}
EOF
echo
read -p "按回车继续到下一步..."
echo

# Step 5: 更新 manifest
echo "步骤 5: 更新 manifest"
echo "----------------------------------------"
echo
echo "计算新文件的 sha256："
echo "命令: shasum -a 256 $OUTPUT_FILE"
echo
echo "示例输出:"
echo "a1b2c3d4e5f6... eval/goldens/${SUITE}-annotated.jsonl"
echo
echo "手动更新 eval/goldens/manifest.json："
cat <<'EOF'
{
  "mengshu-dedup": {
    "file": "mengshu-dedup-annotated.jsonl",
    "size": 80,
    "sha256": "a1b2c3d4e5f6...",
    "coverage": {
      "duplicate": 30,
      "update": 10,
      "conflict": 20,
      "related": 15,
      "distinct": 5
    },
    "annotation": {
      "annotators": ["human_001", "human_002"],
      "arbitrator": "human_003",
      "kappa": 0.867,
      "annotatedAt": "2026-06-17"
    }
  }
}
EOF
echo
read -p "按回车继续到下一步..."
echo

# Step 6: 验证
echo "步骤 6: 验证"
echo "----------------------------------------"
echo
echo "运行评测验证标注质量："
echo "命令: npm run eval:quick -- $SUITE"
echo
echo "✓ 评测通过！"
echo
echo "提交代码："
echo "git add eval/goldens/${SUITE}-annotated.jsonl eval/goldens/manifest.json"
echo "git commit -m 'feat(eval): add human-annotated mengshu-dedup golden set (n=80, kappa=0.867)'"
echo

echo "=========================================="
echo "✓ 标注流程完成！"
echo "=========================================="
echo
echo "总结："
echo "1. 双人独立标注（2 人 × 2 小时 = 4 小时）"
echo "2. 一致性计算（自动，< 1 分钟）"
echo "3. 仲裁 8 个分歧样例（1 人 × 0.5 小时）"
echo "4. 合并标注结果（自动，< 1 分钟）"
echo "5. 更新 manifest（手动，5 分钟）"
echo "6. 验证通过（自动，< 1 分钟）"
echo
echo "总耗时: ~4.5 小时"
echo "输出: 80 条经过人工验证的黄金集（Kappa=0.867）"
echo

echo "下一步："
echo "- 对 mengshu-extraction 进行同样流程（100 条，预计 5-6 小时）"
echo "- 对 mengshu-recall-explain 进行验证（60 条，预计 3-4 小时）"
echo "- 扩充 mengshu-tree-summary 至 50 条（P1 阶段）"
echo "- 扩充 mengshu-conflict 至 30 条（P1 阶段）"
echo
echo "详见: eval/EXPANSION_PLAN.md"
