// サンプルを「項目 × サンプル」の表に展開する。比較表・変更履歴の差分（画面）と CSV（サーバー）で共用する。
import { calcActual } from './calc.mjs';
import { COND_FIELDS, JUDGEMENTS } from './fields.mjs';
import { fmtG, fmtRaw } from './format.mjs';

// 表に出すグループの順番。csv はCSVの見出しに付ける接頭辞（自由項目の名前の衝突よけ）
export const GROUPS = [
  { id: 'basic',       label: '基本' },
  { id: 'weigh',       label: '配合・秤量' },
  { id: 'cond',        label: '造粒条件' },
  { id: 'condExtra',   label: '造粒条件（自由項目）', csv: '条件:' },
  { id: 'eval',        label: '評価' },
  { id: 'measurement', label: '測定値', csv: '測定:' },
  { id: 'record',      label: '記録' },
];

const s2 = v => (v === null || v === undefined) ? '' : String(v);

/**
 * 1サンプルを項目の並びにする。
 * @param {object} s GET /api/samples/:id の形（recipe_code, weighings, extras, barrel_temps を含む）
 * @param {number} zones バレル温度のゾーン数
 * @returns {{group:string, key:string, label:string, unit:string, value:string, noDiff?:boolean, stamp?:boolean, live?:boolean}[]}
 *   noDiff: 値が違って当然の項目（サンプル番号など）。比較表では差分扱いしない（変更履歴の差分では扱う）
 *   stamp: 記録日時。保存のたびに変わるので、変更履歴の差分でも扱わない
 *   live: サンプルの記録ではなく、表示のたびに配合から引く値（配合名）。
 *         配合の名前を変えるとサンプルの履歴の差分に紛れ込むので、変更履歴の差分では扱わない
 */
export function sampleEntries(s, zones) {
  const out = [];
  const add = (group, key, label, unit, value, extra = {}) =>
    out.push({ group, key, label, unit: unit ?? '', value: s2(value), ...extra });

  add('basic', 'code', 'サンプル番号', '', s.code, { noDiff: true });
  add('basic', 'made_on', '作成日', '', s.made_on, { noDiff: true });
  add('basic', 'recipe', '配合', '', s.recipe_code);
  add('basic', 'recipe_name', '配合名', '', s.recipe_name, { live: true });
  add('basic', 'total_qty_g', '作成量', 'g', fmtRaw(s.total_qty_g));
  add('basic', 'created_by', '記入者', '', s.created_by, { noDiff: true });

  // 実秤量が1つも入っていなければ実濃度は出さない（狙い値の写しになって紛らわしいため）。
  // 一部の行だけ入っているときは、未入力の行を狙い量で補った推定値なので（推定）と付ける
  const act = calcActual(s.weighings);
  const real = w => !act.entered ? '' : `${Number.isFinite(w.real_pct) ? w.real_pct.toFixed(3) : ''}${w.estimated ? '（推定）' : ''}`;
  for (const w of act.rows) {
    if (w.row_type === 'base') {
      add('weigh', 'base', 'ベース樹脂', '', w.material_name);
      add('weigh', 'base:lot', 'ベース樹脂 ロット', '', w.lot);
      add('weigh', 'base:target', 'ベース樹脂 狙い量', 'g', fmtG(w.target_g));
      add('weigh', 'base:actual', 'ベース樹脂 実秤量', 'g', fmtRaw(w.actual_g));
      continue;
    }
    const k = `add:${w.material_id}`;
    const n = w.material_name;
    add('weigh', `${k}:target`, `${n} 狙い濃度`, 'wt%', fmtRaw(w.target_active_pct));
    add('weigh', `${k}:active`, `${n} 有効成分`, 'wt%', fmtRaw(w.active_pct_snapshot));
    add('weigh', `${k}:lot`, `${n} ロット`, '', w.lot);
    add('weigh', `${k}:target_g`, `${n} 狙い量`, 'g', fmtG(w.target_g));
    add('weigh', `${k}:actual`, `${n} 実秤量`, 'g', fmtRaw(w.actual_g));
    add('weigh', `${k}:real`, `${n} 実濃度`, 'wt%', real(w));
  }

  const temps = s.barrel_temps ?? [];
  for (let i = 0; i < Math.max(zones, temps.length); i++) {
    add('cond', `barrel:${i}`, `バレル温度（設定） C${i + 1}`, '℃', fmtRaw(temps[i]));
  }
  add('cond', 'die_temp_c', 'ダイ温度（設定）', '℃', fmtRaw(s.die_temp_c));
  for (const f of COND_FIELDS) add('cond', f.key, f.label, f.unit, fmtRaw(s[f.key]));

  // 同じ項目名が複数ある（測定値の n=2 など）ときは 2つ目以降を「MFR (2)」として別の行にする
  const addExtras = (category, group, prefix) => {
    const seen = new Map();
    for (const e of s.extras.filter(e => e.category === category)) {
      const n = (seen.get(e.label) ?? 0) + 1;
      seen.set(e.label, n);
      const suffix = n > 1 ? ` (${n})` : '';
      add(group, `${prefix}:${e.label}#${n}`, e.label + suffix, e.unit, e.value);
    }
  };
  addExtras('condition', 'condExtra', 'cond');

  add('eval', 'judgement', '総合判定', '', JUDGEMENTS[s.judgement] ?? '');
  add('eval', 'appearance_note', '外観・所見', '', s.appearance_note);
  add('eval', 'memo', 'メモ', '', s.memo);

  addExtras('measurement', 'measurement', 'meas');

  add('record', 'created_at', '記録日時', '', s.created_at, { noDiff: true, stamp: true });
  add('record', 'updated_at', '最終更新', '', s.updated_at, { noDiff: true, stamp: true });
  return out;
}

/**
 * 複数サンプルを転置表にする。項目はグループ順、グループ内は最初に現れた順。
 * 単位が全サンプルで揃っていれば見出しに付け、揃っていなければ各セルの値に付ける。
 *
 * @param {{allDiff?:boolean}} [opts] allDiff: サンプル番号・作成日・記入者も差分として扱う（変更履歴の差分用）
 * @returns {{group:string, key:string, label:string, unit:string, cells:string[], diff:boolean}[]}
 *   diff: セルの値が揃っていない（＝振った条件・出た差）。片方だけ空の場合も差とみなす
 */
export function buildMatrix(samples, zones, { allDiff = false } = {}) {
  const per = samples.map(s => new Map(sampleEntries(s, zones).map(e => [e.key, e])));
  const rows = [];
  for (const g of GROUPS) {
    const keys = [];
    const meta = new Map();
    for (const m of per) {
      for (const e of m.values()) {
        if (e.group === g.id && !meta.has(e.key)) { keys.push(e.key); meta.set(e.key, e); }
      }
    }
    for (const key of keys) {
      const es = per.map(m => m.get(key));
      const units = new Set(es.filter(e => e?.unit && e.value !== '').map(e => e.unit));
      const shared = units.size <= 1;
      const unit = shared ? ([...units][0] ?? meta.get(key).unit) : '';
      const cells = es.map(e => (!e || e.value === '') ? '' : (shared || !e.unit ? e.value : `${e.value} ${e.unit}`));
      const m = meta.get(key);
      const counts = allDiff ? !(m.stamp || m.live) : !m.noDiff;
      rows.push({ group: g.id, key, label: m.label, unit, cells, diff: counts && new Set(cells).size > 1 });
    }
  }
  return rows;
}

/** 比較表の並び順（作成日の古い順に左から。同じ日は登録順） */
export function sortForCompare(samples) {
  return [...samples].sort((a, b) => (a.made_on ?? '').localeCompare(b.made_on ?? '') || a.id - b.id);
}

// 差のある行だけにしても残す行。どの列がどのサンプルの、どの配合の、いつの内容かが分かるように
const CONTEXT_KEYS = new Set(['code', 'made_on', 'recipe', 'updated_at']);

/** 比較表に出す行。onlyDiff なら差のある行だけ（CONTEXT_KEYS の行は残す） */
export function visibleRows(rows, onlyDiff) {
  return rows.filter(r => !onlyDiff || r.diff || CONTEXT_KEYS.has(r.key));
}

const csvCell = v => {
  let s = s2(v);
  // 表計算ソフトで数式として実行されないようにする（負の数などの数値はそのまま）。全角の記号も対象にする
  if (/^[=+\-@\t\r＝＋－＠]/.test(s) && !Number.isFinite(Number(s))) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

// Excel で文字化けしないよう BOM 付き、改行 CRLF
const csvText = lines => '\ufeff' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';

/**
 * 比較表の形（1行1項目、1列1サンプル）の CSV。画面の比較表・サンプル記録をそのまま表計算に持っていく用。
 * 2件以上なら「差」の列に、値が揃っていない行の印を付ける
 */
export function toMatrixCsv(samples, zones, { onlyDiff = false } = {}) {
  const many = samples.length > 1;
  const label = Object.fromEntries(GROUPS.map(g => [g.id, g.label]));
  const rows = visibleRows(buildMatrix(samples, zones), onlyDiff && many);
  const header = ['区分', '項目', '単位', ...(many ? ['差'] : []), ...samples.map(s => s.code)];
  return csvText([header, ...rows.map(r =>
    [label[r.group], r.label, r.unit, ...(many ? [r.diff ? '有' : ''] : []), ...r.cells])]);
}

/** 1行1サンプルの CSV */
export function toCsv(samples, zones) {
  const rows = buildMatrix(samples, zones);
  const prefix = Object.fromEntries(GROUPS.map(g => [g.id, g.csv ?? '']));
  const header = rows.map(r => `${prefix[r.group]}${r.label}${r.unit ? ` (${r.unit})` : ''}`);
  const lines = [header, ...samples.map((_, i) => rows.map(r => r.cells[i]))];
  return csvText(lines);
}
