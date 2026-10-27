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
