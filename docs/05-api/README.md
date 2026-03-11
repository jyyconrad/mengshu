# 05-api API 文档

## 用途
所有 REST 接口的请求/响应格式、状态码

## 文件命名
`{API 主题}-api.md`

## 文件模板
```markdown
# {API 主题} API

## 接口列表
| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/v1/{resource} | 获取资源列表 |
| POST | /api/v1/{resource} | 创建资源 |

## 接口详情

### GET /api/v1/{resource}

**描述**: {接口描述}

**请求 Headers**:
```
Authorization: Bearer {token}
Content-Type: application/json
```

**请求参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | number | 否 | 页码 |
| limit | number | 否 | 每页数量 |

**响应示例**:
```json
{
  "data": [],
  "meta": {
    "total": 100,
    "page": 1,
    "limit": 10
  }
}
```

**状态码**:
| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未授权 |
| 404 | 资源不存在 |
| 500 | 服务器错误 |
```

## 示例
```
05-api/
├── scan-api.md
├── scanner-management-api.md
├── result-api.md
└── error-codes.md
```

## 维护方式
AI 随开发同步更新
