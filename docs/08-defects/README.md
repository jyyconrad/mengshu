# 08-defects 缺陷记录

## 用途
缺陷根因分析和修复记录，防止重复引入同类问题

## 文件命名
`DEFECT-{序号}-{标题}.md`

## 编号规则
`DEFECT-001`, `DEFECT-002`... (按发现顺序)

## 文件模板
```markdown
# DEFECT-{序号} - {标题}

## 缺陷描述
{缺陷现象和影响范围}

## 发现时间
{YYYY-MM-DD}

## 严重级别
{Critical/Major/Minor}

## 根因分析
{根本原因分析}

## 修复方案
{修复的具体方案}

## 修复记录
- 修复人：{姓名}
- 修复时间：{YYYY-MM-DD}
- 关联 PR: #{PR 号}

## 防止再发
{防止再次发生的措施}
- [ ] 添加测试用例
- [ ] 更新代码审查清单
- [ ] 添加静态检查规则
```

## 示例
```
08-defects/
├── DEFECT-001-python-scan-miss-secret.md
├── DEFECT-002-api-wrong-format.md
└── DEFECT-003-memory-leak.md
```

## 维护方式
用户描述缺陷，AI 分析记录
