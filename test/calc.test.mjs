// node --test で実行する。PLAN.md「検証」の数値をそのまま確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcCharge, targetWeighings, calcActual } from '../public/calc.mjs';

test('有効成分換算: 50% MB を総量 1000 g・狙い 2% → 仕込み 40 g、ベース 960 g', () => {
  const c = calcCharge(1000, [{ active_pct: 50, target_active_pct: 2 }]);
  assert.equal(c.rows[0].g, 40);
  assert.equal(c.baseG, 960);
  assert.equal(c.over, false);
});

test('純品 100% なら仕込み 20 g', () => {
  assert.equal(calcCharge(1000, [{ active_pct: 100, target_active_pct: 2 }]).rows[0].g, 20);
});

test('配合過剰: 添加剤の合計が総量を超えたら over', () => {
  assert.equal(calcCharge(1000, [{ active_pct: 50, target_active_pct: 60 }]).over, true);
});

test('ちょうど総量は配合過剰にしない（浮動小数の誤差）', () => {
  assert.equal(calcCharge(1000, [{ active_pct: 30, target_active_pct: 10 }, { active_pct: 30, target_active_pct: 20 }]).over, false);
});

test('有効成分%が無い行は NaN にして合計から外す', () => {
  const c = calcCharge(1000, [{ active_pct: undefined, target_active_pct: 2 }]);
  assert.ok(Number.isNaN(c.rows[0].g));
  assert.equal(c.addTotal, 0);
});

test('秤量明細: 添加剤の行のあとにベース樹脂の行', () => {
  const tw = targetWeighings(1000, 1, [{ material_id: 2, active_pct: 50, target_active_pct: 2 }]);
  assert.deepEqual(tw.rows.map(r => [r.row_type, r.material_id, r.target_g]), [['additive', 2, 40], ['base', 1, 960]]);
});

test('実濃度の逆算: 添加剤 41.0 g / 樹脂 959.0 g → 2.05%、狙い比 +0.05 pt', () => {
  const a = calcActual([
    { row_type: 'additive', target_active_pct: 2, active_pct_snapshot: 50, target_g: 40, actual_g: 41 },
    { row_type: 'base', target_g: 960, actual_g: 959 },
  ]);
  assert.equal(a.total, 1000);
  assert.ok(Math.abs(a.rows[0].real_pct - 2.05) < 1e-9);
  assert.ok(Math.abs(a.rows[0].delta - 0.05) < 1e-9);
  assert.ok(Number.isNaN(a.rows[1].real_pct));
});

test('実秤量が未入力の行は狙い量で補完する', () => {
  const a = calcActual([
    { row_type: 'additive', target_active_pct: 2, active_pct_snapshot: 50, target_g: 40, actual_g: null },
    { row_type: 'base', target_g: 960, actual_g: 970 },
  ]);
  assert.equal(a.total, 1010);
});
