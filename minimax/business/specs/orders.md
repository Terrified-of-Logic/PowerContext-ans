# 订单查询模块规格

本文件是 `src/orders.js` 的唯一行为依据。任何实现改动必须能被本文件的条目解释。

## 数据模型

订单对象字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 订单号，唯一 |
| `status` | string | 状态：`pending` / `paid` / `shipped` / `cancelled` |
| `amount` | number | 金额，单位元，两位小数 |
| `created_at` | string | 创建时间，ISO 8601 格式 |

## 功能需求

### R1 按状态过滤

`queryOrders(orders, { status })` 传入 `status` 时，只返回 `status` 字段等于该值的订单。

- `status` 为 `undefined` 或省略时，返回全部状态，不得过滤
- `status` 传入空字符串时，视为不合法输入，返回空数组
- 状态比较为严格相等，不做大小写归一

### R2 按金额下限过滤

传入 `minAmount`（number）时，只返回 `amount >= minAmount` 的订单。
`minAmount` 为 `undefined` 时不过滤。`minAmount` 为负数时按 0 处理。

### R3 排序

结果按 `created_at` **倒序**排列（最新的在前）。
`created_at` 无法解析为日期时，该订单排在最后，不抛异常。

### R4 数量限制

- `limit` 省略时默认 20
- `limit` 大于 100 时按 100 处理
- `limit` 小于 1 时返回空数组

## 约束

### C1 函数签名不得变更

`queryOrders` 的形参列表与返回类型保持不变，只允许修改函数体。
调用方已有代码依赖 `queryOrders(orders, options)` 的调用方式。

### C2 不得修改输入的数组

传入的 `orders` 数组不得被排序或修改，函数内部必须基于副本操作。

### C3 保持既有测试通过

`test/orders.test.js` 中已通过的用例，修改后必须仍然通过。

## 已知缺陷

R1（按状态过滤）尚未实现，`test/orders.test.js` 中的
`R1 按状态过滤：只返回指定状态的订单` 用例当前为失败状态。
