import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtG, fmtRaw, fmtDelta } from '../public/format.mjs';
import { calcActual, weighOutliers, compositionSig } from '../public/calc.mjs';

test('質量: 少量の添加剤が 0.0 にならない', () => {
  assert.equal(fmtG(0.04), '0.040');
  assert.equal(fmtG(4), '4.00');
  assert.equal(fmtG(960), '960.0');
  assert.equal(fmtG(NaN), '');
});

test('入力値は丸めずに出す（33.3% を 33 にしない）', () => {
  assert.equal(fmtRaw(33.3), '33.3');
  assert.equal(fmtRaw(0.1 + 0.2), '0.3');
  assert.equal(fmtRaw(null), '');
});

test('差: 丸めて 0 になるときは符号を付けない', () => {
  assert.equal(fmtDelta(-0.0001, 3), '0.000');
  assert.equal(fmtDelta(0.05, 3), '+0.050');
  assert.equal(fmtDelta(-0.05, 3), '-0.050');
});

test('一部の行だけ実秤量が入っているときの実濃度は推定扱い', () => {
  const a = calcActual([
    { row_type: 'additive', target_active_pct: 2, active_pct_snapshot: 50, target_g: 40, actual_g: null },
    { row_type: 'base', target_g: 960, actual_g: 960 },
  ]);
  assert.equal(a.rows[0].estimated, true);
});

test('実秤量の桁違いを見つける', () => {
  const rows = [
    { row_type: 'additive', target_g: 40, actual_g: 400 },
    { row_type: 'additive', target_g: 40, actual_g: 41 },
    { row_type: 'base', target_g: 960, actual_g: null },
  ];
  assert.equal(weighOutliers(rows).length, 1);
});

test('組成の比較: 並び順・数値の型の違いは同じ組成とみなす', () => {
  assert.equal(compositionSig(1, [{ material_id: 3, target_active_pct: 2 }, { material_id: 2, target_active_pct: '0.5' }]),
    compositionSig('1', [{ material_id: '2', target_active_pct: 0.5 }, { material_id: 3, target_active_pct: 2.0 }]));
});
