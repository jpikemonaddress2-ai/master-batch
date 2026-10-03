// db.mjs をメモリ上の DB で動かして、保存まわりの約束事を確かめる。
// db.mjs は import した時点で DB を開くので DB は全テストで共有になる。
// テストどうしが依存しないよう、各テストは自分用の原料・配合・サンプルを uniq() の名前で作る
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositionSig } from '../public/calc.mjs';
import { buildMatrix } from '../public/matrix.mjs';

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
  const { samples, skipped, csv } = store.compareCsv([late.id, gone.id, early.id]);
  assert.deepEqual(samples.map(s => s.id).sort(), [early.id, late.id].sort());
  assert.equal(skipped, 1);
  const header = csv.replace('\ufeff', '').split('\r\n')[0];
  assert.equal(header, `"区分","項目","単位","差","${early.code}","${late.code}"`);
  assert.throws(() => store.compareCsv([gone.id]), e => e.status === 404);
});

test('配合: 使用停止の原料は新規・複製では組み込めない。保存済みの組成に元からあれば名前は直せる', () => {
  const { mb, resin, recipe } = setup();
  store.updateMaterial(mb.id, { ...mb, archived: true });
  const input = { code: uniq('MB'), name: '複製', base_material_id: resin.id, default_qty_g: 1000,
    items: [{ material_id: mb.id, target_active_pct: 2 }] };
  assert.throws(() => store.saveRecipe(input), e => e.status === 400 && e.message.includes(mb.name));
  const r = store.getRecipe(recipe.id);
  assert.equal(store.saveRecipe({ ...r, name: '改名', changed_by: 'A' }, r.id).name, '改名');

  // 保存済みの配合に、使用停止の原料を新しく足すのも不可
  const other = setup();
  const r2 = store.getRecipe(other.recipe.id);
  assert.throws(() => store.saveRecipe({ ...r2, items: [...r2.items, { material_id: mb.id, target_active_pct: 1 }], changed_by: 'A' }, r2.id),
    e => e.status === 400);
});

test('配合: 使用停止のベース樹脂は新しく使えない。元から使っている配合は名前を直せる', () => {
  const { resin, recipe } = setup();
  store.updateMaterial(resin.id, { ...resin, archived: true });
  const r = store.getRecipe(recipe.id);
  assert.equal(store.saveRecipe({ ...r, name: '改名', changed_by: 'A' }, r.id).name, '改名');
  assert.throws(() => store.saveRecipe({ ...r, code: uniq('MB') }), e => e.status === 400 && e.message.includes(resin.name));
  const other = setup();
  const r2 = store.getRecipe(other.recipe.id);
  assert.throws(() => store.saveRecipe({ ...r2, base_material_id: resin.id, changed_by: 'A' }, r2.id), e => e.status === 400);
});

test('実秤量: 入力した文字列の小数の桁数を残す（250.0 を 250 にしない）。送り直しても変わらない', () => {
  const { mb, sample } = setup();
  const s = sample({ actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: '41.0', lot: '' }] });
  const add = s.weighings.find(w => w.row_type === 'additive');
  assert.equal(add.actual_g, 41);
  assert.equal(add.actual_dp, 1);
  const again = store.saveSample({ ...asInput(s), changed_by: '確認者' }, s.id);
  assert.equal(again.weighings.find(w => w.row_type === 'additive').actual_dp, 1);
  assert.match(store.compareCsv([s.id]).csv, /"41\.0"/);
});

test('原料の CAS 番号: 誤りは登録できない。使われている原料では、入れた後は変えられない（空欄への記入はできる）', () => {
  assert.throws(() => store.createMaterial({ name: uniq('AO'), kind: 'additive', active_pct: 100, cas_no: '6683-19-7' }),
    e => e.status === 400);
  const { mb, sample } = setup();
  sample();
  const filled = store.updateMaterial(mb.id, { ...mb, cas_no: '６６８３－１９－８', grade: 'AO-50' });
  assert.equal(filled.cas_no, '6683-19-8');
  assert.throws(() => store.updateMaterial(mb.id, { ...filled, cas_no: '1592-23-0' }), e => e.status === 409);
  assert.throws(() => store.updateMaterial(mb.id, { ...filled, grade: 'AO-60' }), e => e.status === 409);
  assert.equal(store.updateMaterial(mb.id, { ...filled, memo: 'メモだけ' }).memo, 'メモだけ');
});

test('測定値の範囲で絞り込む: 両端を含み、数値として読めない値は対象外。一覧に測定値の列を出す', () => {
  const { recipe, sample } = setup();
  const label = uniq('MFR');
  const meas = value => ({ extras: [{ category: 'measurement', label, value, unit: 'g/10min' }] });
  const a = sample(meas('9.8'));
  const b = sample(meas('10'));
  sample(meas('n.d.'));
  const codes = f => store.listSamples({ recipe: String(recipe.id), mlabel: label, ...f }).map(s => s.code).sort();
  assert.deepEqual(codes({ mmin: '10' }), [b.code]);
  assert.deepEqual(codes({ mmax: '10' }), [a.code, b.code].sort());
  assert.deepEqual(codes({ mmin: '0', mmax: '0' }), []);   // n.d. を 0 として拾わない
  assert.throws(() => store.listSamples({ mmin: '1' }), e => e.status === 400);
  assert.throws(() => store.listSamples({ mlabel: label, mmin: 'abc' }), e => e.status === 400);
  const row = store.listSamples({ recipe: String(recipe.id) }).find(s => s.id === a.id);
  assert.equal(row.measurements, `${label} 9.8 g/10min`);
});

test('前回のロット: 原料ごとに、作成日の新しいサンプルの空欄でないロット', () => {
  const { mb, resin, sample } = setup();
  sample({ made_on: '2026-09-01', actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: 40, lot: 'OLD' }] });
  const newer = sample({ made_on: '2026-09-20', actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: 40, lot: 'NEW' }] });
  sample({ made_on: '2026-09-30', actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: 40, lot: '' }] });
  const lots = store.lastLots(`${mb.id},${resin.id}`).map(l => ({ ...l }));
  assert.deepEqual(lots, [{ material_id: mb.id, lot: 'NEW', code: newer.code, made_on: '2026-09-20' }]);
});

test('自由項目の単位の候補: 項目名ごとに、使われた単位を多い順に返す', () => {
  const { sample } = setup();
  const label = uniq('粘度');
  const ex = unit => ({ extras: [{ category: 'measurement', label, value: '1', unit }] });
  sample(ex('Pa·s'));
  sample(ex('mPa·s'));
  sample(ex('mPa·s'));
  const l = store.listExtraLabels().find(x => x.label === label);
  assert.deepEqual(l.units, ['mPa·s', 'Pa·s']);
  assert.equal(l.unit, 'mPa·s');
});

test('実秤量の桁数: 数値で送り直した行は actual_dp をそのまま残し、無い・値と合わないときは推測せず不明にする', () => {
  const { mb, sample } = setup();
  const s = sample();   // 数値の 41 で保存（桁数の情報なし）
  assert.equal(s.weighings.find(w => w.row_type === 'additive').actual_dp, null);
  const keep = store.saveSample({ ...asInput(s), memo: 'メモだけ直す', changed_by: '確認者' }, s.id);
  assert.equal(keep.weighings.find(w => w.row_type === 'additive').actual_dp, null);   // 「整数まで読んだ」にしない
  const bad = store.saveSample({ ...asInput(keep), changed_by: '確認者',
    actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: 40.55, actual_dp: 1 }] }, s.id);
  assert.equal(bad.weighings.find(w => w.row_type === 'additive').actual_dp, null);   // 40.55 を 40.6 と出さない
  const blank = store.saveSample({ ...asInput(bad), changed_by: '確認者',
    actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: ' ' }] }, s.id);
  assert.equal(blank.weighings.find(w => w.row_type === 'additive').actual_g, null);   // 空白は 0 g にしない
});

test('比較表: 実秤量の「250」と「250.0」は同じ量として差にしない（変更履歴の差分では差にする）', () => {
  const { mb, sample } = setup();
  const a = sample({ actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: '41', lot: '' }] });
  const b = sample({ actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: '41.0', lot: '' }] });
  const key = `add:${mb.id}:actual`;
  assert.equal(buildMatrix([a, b], 2).find(r => r.key === key).diff, false);
  assert.equal(buildMatrix([a, b], 2, { allDiff: true }).find(r => r.key === key).diff, true);
});

test('測定値の範囲の絞り込み: 全角の数字も読む。16進などは数値として扱わない', () => {
  const { recipe, sample } = setup();
  const label = uniq('灰分');
  const meas = value => ({ extras: [{ category: 'measurement', label, value, unit: '%' }] });
  const zen = sample(meas('１２．３'));
  sample(meas('0x10'));
  const codes = store.listSamples({ recipe: String(recipe.id), mlabel: label, mmin: '10' }).map(s => s.code);
  assert.deepEqual(codes, [zen.code]);
});

test('前回のロット: 作成日より後のサンプルのロットは入れない', () => {
  const { mb, sample } = setup();
  const old = sample({ made_on: '2026-08-01', actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: 40, lot: 'AUG' }] });
  sample({ made_on: '2026-09-01', actuals: [{ material_id: mb.id, row_type: 'additive', actual_g: 40, lot: 'SEP' }] });
  assert.equal(store.lastLots(String(mb.id), '2026-08-15')[0].lot, 'AUG');
  assert.equal(store.lastLots(String(mb.id), '2026-08-15')[0].code, old.code);
  assert.equal(store.lastLots(String(mb.id))[0].lot, 'SEP');
  assert.throws(() => store.lastLots(String(mb.id), '8/15'), e => e.status === 400);
});

test('自由項目の単位: 空欄（単位なし）も数える', () => {
  const { sample } = setup();
  const label = uniq('pH');
  sample({ extras: [{ category: 'measurement', label, value: '7', unit: '' }] });
  sample({ extras: [{ category: 'measurement', label, value: '7', unit: '' }] });
  sample({ extras: [{ category: 'measurement', label, value: '7', unit: '-' }] });
  const l = store.listExtraLabels().find(x => x.label === label);
  assert.deepEqual(l.units, ['', '-']);
  assert.equal(l.unit, '');
});

test('原料: CAS 番号・グレードを送らない古い画面から保存しても、登録済みの値を消さない', () => {
  const m = store.createMaterial({ name: uniq('AO'), kind: 'additive', active_pct: 100, cas_no: '6683-19-8', grade: 'G1' });
  const { cas_no, grade, ...old } = m;
  const saved = store.updateMaterial(m.id, { ...old, memo: '古い画面' });
  assert.equal(saved.cas_no, '6683-19-8');
  assert.equal(saved.grade, 'G1');
});
