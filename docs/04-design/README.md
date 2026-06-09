# 04-design 详细设计

## 目录结构

### 04.1-overview 模块设计
- 每个模块的流程设计
- 模块交互关系
- 粒度适中

### 04.2-detail 详细设计
- 每个功能点的具体实现方案
- AI 写代码前的蓝图
- 详细的算法和边界条件

## 文件命名

### 04.1-overview
`{模块名}-design.md`

### 04.2-detail
`{功能名}-detail.md`

## 模块设计模板
```markdown
# {模块名} Design

## 模块职责
{模块负责的功能}

## 模块接口
{对外提供的接口}

## 模块交互
{与其他模块的交互流程}

## 错误处理
{错误处理策略}

## 流程图
{流程图或时序图}
```

## 详细设计模板
```markdown
# {功能名} Detail

## 功能描述
{功能详细说明}

## 输入输出
- 输入：{输入数据和格式}
- 输出：{输出数据和格式}

## 算法设计
{具体算法或逻辑}

## 边界条件
{边界情况和处理}

## 数据结构
{使用的数据结构}

## 伪代码
{关键逻辑的伪代码}
```

## 示例
```
04-design/
├── 04.1-overview/
│   ├── scanner-module-design.md
│   ├── rule-engine-design.md
│   └── web-console-design.md
└── 04.2-detail/
    ├── python-scanner-detail.md
    ├── bandit-integration-detail.md
    ├── memory-middleware-development-plan.md
    └── structured-knowledge-graph-memory-tree-detail.md
```

## 维护方式
AI 生成，用户确认
