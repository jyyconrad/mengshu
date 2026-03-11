# 06-database 数据库设计

## 用途
数据表结构、字段说明、索引设计

## 文件命名
`{设计主题}.md`

## 文件模板
```markdown
# {表名}

## 表结构
| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | UUID | 是 | | 主键 |
| created_at | TIMESTAMP | 是 | NOW() | 创建时间 |
| updated_at | TIMESTAMP | 是 | NOW() | 更新时间 |

## 索引设计
| 索引名 | 字段 | 类型 | 说明 |
|--------|------|------|------|
| idx_{field} | {field} | BTREE | 加速查询 |

## 约束
| 约束名 | 类型 | 说明 |
|--------|------|------|
| pk_{table} | PRIMARY KEY | 主键约束 |

## 表关系
{与其他表的关系}

## 示例数据
```sql
INSERT INTO {table} (id, field) VALUES ('uuid', 'value');
```
```

## 示例
```
06-database/
├── schema.md
├── scan-result-table.md
├── scanner-config-table.md
└── index-design.md
```

## 维护方式
AI 随开发同步更新
