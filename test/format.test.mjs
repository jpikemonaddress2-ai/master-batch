import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtG, fmtRaw, fmtDelta, decimalsOf, fmtActual } from '../public/format.mjs';
import { casError, normCas } from '../public/fields.mjs';
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

test('decimalsOf: 入力した小数の桁数（末尾の 0 も数える）。指数表記などは null', () => {
  assert.equal(decimalsOf('250.0'), 1);
  assert.equal(decimalsOf('250'), 0);
  assert.equal(decimalsOf('0.400'), 3);
  assert.equal(decimalsOf(' 12. '), 0);
  assert.equal(decimalsOf('2.5e2'), null);
  assert.equal(decimalsOf('1.' + '0'.repeat(20)), null);   // MAX_DP より細かい桁は不明
  assert.equal(decimalsOf('.'), null);
  assert.equal(decimalsOf(''), null);
  assert.equal(decimalsOf('.5'), 1);
});

test('fmtActual: 入力した桁数で出す。桁数が無い古い記録は丸めずに出す', () => {
  assert.equal(fmtActual(250, 1), '250.0');
  assert.equal(fmtActual(0.4, 3), '0.400');
  assert.equal(fmtActual(250.4, null), '250.4');
  assert.equal(fmtActual(null, 1), '');
});

test('CAS 番号: 形とチェックディジットを確かめる。全角やダッシュはそろえる', () => {
  assert.equal(casError('6683-19-8'), null);      // Irganox 1010
  assert.equal(casError('1592-23-0'), null);      // ステアリン酸カルシウム
  assert.match(casError('6683-19-7'), /チェックディジット/);
  assert.match(casError('668319-8'), /形/);
  assert.equal(normCas(' ６６８３－１９－８ '), '6683-19-8');
  assert.equal(normCas('6683‐19‐8'), '6683-19-8');
});
