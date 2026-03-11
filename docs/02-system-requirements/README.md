# 02-system-requirements 系统需求

## 用途
将业务需求转化为系统功能点清单和非功能约束

## 文件命名
`SR-{序号}-{主题}.md`

## 文件模板
```markdown
# SR-{序号} - {主题}

## 关联业务需求
- BR-{序号}: {业务需求标题}

## 功能需求
### FR-1 {功能名称}
{功能描述}

### FR-2 {功能名称}
{功能描述}

## 非功能需求
### 性能
{性能指标}

### 安全
{安全要求}

### 可用性
{可用性指标}

## 约束条件
{技术约束、依赖等}

## 验收标准
- [ ] 标准 1
- [ ] 标准 2

## 创建信息
- 创建人：{姓名}
- 创建日期：{YYYY-MM-DD}
- 最后更新：{YYYY-MM-DD}
```

## 示例
```
02-system-requirements/
├── SR-001-python-scanner-requirements.md
├── SR-002-frontend-scanner-requirements.md
└── SR-003-security-requirements.md
```

## 维护方式
AI 分析生成，用户确认
