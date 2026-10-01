import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrix, toCsv } from '../public/matrix.mjs';

function sample(over = {}) {
  return {
    id: 1, code: 'S-001', made_on: '2026-10-01', recipe_code: 'MB-001', recipe_name: 'PP/AO', total_qty_g: 1000,
    created_by: '津田', barrel_temps: [170, 180], die_temp_c: 195, screw_rpm: 200, judgement: 'good',
    appearance_note: '', memo: '',
    weighings: [
      { row_type: 'additive', material_id: 2, material_name: 'AO-50MB', target_active_pct: 2, active_pct_snapshot: 50, target_g: 40, actual_g: 40, lot: 'L1' },
      { row_type: 'base', material_id: 1, material_name: 'PP', target_g: 960, actual_g: 960, lot: '' },
    ],
    extras: [],
    ...over,
  };
}

test('比較表: 回転数だけ違う 2 サンプルでは、条件の中で回転数の行だけが差分になる', () => {
  const rows = buildMatrix([sample(), sample({ id: 2, code: 'S-002', screw_rpm: 300 })], 2);
  assert.deepEqual(rows.filter(r => r.diff).map(r => r.key), ['screw_rpm']);
});

test('サンプル番号・作成日・記入者は値が違っても差分にしない', () => {
  const rows = buildMatrix([sample(), sample({ id: 2, code: 'S-002', made_on: '2026-10-02', created_by: '別人' })], 2);
  assert.deepEqual(rows.filter(r => r.diff), []);
});

test('同じ項目名の自由項目（n=2）は別の行として残す', () => {
  const s = sample({ extras: [
    { category: 'measurement', label: 'MFR', value: '1', unit: 'g/10min' },
    { category: 'measurement', label: 'MFR', value: '2', unit: 'g/10min' },
  ] });
  const rows = buildMatrix([s], 2).filter(r => r.group === 'measurement');
  assert.deepEqual(rows.map(r => [r.label, r.cells[0]]), [['MFR', '1'], ['MFR (2)', '2']]);
});

test('単位がサンプル間で違うときは見出しではなく各セルに付ける', () => {
  const a = sample({ extras: [{ category: 'measurement', label: '粘度', value: '10', unit: 'Pa·s' }] });
  const b = sample({ id: 2, extras: [{ category: 'measurement', label: '粘度', value: '10000', unit: 'mPa·s' }] });
  const row = buildMatrix([a, b], 2).find(r => r.label === '粘度');
  assert.equal(row.unit, '');
  assert.deepEqual(row.cells, ['10 Pa·s', '10000 mPa·s']);
});

test('CSV: BOM付き、数式になる文字列には \' を前置、負の数はそのまま', () => {
  const csv = toCsv([sample({ appearance_note: '=cmd|x', vacuum_kpa: -80 })], 2);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"\'=cmd|x"'));
  assert.ok(csv.includes('"-80"'));
  assert.ok(csv.includes('"L1"'));
});
