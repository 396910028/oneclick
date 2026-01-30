# 后端 API 接口说明（XBoard 风格）

当前所有接口前缀统一为：`/api`

## 一、认证相关 `/api/auth`

### 1. 注册

- **URL**：`POST /api/auth/register`
- **请求体（JSON）**：
  - `username` string 必填
  - `email` string 必填
  - `password` string 必填
- **返回示例**：

```json
{
  "code": 200,
  "message": "注册成功",
  "data": {
    "id": 1,
    "username": "test",
    "email": "test@example.com"
  }
}
```

### 2. 登录

- **URL**：`POST /api/auth/login`
- **请求体（JSON）**：
  - `username` string 必填（可以是用户名或邮箱）
  - `password` string 必填
- **返回示例**：

```json
{
  "code": 200,
  "message": "登录成功",
  "data": {
    "token": "JWT_TOKEN_HERE",
    "user": {
      "id": 1,
      "username": "test",
      "email": "test@example.com",
      "role": "user"
    }
  }
}
```

- **说明**：
  - 前端需要将 `data.token` 保存（建议 LocalStorage）
  - 之后所有需要登录的接口，在请求头中带上：
    - `Authorization: Bearer <token>`

---

## 零、内部接口（仅节点/对接程序使用）`/api/internal`

> 这些接口用于“机场级别控制”：即使客户端不刷新订阅，节点也能按 UUID 立即断网。  
> **鉴权方式**：请求头必须包含 `x-internal-token: <INTERNAL_API_KEY>`（后端从环境变量 `INTERNAL_API_KEY` 读取）。

### 0.1 注册/更新节点（给一键开局脚本用）

- **URL**：`POST /api/internal/register-node`
- **请求头**：`x-internal-token: <INTERNAL_API_KEY>`
- **请求体（JSON）**：
  - `name` string 必填
  - `address` string 必填（节点公网 IP 或域名）
  - `port` number 必填
  - `protocol` string 必填（`vless/vmess/trojan/shadowsocks/hysteria2/socks/http/wireguard`）
  - `config` object|string 必填（节点配置 JSON）
  - `status` number 可选（1/0）
  - `sort_order` number 可选
  - `plan_ids` number[] 可选（绑定套餐；传空数组表示清空绑定）
- **说明**：
  - 幂等：按 `address + port + protocol` 视为同一节点，存在则更新，否则创建
  - 绑定套餐会写入 `plan_nodes`

### 0.2 拉取某节点允许的 UUID 列表（给对接程序同步用）

- **URL**：`GET /api/internal/nodes/:nodeId/allowed-uuids`
- **请求头**：`x-internal-token: <INTERNAL_API_KEY>`
- **返回**：`uuids: string[]`
- **说明**：
  - 后端会按用户 **paid 订单 + period 叠加**计算是否仍在有效期内
  - 并校验用户状态、流量是否超限，以及该用户是否拥有该 node 权限

### 0.3 单次鉴权（给新连接实时校验用）

- **URL**：`GET /api/internal/auth?uuid=...&node_id=...`
- **请求头**：`x-internal-token: <INTERNAL_API_KEY>`
- **返回**：`allow: boolean` + `reason`

### 0.4 上报流量（给对接程序记账用）

- **URL**：`POST /api/internal/report-traffic`
- **请求头**：`x-internal-token: <INTERNAL_API_KEY>`
- **请求体（JSON）**：`{ uuid, node_id, upload, download }`
- **效果**：
  - `users.traffic_used += upload + download`
  - `node_traffic` 按天累加（要求 `UNIQUE(node_id, date)`）

---

## 二、健康检查 `/api/health`

- **URL**：`GET /api/health`
- **说明**：仅用于检查后端和数据库是否正常
- **返回示例**：

```json
{
  "code": 200,
  "message": "OK",
  "data": {
    "db": "connected"
  }
}
```

---

## 三、套餐计划 `plans` `/api/plans`

### 1. 获取套餐列表

- **URL**：`GET /api/plans`
- **认证**：不需要登录（用于展示公开套餐）
- **查询参数**：
  - `page` number 可选，默认 1
  - `size` number 可选，默认 20
  - `keyword` string 可选，按名称模糊搜索
- **数据来源表**：`plans`
- **返回示例**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "list": [
      {
        "id": 1,
        "name": "基础套餐",
        "description": "适合轻度使用",
        "level": 0,
        "month_price": 19.9,
        "quarter_price": 49.9,
        "year_price": 199.0,
        "traffic_limit": 107374182400,
        "speed_limit": 100,
        "connections": 3,
        "reset_traffic_cycle": "month",
        "is_public": 1,
        "status": 1
      }
    ],
    "total": 1,
    "page": 1,
    "size": 20
  }
}
```

### 2. 获取单个套餐详情

- **URL**：`GET /api/plans/:id`
- **认证**：不需要登录
- **路径参数**：
  - `id` 套餐 ID
- **返回示例**：同上 `list` 中的单条记录

---

## 四、订单 `orders` `/api/orders`

所有订单接口都需要登录，需在请求头带上：

```http
Authorization: Bearer <token>
```

### 1. 获取当前用户订单列表

- **URL**：`GET /api/orders`
- **认证**：需要
- **查询参数**：
  - `page` number 可选，默认 1
  - `size` number 可选，默认 20
- **数据来源表**：`orders` + `plans`
- **返回示例**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "list": [
      {
        "id": 1,
        "order_no": "ORD202601280001",
        "amount": 19.9,
        "status": "pending",
        "pay_method": "balance",
        "period": "month",
        "created_at": "2026-01-28T12:00:00.000Z",
        "paid_at": null,
        "plan_name": "基础套餐"
      }
    ],
    "total": 1,
    "page": 1,
    "size": 20
  }
}
```

### 2. 创建订单（基于套餐）

- **URL**：`POST /api/orders`
- **认证**：需要
- **请求体（JSON）**：
  - `plan_id` number 必填，套餐 ID
  - `period` string 必填，`month` / `quarter` / `year`
  - `pay_method` string 可选，默认 `balance`，可选值：`balance` / `alipay` / `wechat` / `crypto`
- **行为说明**：
  - 后端根据 `plan_id` 查询 `plans` 表
  - 根据 `period` 选择对应价格字段：
    - `month` → `month_price`
    - `quarter` → `quarter_price`
    - `year` → `year_price`
  - 普通用户：若对应周期价格为空或 ≤ 0，则返回错误；否则插入一条 `orders` 记录，`status = 'pending'`
  - **管理员用户（`users.role = 'admin'`）**：即使价格大于 0，也会视为 **免费订购**，插入时强制 `amount = 0` 且 `status = 'paid'`，`paid_at = NOW()`
- **返回示例**：

```json
{
  "code": 200,
  "message": "订单创建成功（待支付）",
  "data": {
    "id": 1,
    "order_no": "ORD202601280001",
    "amount": 19.9,
    "period": "month"
  }
}
```

> 后续如果接支付通道，可以增加 `/api/orders/:id/pay` 等接口。

---

## 五、工单 `tickets` `/api/tickets`

所有工单接口都需要登录。

### 1. 获取当前用户工单列表

- **URL**：`GET /api/tickets`
- **认证**：需要
- **查询参数**：
  - `page` number 可选，默认 1
  - `size` number 可选，默认 20
  - `status` string 可选，`open` / `in_progress` / `resolved` / `closed`
- **数据来源表**：`tickets`
- **返回示例**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "list": [
      {
        "id": 1,
        "ticket_no": "TK202601280001",
        "title": "无法连接节点",
        "category": "technical",
        "status": "open",
        "priority": "medium",
        "created_at": "2026-01-28T12:00:00.000Z",
        "updated_at": "2026-01-28T12:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "size": 20
  }
}
```

### 2. 创建工单

- **URL**：`POST /api/tickets`
- **认证**：需要
- **请求体（JSON）**：
  - `title` string 必填
  - `content` string 必填
  - `category` string 可选，`technical` / `billing` / `account` / `other`，默认 `other`
  - `priority` string 可选，`low` / `medium` / `high` / `urgent`，默认 `medium`
- **行为**：
  - 自动生成工单号：`TK + 时间戳 + 随机数`
  - 插入 `tickets` 表
- **返回示例**：

```json
{
  "code": 200,
  "message": "工单创建成功",
  "data": {
    "id": 1,
    "ticket_no": "TK202601280001"
  }
}
```

### 3. 获取工单详情（含回复）

- **URL**：`GET /api/tickets/:id`
- **认证**：需要
- **路径参数**：
  - `id` 工单 ID
- **数据来源表**：`tickets` + `ticket_replies`
- **返回示例**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "ticket": {
      "id": 1,
      "ticket_no": "TK202601280001",
      "title": "无法连接节点",
      "content": "具体报错信息……",
      "category": "technical",
      "status": "open",
      "priority": "medium",
      "created_at": "2026-01-28T12:00:00.000Z",
      "updated_at": "2026-01-28T12:00:00.000Z"
    },
    "replies": [
      {
        "id": 1,
        "user_id": 1,
        "is_admin": 0,
        "content": "这是用户的补充说明",
        "attachments": null,
        "created_at": "2026-01-28T12:10:00.000Z"
      }
    ]
  }
}
```

### 4. 回复工单

- **URL**：`POST /api/tickets/:id/reply`
- **认证**：需要
- **请求体（JSON）**：
  - `content` string 必填
- **行为**：
  - 先校验工单是否属于当前用户
  - 插入 `ticket_replies` 一条新记录
- **返回示例**：

```json
{
  "code": 200,
  "message": "回复成功",
  "data": null
}
```

---

## 六、管理员后台接口 `/api/admin/*`

所有 `/api/admin/*` 接口均需要：

- 已登录
- 用户角色为 `admin`（`users.role = 'admin'`）

### 1. 用户管理 `/api/admin/users`

#### 1.1 获取用户列表

- **URL**：`GET /api/admin/users`
- **认证**：管理员
- **查询参数**：
  - `page` number 可选，默认 1
  - `size` number 可选，默认 20
  - `keyword` string 可选，在用户名/邮箱中模糊搜索
- **数据来源表**：`users`
- **返回**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "list": [
      {
        "id": 1,
        "email": "user@example.com",
        "username": "user1",
        "role": "user",
        "status": "active",
        "balance": 0,
        "traffic_total": 0,
        "traffic_used": 0,
        "expired_at": null,
        "created_at": "2026-01-28T12:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "size": 20
  }
}
```

#### 1.2 更新用户信息

- **URL**：`PATCH /api/admin/users/:id`
- **认证**：管理员
- **请求体（JSON）**（均为可选字段，至少要有一个）：
  - `status` string：`active` / `banned`
  - `role` string：`user` / `admin`
  - `balance` number：账户余额
  - `expired_at` string：到期时间（`YYYY-MM-DD HH:mm:ss` 或 ISO 字符串）
- **行为**：仅更新请求体中提供的字段。可用 `status: 'active'` / `'banned'` 启用/停用用户，`role: 'admin'` / `'user'` 升级/取消管理员。

#### 1.3 删除用户

- **URL**：`DELETE /api/admin/users/:id`
- **认证**：管理员
- **行为**：物理删除该用户；其订单、工单等因外键级联会一并删除。**不能删除当前登录的管理员自己**（返回 400）。
- **返回**：成功 `{ code: 200, message: "用户已删除", data: { affectedRows: 1 } }`；用户不存在 404；删除自己 400。

---

### 2. 套餐管理 `/api/admin/plans`

#### 2.1 获取全部套餐

- **URL**：`GET /api/admin/plans`
- **认证**：管理员
- **数据来源表**：`plans`

#### 2.2 创建套餐

- **URL**：`POST /api/admin/plans`
- **认证**：管理员
- **请求体（JSON）**：
  - `name` string 必填
  - `month_price` number 必填
  - `description` string 可选
  - `level` number 可选
  - `quarter_price` number 可选
  - `year_price` number 可选
  - `traffic_limit` number 可选（字节）
  - `speed_limit` number 可选
  - `connections` number 可选
  - `reset_traffic_cycle` string 可选，`month` / `none`
  - `is_public` number 可选，1/0
  - `status` number 可选，1/0

#### 2.3 更新套餐

- **URL**：`PUT /api/admin/plans/:id`
- **认证**：管理员
- **请求体（JSON）**：
  - 可包含 `name/description/level/month_price/.../status` 任意字段，全部为可选

#### 2.4 下架套餐

- **URL**：`DELETE /api/admin/plans/:id`
- **认证**：管理员
- **行为**：将 `plans.status` 置为 0，`is_public` 置为 0（逻辑下架）

---

### 3. 订单管理 `/api/admin/orders`

#### 3.1 查询订单列表

- **URL**：`GET /api/admin/orders`
- **认证**：管理员
- **查询参数**：
  - `page` number 可选，默认 1
  - `size` number 可选，默认 20
  - `status` string 可选：`pending` / `paid` / `cancelled` / `expired`
  - `user_id` number 可选
  - `plan_id` number 可选
- **数据来源表**：`orders` + `users` + `plans`

返回的每条记录包含：

- `order_no`、`amount`、`status`、`pay_method`、`period`、`created_at`、`paid_at`、`pay_expire_at`（= `created_at + 30 分钟`）
- `user_email`、`username`
- `plan_name`

> 可用于后台订单列表、订单详情查看。

#### 3.2 强制标记为已支付

- **URL**：`POST /api/admin/orders/:id/force-pay`
- **认证**：管理员
- **行为**：
  - 若订单存在且当前状态不是 `paid`，则将 `status` 强制更新为 `paid`，并将 `paid_at` 置为当前时间
  - 若订单已是 `paid`，返回 400 错误
- **返回示例**：

```json
{
  "code": 200,
  "message": "已强制标记为已支付",
  "data": null
}
```

#### 3.3 强制取消订单

- **URL**：`POST /api/admin/orders/:id/force-cancel`
- **认证**：管理员
- **行为**：
  - 若订单存在且当前状态不是 `cancelled`，则将 `status` 强制更新为 `cancelled`
  - 若订单已是 `cancelled`，返回 400 错误
- **返回示例**：

```json
{
  "code": 200,
  "message": "订单已强制取消",
  "data": null
}
```

---

### 4. 工单管理 `/api/admin/tickets`

#### 4.1 查询所有工单

- **URL**：`GET /api/admin/tickets`
- **认证**：管理员
- **查询参数**：
  - `page` number 可选，默认 1
  - `size` number 可选，默认 20
  - `status` string 可选：`open` / `in_progress` / `resolved` / `closed`
  - `category` string 可选：`technical` / `billing` / `account` / `other`

#### 4.2 更新工单状态/优先级

- **URL**：`PATCH /api/admin/tickets/:id`
- **认证**：管理员
- **请求体（JSON）**：
  - `status` string 可选
  - `priority` string 可选

#### 4.3 管理员回复工单

- **URL**：`POST /api/admin/tickets/:id/reply`
- **认证**：管理员
- **请求体（JSON）**：
  - `content` string 必填
- **行为**：
  - 在 `ticket_replies` 表中插入一条 `is_admin = 1` 的回复
  - 更新 `tickets.admin_id` 为当前管理员 ID

#### 4.4 删除工单

- **URL**：`DELETE /api/admin/tickets/:id`
- **认证**：管理员
- **行为**：物理删除该工单及其关联的 `ticket_replies` 记录；工单不存在时返回 404。
- **返回示例**：

```json
{
  "code": 200,
  "message": "工单已删除",
  "data": { "affectedRows": 1 }
}
```

---

## 七、前端调用约定

1. 所有成功返回统一格式：

```json
{
  "code": 200,
  "message": "success",
  "data": { }
}
```

2. 失败时：

```json
{
  "code": 400,
  "message": "错误提示信息",
  "data": null
}
```

3. 登录态失效或未登录：
   - HTTP 状态码：`401`
   - JSON：

```json
{
  "code": 401,
  "message": "未登录或Token缺失",
  "data": null
}
```

前端统一在 Axios 拦截器里处理 401，跳转到 `/auth/login`。

