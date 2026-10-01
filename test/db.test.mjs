// db.mjs をメモリ上の DB で動かして、保存まわりの約束事を確かめる。
// db.mjs は import した時点で DB を開くので DB は全テストで共有になる。
// テストどうしが依存しないよう、各テストは自分用の原料・配合・サンプルを uniq() の名前で作る
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositionSig } from '../public/calc.mjs';

process.env.MB_DB = ':memory:';
const store = await import('../db.mjs');

let n = 0;
const uniq = p => `${p}-${++n}`;

function setup({ active = 50, pct = 2 } = {}) {
  const resin = store.createMaterial({ name: uniq('PP'), kind: 'resin', active_pct: 100 });
  const mb = store.createMaterial({ name: uniq('AO-MB'), kind: 'additive', active_pct: active });
  const recipe = store.saveRecipe({
    code: uniq('MB'), name: 'テスト配合', base_material_id: resin.id, default_qty_g: 1000,
    items: [{ material_id: mb.id, target_active_pct: pct }],
  });
  const sample = (over = {}) => {
    const r = store.getRecipe(recipe.id);
    return store.saveSample({
      recipe_id: r.id, recipe_sig: compositionSig(r.base_material_id, r.items),
      code: uniq('S'), made_on: '2026-10-01', total_qty_g: 1000, created_by: '津田',
      actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: 41, lot: 'L-01' }], ...over,
    });
  };
  return { resin, mb, recipe, sample };
}

// 保存済みサンプルをそのまま送り直すときの形（画面の送信内容に合わせる）
const asInput = s => ({ ...s, actuals: s.weighings });

test('サンプル保存: 狙い量・ロットを秤量明細に残す', () => {
  const { sample } = setup();
  const s = sample();
  const add = s.weighings.find(w => w.row_type === 'additive');
  assert.equal(add.target_g, 40);
  assert.equal(add.lot, 'L-01');
  assert.equal(s.weighings.find(w => w.row_type === 'base').target_g, 960);
});

test('スナップショット: 更新では保存時の狙い濃度・有効成分%から狙い量を作り直す', () => {
  const { sample } = setup();
  const s = sample();
  const saved = store.saveSample({ ...asInput(s), total_qty_g: 2000, changed_by: '確認者' }, s.id);
  const add = saved.weighings.find(w => w.row_type === 'additive');
  assert.equal(add.target_active_pct, 2);
  assert.equal(add.active_pct_snapshot, 50);
  assert.equal(add.target_g, 80);
  assert.equal(add.actual_g, 41);
  assert.equal(add.lot, 'L-01');
});

test('使用中の原料は有効成分%を変えられない（スナップショットの元が書き換わらない）', () => {
  const { mb, sample } = setup();
  sample();
  assert.throws(() => store.updateMaterial(mb.id, { ...mb, active_pct: 25 }), e => e.status === 409);
  const ok = store.updateMaterial(mb.id, { ...mb, caution: '吸湿注意', archived: true });
  assert.equal(ok.caution, '吸湿注意');
  assert.equal(ok.archived, 1);
});

test('未使用の原料は直せる', () => {
  const m = store.createMaterial({ name: uniq('未使用'), kind: 'additive', active_pct: 100 });
  assert.equal(store.updateMaterial(m.id, { ...m, active_pct: 50 }).active_pct, 50);
});

test('原料名の表記ゆれ（全角・大文字小文字・空白だけの違い）は登録できない', () => {
  store.createMaterial({ name: 'Irganox 1010', kind: 'additive', active_pct: 100 });
  assert.throws(() => store.createMaterial({ name: 'ＩＲＧＡＮＯＸ１０１０', kind: 'additive', active_pct: 100 }),
    e => e.status === 409 && e.message.includes('Irganox 1010'));
});

test('サンプルが付いた配合は組成とコードを変えられない（名前は変えられ、履歴に残る）', () => {
  const { mb, recipe, sample } = setup();
  sample();
  const r = store.getRecipe(recipe.id);
  assert.throws(() => store.saveRecipe({ ...r, items: [{ material_id: mb.id, target_active_pct: 3 }], changed_by: 'A' }, r.id),
    e => e.code === 'locked');
  assert.throws(() => store.saveRecipe({ ...r, code: uniq('別コード'), changed_by: 'A' }, r.id), e => e.code === 'locked');
  const renamed = store.saveRecipe({ ...r, name: '新しい名前', changed_by: 'A' }, r.id);
  assert.equal(renamed.name, '新しい名前');
  const h = store.listRecipeHistory(r.id);
  assert.deepEqual(h.map(x => [x.changed_by, x.snapshot.name]), [['A', 'テスト配合']]);
});

test('保存済みの配合の変更には変更者が要る', () => {
  const { recipe } = setup();
  const r = store.getRecipe(recipe.id);
  assert.throws(() => store.saveRecipe({ ...r, name: 'x' }, r.id), e => e.status === 400);
});

test('新規サンプル: 画面で見ていた組成と違えば recipe_changed、名前の変更だけなら通る', () => {
  const { mb, recipe, sample } = setup();
  const r = store.getRecipe(recipe.id);
  const seen = compositionSig(r.base_material_id, r.items);
  store.saveRecipe({ ...r, name: '改名', changed_by: 'A' }, r.id);
  assert.ok(sample({ recipe_sig: seen }).id);
  // サンプルがあると組成は変えられないので、組成違いは別の配合で確かめる
  const other = setup();
  const r2 = store.getRecipe(other.recipe.id);
  store.saveRecipe({ ...r2, items: [{ material_id: other.mb.id, target_active_pct: 3 }], changed_by: 'A' }, r2.id);
  assert.throws(() => other.sample({ recipe_sig: compositionSig(r2.base_material_id, r2.items) }), e => e.code === 'recipe_changed');
  void mb;
});

test('同時編集: 古い version での保存は stale', () => {
  const { sample } = setup();
  const s = sample();
  store.saveSample({ ...asInput(s), memo: 'A', changed_by: 'A' }, s.id);
  assert.throws(() => store.saveSample({ ...asInput(s), memo: 'B', changed_by: 'B' }, s.id), e => e.code === 'stale');
});

test('作成日は必須', () => {
  const { sample } = setup();
  assert.throws(() => sample({ made_on: '' }), e => e.status === 400);
});

test('削除したサンプルの id と番号は再利用しない（履歴が別のサンプルに付かない）', () => {
  const { sample } = setup();
  const a = sample();
  store.deleteSample(a.id, { changed_by: '佐藤', version: a.version });
  const b = sample();
  assert.notEqual(b.id, a.id);
  assert.deepEqual(store.listHistory(b.id), []);
  assert.throws(() => sample({ code: a.code }), e => e.status === 409);
  assert.ok(store.listDeletedSamples().some(d => d.snapshot.code === a.code));
});

test('記入者は更新で変わらず、更新・削除の前の内容が履歴に残る', () => {
  const { sample } = setup();
  const s = sample();
  const upd = store.saveSample({ ...asInput(s), created_by: '別人', judgement: 'ng', changed_by: '佐藤' }, s.id);
  assert.equal(upd.created_by, '津田');
  assert.throws(() => store.saveSample({ ...asInput(upd), changed_by: '' }, s.id), e => e.status === 400);
  store.deleteSample(s.id, { changed_by: '佐藤', version: upd.version });
  const h = store.listHistory(s.id);
  assert.deepEqual(h.map(x => [x.op, x.changed_by]), [['delete', '佐藤'], ['update', '佐藤']]);
  assert.equal(h[1].snapshot.judgement, null);
  assert.equal(h[0].snapshot.judgement, 'ng');
});

test('ゾーン数より多く記録されたバレル温度は、保存し直しても切り捨てない', () => {
  const { sample } = setup();
  const temps = Array.from({ length: 10 }, (_, i) => 170 + i);
  const s = sample({ barrel_temps: temps });
  const again = store.saveSample({ ...asInput(s), memo: 'x', changed_by: 'A' }, s.id);
  assert.deepEqual(again.barrel_temps, temps);
});

test('同時編集: 他の人が直した後の版を、古い version で削除できない', () => {
  const { sample } = setup();
  const s = sample();
  store.saveSample({ ...asInput(s), memo: 'A', changed_by: 'A' }, s.id);
  assert.throws(() => store.deleteSample(s.id, { changed_by: 'B', version: s.version }), e => e.code === 'stale');
  assert.throws(() => store.deleteSample(999999, { changed_by: 'B', version: 1 }), e => e.status === 404);
  // version を付けない削除は「他の人が先に保存した」と紛らわしいので 400 にする
  assert.throws(() => store.deleteSample(s.id, { changed_by: 'B' }), e => e.status === 400);
});

test('使用停止の原料を含む配合からは新しいサンプルを作れない（既存のサンプルは直せる）', () => {
  const { mb, sample } = setup();
  const s = sample();
  store.updateMaterial(mb.id, { ...mb, archived: true });
  assert.throws(() => sample(), e => e.code === 'archived' && e.message.includes(mb.name));
  assert.ok(store.saveSample({ ...asInput(s), memo: '追記', changed_by: 'A' }, s.id).id);

  // ベース樹脂の使用停止も同じ
  const other = setup();
  store.updateMaterial(other.resin.id, { ...other.resin, archived: true });
  assert.throws(() => other.sample(), e => e.code === 'archived');
});

test('一覧の配合の絞り込みに数値でない値を渡すと 400（絞り込みなしの全件にしない）', () => {
  assert.throws(() => store.listSamples({ recipe: 'abc' }), e => e.status === 400);
});

test('比較表の CSV: 作成日の順に並べ、削除済みのサンプルは飛ばす', () => {
  const { sample } = setup();
  const late = sample({ made_on: '2026-10-05', screw_rpm: 300 });
  const early = sample({ made_on: '2026-10-02', screw_rpm: 200 });
  const gone = sample();
  store.deleteSample(gone.id, { changed_by: 'A', version: gone.version });
  const { samples, csv } = store.compareCsv([late.id, gone.id, early.id]);
  assert.deepEqual(samples.map(s => s.id).sort(), [early.id, late.id].sort());
  const header = csv.replace('\ufeff', '').split('\r\n')[0];
  assert.equal(header, `"区分","項目","単位","差","${early.code}","${late.code}"`);
  assert.throws(() => store.compareCsv([gone.id]), e => e.status === 404);
});
