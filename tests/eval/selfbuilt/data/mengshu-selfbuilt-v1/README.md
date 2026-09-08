# Mengshu Self-Built Evaluation Dataset v1

本目录是仓库可见的确定性自建评测集，不读取生产私有正文，也不依赖开源 benchmark。

| 文件 | 用途 |
| --- | --- |
| `cases.jsonl` | 360 条机器可读 case；每行一个完整 case |
| `manifest.json` | 数据版本、配额、交叉分布和 SHA-256 |
| `cases.xlsx` | 人工检查版；包含说明、Cases、Events、Coverage 四张表 |

数据分为 72 条 dev 和 288 条 test，覆盖 6 个能力族与 6 个场景，每个能力 × 场景固定 10 条。

```bash
npm run eval:selfbuilt:prepare
npm run eval:selfbuilt:round1
npm run eval:selfbuilt:round2
npm run eval:selfbuilt:finalize
```

SBS 仅为 `selfbuilt-diagnostic`，`formalReleaseEligible=false`，不能替代正式 GMS/PMS。
