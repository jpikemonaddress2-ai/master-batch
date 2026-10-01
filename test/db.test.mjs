// db.mjs をメモリ上の DB で動かして、保存まわりの約束事を確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_DB = ':memory:';
const store = await import('../db.mjs');

const resin = store.createMaterial({ name: 'PP', kind: 'resin', active_pct: 100 });
const mb = store.createMaterial({ name: 'AO-50MB', kind: 'additive', active_pct: 50 });
const recipe = store.saveRecipe({
  code: 'MB-001', name: 'PP/AO 2%', base_material_id: resin.id, default_qty_g: 1000,
  items: [{ material_id: mb.id, target_active_pct: 2 }],
});

function newSample(code, over = {}) {
  const r = store.getRecipe(recipe.id);
  return store.saveSample({
    recipe_id: r.id, recipe_version: r.version, code, total_qty_g: 1000, created_by: '津田',
    actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: 41, lot: 'L-01' }], ...over,
  });
}

test('サンプル保存: 狙い量・ロットを秤量明細に残す', () => {
  const s = newSample('S-001');
  const add = s.weighings.find(w => w.row_type === 'additive');
  assert.equal(add.target_g, 40);
  assert.equal(add.lot, 'L-01');
  assert.equal(s.weighings.find(w => w.row_type === 'base').target_g, 960);
});

test('スナップショット: 既存サンプルの更新では保存時の狙い濃度を使う', () => {
  const s = store.listSamples({ q: 'S-001' })[0];
  const cur = store.getSample(s.id);
  const saved = store.saveSample({ ...cur, total_qty_g: 2000, changed_by: '確認者' }, cur.id);
  const add = saved.weighings.find(w => w.row_type === 'additive');
  assert.equal(add.target_active_pct, 2);
  assert.equal(add.target_g, 80);
});

test('サンプルが付いた配合は組成を変えられない（名前は変えられる）', () => {
  const r = store.getRecipe(recipe.id);
  assert.throws(() => store.saveRecipe({ ...r, items: [{ material_id: mb.id, target_active_pct: 3 }] }, r.id),
    e => e.status === 409);
  const renamed = store.saveRecipe({ ...r, name: '新しい名前' }, r.id);
  assert.equal(renamed.name, '新しい名前');
});

test('同時編集: 古い version での保存は stale', () => {
  const s = store.getSample(store.listSamples({ q: 'S-001' })[0].id);
  store.saveSample({ ...s, memo: 'A', changed_by: 'A' }, s.id);
  assert.throws(() => store.saveSample({ ...s, memo: 'B', changed_by: 'B' }, s.id), e => e.code === 'stale');
});

test('記入者は更新で変わらず、更新・削除の前の内容が履歴に残る', () => {
  const s = newSample('S-002');
  const upd = store.saveSample({ ...s, created_by: '別人', judgement: 'ng', changed_by: '佐藤' }, s.id);
  assert.equal(upd.created_by, '津田');
  assert.throws(() => store.saveSample({ ...upd, changed_by: '' }, s.id), e => e.status === 400);
  store.deleteSample(s.id, { changed_by: '佐藤' });
  const h = store.listHistory(s.id);
  assert.deepEqual(h.map(x => [x.op, x.changed_by]), [['delete', '佐藤'], ['update', '佐藤']]);
  assert.equal(h[1].snapshot.judgement, null);
  assert.equal(h[0].snapshot.judgement, 'ng');
});
