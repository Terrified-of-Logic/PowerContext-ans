import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryOrders } from '../src/orders.js';

/** 固定数据集，保证修改前后测试集一致 */
const ORDERS = [
  { id: 'A001', status: 'paid', amount: 120.0, created_at: '2026-03-01T10:00:00Z' },
  { id: 'A002', status: 'pending', amount: 80.5, created_at: '2026-03-02T10:00:00Z' },
  { id: 'A003', status: 'paid', amount: 300.0, created_at: '2026-03-03T10:00:00Z' },
  { id: 'A004', status: 'cancelled', amount: 50.0, created_at: '2026-03-04T10:00:00Z' },
  { id: 'A005', status: 'shipped', amount: 210.0, created_at: '2026-03-05T10:00:00Z' },
];

const ids = (rows) => rows.map((r) => r.id);

/* ================= R1 目标功能（当前应为失败） ================= */

test('R1 按状态过滤：只返回指定状态的订单', () => {
  const got = queryOrders(ORDERS, { status: 'paid' });
  assert.deepEqual(ids(got), ['A003', 'A001']);
});

test('R1 状态为空字符串时返回空数组', () => {
  const got = queryOrders(ORDERS, { status: '' });
  assert.deepEqual(got, []);
});

/* ================= R1 回归（当前应为通过） ================= */

test('R1 status 省略时返回全部状态', () => {
  const got = queryOrders(ORDERS, {});
  assert.equal(got.length, 5);
});

/* ================= R2 回归 ================= */

test('R2 金额下限过滤', () => {
  const got = queryOrders(ORDERS, { minAmount: 200 });
  assert.deepEqual(ids(got), ['A005', 'A003']);
});

test('R2 金额下限为负数时按 0 处理', () => {
  const got = queryOrders(ORDERS, { minAmount: -10 });
  assert.equal(got.length, 5);
});

/* ================= R3 回归 ================= */

test('R3 按创建时间倒序', () => {
  const got = queryOrders(ORDERS, {});
  assert.deepEqual(ids(got), ['A005', 'A004', 'A003', 'A002', 'A001']);
});

test('R3 无法解析的 created_at 排在最后且不抛异常', () => {
  const withBad = [...ORDERS, { id: 'A006', status: 'paid', amount: 10, created_at: 'not-a-date' }];
  const got = queryOrders(withBad, {});
  assert.equal(got[got.length - 1].id, 'A006');
});

/* ================= R4 回归 ================= */

test('R4 limit 省略时默认 20', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `B${i}`,
    status: 'paid',
    amount: 1,
    created_at: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const got = queryOrders(many, {});
  assert.equal(got.length, 20);
});

test('R4 limit 大于 100 时按 100 处理', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({
    id: `C${i}`,
    status: 'paid',
    amount: 1,
    created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  }));
  const got = queryOrders(many, { limit: 999 });
  assert.equal(got.length, 100);
});

test('R4 limit 小于 1 时返回空数组', () => {
  assert.deepEqual(queryOrders(ORDERS, { limit: 0 }), []);
  assert.deepEqual(queryOrders(ORDERS, { limit: -5 }), []);
});

/* ================= C2 回归 ================= */

test('C2 不修改传入的数组', () => {
  const input = ORDERS.map((o) => ({ ...o }));
  const snapshot = JSON.stringify(input);
  queryOrders(input, { status: 'paid' });
  assert.equal(JSON.stringify(input), snapshot);
});
