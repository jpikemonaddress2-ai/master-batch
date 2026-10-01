import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH, BARREL_ZONES } from './config.mjs';
import { calcCharge, targetWeighings } from './public/calc.mjs';
import { COND_FIELDS, JUDGEMENTS } from './public/fields.mjs';
import { toCsv } from './public/matrix.mjs';

export class HttpError extends Error {
  // code: 画面側で回復手段を出し分けるための識別子（例: 'stale' = 他の人が先に保存した）
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// WAL: 読み取り中でも書き込みが詰まらない。busy_timeout: 同時書き込み時は待ってから再試行。
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- スキーマ ----------
// 版ごとの変更を順に流す。適用済みの版は PRAGMA user_version に記録する。
// 既存の版は書き換えず、変更は必ず末尾に新しい版として足すこと
// （fields.mjs の COND_FIELDS に項目を足すときも、ここで ALTER TABLE を足す）。
const MIGRATIONS = [
  // 1: 初期スキーマ
  `
CREATE TABLE IF NOT EXISTS materials (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN ('resin', 'additive')),
  active_pct REAL NOT NULL CHECK (active_pct > 0 AND active_pct <= 100),
  supplier   TEXT,
  memo       TEXT,
  archived   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recipes (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  base_material_id INTEGER NOT NULL REFERENCES materials(id),
  default_qty_g    REAL NOT NULL,
  memo             TEXT,
  version          INTEGER NOT NULL DEFAULT 1,  -- 同時編集の検知用
  created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS recipe_items (
  id                INTEGER PRIMARY KEY,
  recipe_id         INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  material_id       INTEGER NOT NULL REFERENCES materials(id),
  target_active_pct REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS samples (
  id                 INTEGER PRIMARY KEY,
  recipe_id          INTEGER NOT NULL REFERENCES recipes(id),
  code               TEXT NOT NULL UNIQUE,
  made_on            TEXT,
  total_qty_g        REAL,
  barrel_temps_json  TEXT,
  die_temp_c         REAL,
  screw_rpm          REAL,
  feed_rate_kg_h     REAL,
  torque_pct         REAL,
  resin_pressure_mpa REAL,
  vacuum_kpa         REAL,
  strand_bath_temp_c REAL,
  pelletizer_rpm     REAL,
  predry_temp_c      REAL,
  predry_hours       REAL,
  judgement          TEXT CHECK (judgement IN ('good', 'ok', 'ng')),
  appearance_note    TEXT,
  memo               TEXT,
  created_by         TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 秤量明細。狙い濃度と有効成分%をコピーして持ち、配合や原料を後で編集しても過去の記録が変わらないようにする
CREATE TABLE IF NOT EXISTS sample_weighings (
  id                  INTEGER PRIMARY KEY,
  sample_id           INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  material_id         INTEGER NOT NULL REFERENCES materials(id),
  row_type            TEXT NOT NULL CHECK (row_type IN ('base', 'additive')),
  target_active_pct   REAL,
  active_pct_snapshot REAL,
  target_g            REAL,
  actual_g            REAL
);

CREATE TABLE IF NOT EXISTS sample_extras (
  id        INTEGER PRIMARY KEY,
  sample_id INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  category  TEXT NOT NULL CHECK (category IN ('condition', 'measurement')),
  label     TEXT NOT NULL,
  value     TEXT,
  unit      TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON recipe_items(recipe_id);
CREATE INDEX IF NOT EXISTS idx_samples_recipe      ON samples(recipe_id);
`,
  // 2: 子テーブルの索引、原料ロット、サンプルの変更履歴
  `
CREATE INDEX IF NOT EXISTS idx_weighings_sample ON sample_weighings(sample_id);
CREATE INDEX IF NOT EXISTS idx_extras_sample    ON sample_extras(sample_id);
ALTER TABLE sample_weighings ADD COLUMN lot TEXT;

-- 更新・削除の直前のサンプル全体を JSON で残す。サンプルを削除しても履歴は消さない（外部キーなし）
CREATE TABLE sample_history (
  id            INTEGER PRIMARY KEY,
  sample_id     INTEGER NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('update', 'delete')),
  changed_by    TEXT NOT NULL,
  changed_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  snapshot_json TEXT NOT NULL
);
CREATE INDEX idx_history_sample ON sample_history(sample_id);
`,
  // 3: サンプルの id を使い回さない（AUTOINCREMENT）。
  //    使い回すと、削除したサンプルの変更履歴が同じ id の新しいサンプルに付いてしまう。
  //    SQLite は既存テーブルに AUTOINCREMENT を足せないので作り直す
  `
CREATE TABLE samples_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id          INTEGER NOT NULL REFERENCES recipes(id),
  code               TEXT NOT NULL UNIQUE,
  made_on            TEXT,
  total_qty_g        REAL,
  barrel_temps_json  TEXT,
  die_temp_c         REAL,
  screw_rpm          REAL,
  feed_rate_kg_h     REAL,
  torque_pct         REAL,
  resin_pressure_mpa REAL,
  vacuum_kpa         REAL,
  strand_bath_temp_c REAL,
  pelletizer_rpm     REAL,
  predry_temp_c      REAL,
  predry_hours       REAL,
  judgement          TEXT CHECK (judgement IN ('good', 'ok', 'ng')),
  appearance_note    TEXT,
  memo               TEXT,
  created_by         TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
INSERT INTO samples_new SELECT
  id, recipe_id, code, made_on, total_qty_g, barrel_temps_json, die_temp_c, screw_rpm, feed_rate_kg_h,
  torque_pct, resin_pressure_mpa, vacuum_kpa, strand_bath_temp_c, pelletizer_rpm, predry_temp_c, predry_hours,
  judgement, appearance_note, memo, created_by, version, created_at, updated_at
FROM samples;
DROP TABLE samples;
ALTER TABLE samples_new RENAME TO samples;
CREATE INDEX idx_samples_recipe ON samples(recipe_id);
-- 削除済みのサンプルの id（履歴にだけ残っているもの）も含めて、それより後から振る
DELETE FROM sqlite_sequence WHERE name IN ('samples', 'samples_new');
INSERT INTO sqlite_sequence (name, seq) VALUES ('samples',
  MAX((SELECT IFNULL(MAX(id), 0) FROM samples), (SELECT IFNULL(MAX(sample_id), 0) FROM sample_history)));
`,
];

{
  // テーブルを作り直す版があるので、外部キーの検査は止めて流す
  // （有効なままだと DROP TABLE samples が子テーブルの行を連鎖削除してしまう）。
  // この PRAGMA はトランザクションの中では変えられないので外側で切り替える
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let v = 0; v < MIGRATIONS.length; v++) {
      tx(() => {
        // 版はロックを取ってから読む（同時に2つ起動しても同じ版を二重に流さない）
        if (db.prepare('PRAGMA user_version').get().user_version !== v) return;
        db.exec(MIGRATIONS[v]);
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`マイグレーション ${v + 1} で外部キーの不整合`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const { user_version } = db.prepare('PRAGMA user_version').get();
  if (user_version > MIGRATIONS.length) {
    throw new Error(`データベースの版（${user_version}）がこのアプリより新しいです。新しい版のアプリで開いてください`);
  }
}

// WAL の中身を本体 .db に書き戻してから閉じる。サーバー終了時に呼ぶ
// （書き戻しておかないと、.db だけをコピーしたバックアップに直近の記録が入らない）
export function closeDb() {
  if (!db.isOpen) return;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

const str = v => (v ?? '').toString().trim();
const num = v => (v === '' || v === null || v === undefined) ? NaN : Number(v);

// ---------- 原料マスタ ----------

export function listMaterials() {
  return db.prepare('SELECT * FROM materials ORDER BY kind DESC, name').all();
}

export function createMaterial(input) {
  const name = str(input.name);
  const kind = input.kind;
  const active = num(input.active_pct);
  if (!name) throw new HttpError(400, '原料名を入力してください');
  if (kind !== 'resin' && kind !== 'additive') throw new HttpError(400, '種別が不正です');
  if (!(active > 0 && active <= 100)) throw new HttpError(400, '有効成分 % は 0 より大きく 100 以下で入力してください');
  if (db.prepare('SELECT 1 FROM materials WHERE name = ?').get(name)) {
    throw new HttpError(409, `原料「${name}」は既に登録されています`);
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO materials (name, kind, active_pct, supplier, memo) VALUES (?, ?, ?, ?, ?)'
  ).run(name, kind, active, str(input.supplier) || null, str(input.memo) || null);
  return db.prepare('SELECT * FROM materials WHERE id = ?').get(lastInsertRowid);
}

// ---------- 配合 ----------

function itemsOf(recipeId) {
  return db.prepare(`
    SELECT ri.material_id, ri.target_active_pct, m.name AS material_name, m.active_pct
    FROM recipe_items ri JOIN materials m ON m.id = ri.material_id
    WHERE ri.recipe_id = ? ORDER BY ri.id
  `).all(recipeId);
}

const RECIPE_SELECT = `
  SELECT r.*, (SELECT COUNT(*) FROM samples s WHERE s.recipe_id = r.id) AS sample_count FROM recipes r`;

export function getRecipe(id) {
  const r = db.prepare(`${RECIPE_SELECT} WHERE r.id = ?`).get(id);
  if (!r) throw new HttpError(404, '配合が見つかりません');
  return { ...r, items: itemsOf(id) };
}

export function listRecipes() {
  return db.prepare(`${RECIPE_SELECT} ORDER BY r.code`).all()
    .map(r => ({ ...r, items: itemsOf(r.id) }));
}

function validateRecipe(input) {
  const code = str(input.code);
  const name = str(input.name);
  const qty = num(input.default_qty_g);
  if (!code) throw new HttpError(400, '配合コードを入力してください');
  if (!name) throw new HttpError(400, '配合名を入力してください');
  if (!(qty > 0)) throw new HttpError(400, '作成量は 0 より大きい値を入力してください');

  const base = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(input.base_material_id));
  if (!base || base.kind !== 'resin') throw new HttpError(400, 'ベース樹脂を選択してください');

  const items = (Array.isArray(input.items) ? input.items : []).map((it, i) => {
    const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(it.material_id));
    if (!m || m.kind !== 'additive') throw new HttpError(400, `添加剤 ${i + 1} 行目: 原料を選択してください`);
    const pct = num(it.target_active_pct);
    if (!(pct > 0)) throw new HttpError(400, `添加剤「${m.name}」: 狙い濃度は 0 より大きい値を入力してください`);
    return { material_id: m.id, target_active_pct: pct, active_pct: m.active_pct, name: m.name };
  });
  const ids = items.map(it => it.material_id);
  const dup = items.find((it, i) => ids.indexOf(it.material_id) !== i);
  if (dup) throw new HttpError(400, `添加剤「${dup.name}」が重複しています`);

  const c = calcCharge(qty, items);
  if (c.over) {
    throw new HttpError(400, `配合過剰: 添加剤の合計 ${c.addTotal.toFixed(1)} g が作成量 ${qty} g を超えています`);
  }
  return { code, name, qty, base_material_id: base.id, memo: str(input.memo) || null, items };
}

export function saveRecipe(input, id = null) {
  const v = validateRecipe(input);
  return tx(() => {
    const clash = db.prepare('SELECT id FROM recipes WHERE code = ? AND id IS NOT ?').get(v.code, id);
    if (clash) throw new HttpError(409, `配合コード「${v.code}」は既に使われています`);

    if (id === null) {
      id = Number(db.prepare(
        'INSERT INTO recipes (code, name, base_material_id, default_qty_g, memo) VALUES (?, ?, ?, ?, ?)'
      ).run(v.code, v.name, v.base_material_id, v.qty, v.memo).lastInsertRowid);
    } else {
      const cur = getRecipe(id);
      if (cur.version !== Number(input.version)) {
        throw new HttpError(409, '他の人がこの配合を先に保存しました。最新の内容を読み直してください', 'stale');
      }
      // サンプルが付いた配合の組成を変えると、同じ配合コードの下に組成の違うサンプルが混ざる。
      // 組成（ベース樹脂・添加剤・狙い濃度）の変更は禁止し、複製で新しい配合を作ってもらう
      const sig = (base, items) => JSON.stringify([base, items.map(i => [i.material_id, i.target_active_pct])
        .sort((a, b) => a[0] - b[0])]);
      if (cur.sample_count > 0 && sig(cur.base_material_id, cur.items) !== sig(v.base_material_id, v.items)) {
        throw new HttpError(409, `この配合にはサンプルが ${cur.sample_count} 件あるため、組成は変更できません。「複製」で新しい配合を作ってください`, 'locked');
      }
      db.prepare(`
        UPDATE recipes SET code = ?, name = ?, base_material_id = ?, default_qty_g = ?, memo = ?,
          version = version + 1, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(v.code, v.name, v.base_material_id, v.qty, v.memo, id);
      db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(id);
    }
    const ins = db.prepare('INSERT INTO recipe_items (recipe_id, material_id, target_active_pct) VALUES (?, ?, ?)');
    for (const it of v.items) ins.run(id, it.material_id, it.target_active_pct);
    return getRecipe(id);
  });
}

// ---------- サンプル ----------

// 空欄は null、数値でなければエラー
function optNum(v, label) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${label}: 数値を入力してください`);
  return n;
}

function weighingsOf(sampleId) {
  return db.prepare(`
    SELECT w.*, m.name AS material_name
    FROM sample_weighings w JOIN materials m ON m.id = w.material_id
    WHERE w.sample_id = ? ORDER BY w.id
  `).all(sampleId);
}

export function getSample(id) {
  const s = db.prepare(`
    SELECT s.*, r.code AS recipe_code, r.name AS recipe_name
    FROM samples s JOIN recipes r ON r.id = s.recipe_id WHERE s.id = ?
  `).get(id);
  if (!s) throw new HttpError(404, 'サンプルが見つかりません');
  const { barrel_temps_json, ...rest } = s;
  return {
    ...rest,
    barrel_temps: JSON.parse(barrel_temps_json || '[]'),
    weighings: weighingsOf(id),
    extras: db.prepare('SELECT category, label, value, unit FROM sample_extras WHERE sample_id = ? ORDER BY id').all(id),
  };
}

/**
 * サンプル一覧。条件はすべて省略可。
 * @param {{recipe?:string, from?:string, to?:string, judgement?:string, q?:string}} f
 *   judgement: 'good' | 'ok' | 'ng' | 'none'（未評価）
 *   q: サンプル番号・所見・メモ・記入者・自由項目（項目名と値）の部分一致
 */
export function listSamples(f = {}) {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, c => '\\' + c)}%` : null;
  return db.prepare(`
    SELECT s.id, s.code, s.made_on, s.total_qty_g, s.screw_rpm, s.die_temp_c, s.torque_pct,
      s.judgement, s.appearance_note, s.created_by,
      r.id AS recipe_id, r.code AS recipe_code, r.name AS recipe_name
    FROM samples s JOIN recipes r ON r.id = s.recipe_id
    WHERE (:recipe IS NULL OR s.recipe_id = :recipe)
      AND (:from IS NULL OR s.made_on >= :from)
      AND (:to IS NULL OR s.made_on <= :to)
      AND (:judgement IS NULL OR (:judgement = 'none' AND s.judgement IS NULL) OR s.judgement = :judgement)
      AND (:like IS NULL OR s.code LIKE :like ESCAPE '\\' OR s.appearance_note LIKE :like ESCAPE '\\'
        OR s.memo LIKE :like ESCAPE '\\' OR s.created_by LIKE :like ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM sample_extras e WHERE e.sample_id = s.id
          AND (e.label LIKE :like ESCAPE '\\' OR e.value LIKE :like ESCAPE '\\')))
    ORDER BY s.made_on DESC, s.id DESC
  `).all({
    recipe: f.recipe ? Number(f.recipe) : null,
    from: f.from || null,
    to: f.to || null,
    judgement: f.judgement || null,
    like,
  });
}

export function samplesCsv(f) {
  const full = listSamples(f).reverse().map(s => getSample(s.id));
  return toCsv(full, BARREL_ZONES);
}

// 自由項目で過去に使った項目名。入力候補に出して表記ゆれ（MFR / mfr など）を減らす
export function listExtraLabels() {
  return db.prepare(`
    SELECT category, label, MAX(unit) AS unit, COUNT(*) AS n
    FROM sample_extras GROUP BY category, label ORDER BY n DESC
  `).all();
}

function validateSample(input) {
  const code = str(input.code);
  if (!code) throw new HttpError(400, 'サンプル番号を入力してください');
  const createdBy = str(input.created_by);
  const qty = num(input.total_qty_g);
  if (!(qty > 0)) throw new HttpError(400, '作成量は 0 より大きい値を入力してください');
  const madeOn = str(input.made_on) || null;
  if (madeOn && !/^\d{4}-\d{2}-\d{2}$/.test(madeOn)) throw new HttpError(400, '作成日の形式が不正です');

  const temps = Array.isArray(input.barrel_temps) ? input.barrel_temps : [];
  const barrel = Array.from({ length: BARREL_ZONES }, (_, i) => optNum(temps[i], `バレル温度 C${i + 1}`));

  const cond = {};
  for (const f of COND_FIELDS) cond[f.key] = optNum(input[f.key], f.label);

  const judgement = input.judgement || null;
  if (judgement !== null && !Object.hasOwn(JUDGEMENTS, judgement)) throw new HttpError(400, '総合判定が不正です');

  const extras = (Array.isArray(input.extras) ? input.extras : []).map(e => {
    const label = str(e.label);
    if (e.category !== 'condition' && e.category !== 'measurement') throw new HttpError(400, '自由項目の区分が不正です');
    if (!label) throw new HttpError(400, '自由項目: 項目名が空の行があります');
    return { category: e.category, label, value: str(e.value), unit: str(e.unit) };
  });

  return {
    code, created_by: createdBy, total_qty_g: qty, made_on: madeOn,
    barrel_temps_json: JSON.stringify(barrel),
    die_temp_c: optNum(input.die_temp_c, 'ダイ温度'),
    ...cond,
    judgement,
    appearance_note: str(input.appearance_note) || null,
    memo: str(input.memo) || null,
    extras,
  };
}

/**
 * サンプルを保存する。
 * 新規: 配合の現在の内容から秤量明細（スナップショット）を作る。
 * 更新: 保存済みのスナップショットを元に狙い量だけ作り直し、配合の変更は反映しない。
 */
export function saveSample(input, id = null) {
  const v = validateSample(input);
  // 記入者は作成時に確定し、更新では変えない。更新した人は changed_by として履歴に残す
  if (id === null && !v.created_by) throw new HttpError(400, '記入者を入力してください');
  const changedBy = str(input.changed_by);
  if (id !== null && !changedBy) throw new HttpError(400, '変更者の名前を入力してください');
  return tx(() => {
    const clash = db.prepare('SELECT id FROM samples WHERE code = ? AND id IS NOT ?').get(v.code, id);
    if (clash) throw new HttpError(409, `サンプル番号「${v.code}」は既に使われています`);

    let recipeId, baseId, basis;
    if (id === null) {
      const r = getRecipe(Number(input.recipe_id));
      if (r.version !== Number(input.recipe_version)) {
        throw new HttpError(409, 'この配合は画面を開いた後に他の人が変更しました。最新の配合で狙い量を取り直したので、確認してから保存し直してください', 'recipe_changed');
      }
      recipeId = r.id;
      baseId = r.base_material_id;
      basis = r.items;
    } else {
      const cur = db.prepare('SELECT recipe_id, version, created_by FROM samples WHERE id = ?').get(id);
      if (!cur) throw new HttpError(404, 'サンプルが見つかりません');
      if (cur.version !== Number(input.version)) {
        throw new HttpError(409, '他の人がこのサンプルを先に保存しました。最新の内容を読み直してください', 'stale');
      }
      recordHistory(id, 'update', changedBy);
      v.created_by = cur.created_by;
      recipeId = cur.recipe_id;
      const old = weighingsOf(id);
      baseId = old.find(w => w.row_type === 'base').material_id;
      basis = old.filter(w => w.row_type === 'additive').map(w => ({
        material_id: w.material_id, target_active_pct: w.target_active_pct, active_pct: w.active_pct_snapshot,
      }));
    }

    const tw = targetWeighings(v.total_qty_g, baseId, basis);
    if (tw.over) throw new HttpError(400, '配合過剰: 添加剤の合計が作成量を超えています');

    const actuals = new Map((Array.isArray(input.actuals) ? input.actuals : [])
      .map(a => [`${a.row_type}:${a.material_id}`, a]));
    const rows = tw.rows.map(r => {
      const a = actuals.get(`${r.row_type}:${r.material_id}`) ?? {};
      const actual = optNum(a.actual_g, '実秤量');
      if (actual !== null && actual < 0) throw new HttpError(400, '実秤量は 0 以上で入力してください');
      return { ...r, actual_g: actual, lot: str(a.lot) || null };
    });

    const cols = ['code', 'created_by', 'total_qty_g', 'made_on', 'barrel_temps_json', 'die_temp_c',
      ...COND_FIELDS.map(f => f.key), 'judgement', 'appearance_note', 'memo'];
    const vals = cols.map(c => v[c]);
    if (id === null) {
      id = Number(db.prepare(
        `INSERT INTO samples (recipe_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`
      ).run(recipeId, ...vals).lastInsertRowid);
    } else {
      db.prepare(`
        UPDATE samples SET ${cols.map(c => `${c} = ?`).join(', ')},
          version = version + 1, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(...vals, id);
      db.prepare('DELETE FROM sample_weighings WHERE sample_id = ?').run(id);
      db.prepare('DELETE FROM sample_extras WHERE sample_id = ?').run(id);
    }

    const insW = db.prepare(`
      INSERT INTO sample_weighings (sample_id, material_id, row_type, target_active_pct, active_pct_snapshot, target_g, actual_g, lot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      insW.run(id, r.material_id, r.row_type, r.target_active_pct, r.active_pct_snapshot, r.target_g, r.actual_g, r.lot);
    }
    const insE = db.prepare('INSERT INTO sample_extras (sample_id, category, label, value, unit) VALUES (?, ?, ?, ?, ?)');
    for (const e of v.extras) insE.run(id, e.category, e.label, e.value, e.unit);

    return getSample(id);
  });
}

// 更新・削除の直前の内容を履歴に残す（tx の中で呼ぶ）
function recordHistory(id, op, changedBy) {
  db.prepare('INSERT INTO sample_history (sample_id, op, changed_by, snapshot_json) VALUES (?, ?, ?, ?)')
    .run(id, op, changedBy, JSON.stringify(getSample(id)));
}

export function deleteSample(id, input) {
  const changedBy = str(input?.changed_by);
  if (!changedBy) throw new HttpError(400, '削除する人の名前を入力してください');
  return tx(() => {
    recordHistory(id, 'delete', changedBy);
    db.prepare('DELETE FROM samples WHERE id = ?').run(id);
    return { ok: true };
  });
}

export function listHistory(sampleId) {
  return db.prepare('SELECT * FROM sample_history WHERE sample_id = ? ORDER BY id DESC').all(sampleId)
    .map(({ snapshot_json, ...h }) => ({ ...h, snapshot: JSON.parse(snapshot_json) }));
}
