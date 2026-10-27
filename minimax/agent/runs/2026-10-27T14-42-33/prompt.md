你是一名开发助手。下面是某仓库的规格、代码和测试，请完成指定任务。

任务：实现按状态过滤：只返回指定状态的订单

# 开发上下文

任务：实现按状态过滤：只返回指定状态的订单

────────────────────────────────────────────────────────────
## 一、适用的规格条目

### [specs/orders.md] R1 按状态过滤   相关度 40.6
`queryOrders(orders, { status })` 传入 `status` 时，只返回 `status` 字段等于该值的订单。

- `status` 为 `undefined` 或省略时，返回全部状态，不得过滤
- `status` 传入空字符串时，视为不合法输入，返回空数组
- 状态比较为严格相等，不做大小写归一

### [specs/orders.md] 已知缺陷   相关度 28
R1（按状态过滤）尚未实现，`test/orders.test.js` 中的
`R1 按状态过滤：只返回指定状态的订单` 用例当前为失败状态。

### [specs/orders.md] R2 按金额下限过滤   相关度 14
传入 `minAmount`（number）时，只返回 `amount >= minAmount` 的订单。
`minAmount` 为 `undefined` 时不过滤。`minAmount` 为负数时按 0 处理。

────────────────────────────────────────────────────────────
## 二、需要修改的代码

### src/orders.js    符号：queryOrders   相关度 14
```js
/**
 * 订单查询模块
 *
 * 行为依据：specs/orders.md
 */

/**
 * 查询订单
 *
 * @param {Array<{id:string,status:string,amount:number,created_at:string}>} orders
 * @param {{status?:string, minAmount?:number, limit?:number}} [options]
 * @returns {Array} 过滤、排序后的订单副本
 */
export function queryOrders(orders, options = {}) {
  const { status, minAmount, limit } = options;

  // 副本操作（C2）
  let out = Array.isArray(orders) ? orders.slice() : [];

  // R2 金额下限
  if (typeof minAmount === 'number') {
    const floor = minAmount < 0 ? 0 : minAmount;
    out = out.filter((o) => o.amount >= floor);
  }

  // R1 状态过滤 —— 尚未实现
  // 规格要求：status 有值时只保留 status 相等的订单；
  //           status 为空字符串时返回空数组；
  //           status 为 undefined 时不过滤。
  // TODO 这里缺少实现

  // R3 排序：按 created_at 倒序，无法解析的排最后
  const ts = (o) => {
    const t = Date.parse(o.created_at);
    return Number.isNaN(t) ? -Infinity : t;
  };
  out.sort((a, b) => ts(b) - ts(a));

  // R4 数量限制
  let n = typeof limit === 'number' ? limit : 20;
  if (n > 100) n = 100;
  if (n < 1) return [];

  return out.slice(0, n);
}
```

────────────────────────────────────────────────────────────
## 三、用于验证的测试

### [test/orders.test.js] R1 按状态过滤：只返回指定状态的订单   相关度 70
```js
test('R1 按状态过滤：只返回指定状态的订单', () => {
  const got = queryOrders(ORDERS, { status: 'paid' });
  assert.deepEqual(ids(got), ['A003', 'A001']);
});
```

### [test/orders.test.js] R1 状态为空字符串时返回空数组   相关度 10
```js
test('R1 状态为空字符串时返回空数组', () => {
  const got = queryOrders(ORDERS, { status: '' });
  assert.deepEqual(got, []);
});

/* ================= R1 回归（当前应为通过） ================= */
```

### [test/orders.test.js] R1 status 省略时返回全部状态   相关度 10
```js
test('R1 status 省略时返回全部状态', () => {
  const got = queryOrders(ORDERS, {});
  assert.equal(got.length, 5);
});

/* ================= R2 回归 ================= */
```


要求：
1. 只输出修改后的**完整文件内容**，放在一个 ```js 代码块里，不要任何解释文字。
2. 不得修改函数签名；不得修改传入数组。
3. 已通过的测试必须仍然通过。