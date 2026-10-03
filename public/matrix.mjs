// サンプルを「項目 × サンプル」の表に展開する。比較表・変更履歴の差分（画面）と CSV（サーバー）で共用する。
import { calcActual } from './calc.mjs';
import { COND_FIELDS, JUDGEMENTS } from './fields.mjs';
import { fmtG, fmtRaw, fmtActual } from './format.mjs';

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

// CSV で単位がサンプル間で揃わない項目の、値の行の単位欄。単位そのものは「◯◯［単位］」の行に出す
export const MIXED_UNIT = '単位混在・［単位］列を参照';
// CSV の単位の行で、値はあるのに単位が空のセル（値が空のセルと見分けるため）。
// pH や色差など単位の無い量もあるので「記入漏れ」とは書かない
const UNIT_BLANK = '（単位なし）';

const s2 = v => (v === null || v === undefined) ? '' : String(v);

/**
 * 1サンプルを項目の並びにする。
 * @param {object} s GET /api/samples/:id の形（recipe_code, weighings, extras, barrel_temps を含む）
 * @param {number} zones バレル温度のゾーン数
 * @returns {{group:string, key:string, label:string, unit:string, value:string, noDiff?:boolean, stamp?:boolean, pair?:string, live?:boolean}[]}
 *   noDiff: 値が違って当然の項目（サンプル番号など）。比較表では差分扱いしない（変更履歴の差分では扱う）
 *   stamp: 記録日時。保存のたびに変わるので、変更履歴の差分でも扱わない
 *   cmp: 比較表の差の判定に使う値（実秤量は「250」と「250.0」を同じ量として扱う。変更履歴の差分では表示の値で比べる）
 *   pair: 組で1つの値になる行の組の名前（buildMatrix で差を連動させる）。名前は組の代表の行の key にする
 *   live: サンプルの記録ではなく、表示のたびに配合から引く値（配合名）。
 *         配合の名前を変えるとサンプルの履歴の差分に紛れ込むので、変更履歴の差分では扱わない
 */
export function sampleEntries(s, zones, { csv = false } = {}) {
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
  const realNum = w => !act.entered || !Number.isFinite(w.real_pct) ? '' : w.real_pct.toFixed(3);
  // CSV では値を数値だけにして（表計算で集計できるように）、推定かどうかは別の行に出す
  const real = w => csv ? realNum(w) : `${realNum(w)}${act.entered && w.estimated ? '（推定）' : ''}`;
  for (const w of act.rows) {
    if (w.row_type === 'base') {
      add('weigh', 'base', 'ベース樹脂', '', w.material_name);
      add('weigh', 'base:lot', 'ベース樹脂 ロット', '', w.lot);
      add('weigh', 'base:target', 'ベース樹脂 狙い量', 'g', fmtG(w.target_g));
      add('weigh', 'base:actual', 'ベース樹脂 実秤量', 'g', fmtActual(w.actual_g, w.actual_dp), { cmp: fmtRaw(w.actual_g) });
      continue;
    }
    const k = `add:${w.material_id}`;
    const n = w.material_name;
    add('weigh', `${k}:target`, `${n} 狙い濃度`, 'wt%', fmtRaw(w.target_active_pct));
    add('weigh', `${k}:active`, `${n} 有効成分`, 'wt%', fmtRaw(w.active_pct_snapshot));
    add('weigh', `${k}:lot`, `${n} ロット`, '', w.lot);
    add('weigh', `${k}:target_g`, `${n} 狙い量`, 'g', fmtG(w.target_g));
    add('weigh', `${k}:actual`, `${n} 実秤量`, 'g', fmtActual(w.actual_g, w.actual_dp), { cmp: fmtRaw(w.actual_g) });
    add('weigh', `${k}:real`, `${n} 実濃度`, 'wt%', real(w), csv ? { pair: `${k}:real` } : {});
    if (csv) add('weigh', `${k}:real_kind`, `${n} 実濃度の区分`, '', realNum(w) === '' ? '' : w.estimated ? '推定' : '実測', { pair: `${k}:real` });
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
 * 単位が全サンプルで揃っていれば見出しに付け、揃っていなければ各セルの値に付ける（CSV では値と単位を分ける）。
 *
 * @param {{allDiff?:boolean, csv?:boolean}} [opts] allDiff: サンプル番号・作成日・記入者も差分として扱う（変更履歴の差分用）
 *   csv: CSV 用の値にする（実濃度は数値だけにし、推定かどうかは別の行）。
 *        単位が揃わない項目は、値の行（単位は MIXED_UNIT）と、`key:unit` の単位の行（「◯◯［単位］」）の2行になる
 * @returns {{group:string, key:string, label:string, unit:string, cells:string[], diff:boolean}[]}
 *   diff: セルの値が揃っていない（＝振った条件・出た差）。片方だけ空の場合も差とみなす
 */
export function buildMatrix(samples, zones, { allDiff = false, csv = false } = {}) {
  const per = samples.map(s => new Map(sampleEntries(s, zones, { csv }).map(e => [e.key, e])));
  const rows = [];
  const pairOf = new Map();   // 行 → 組の名前（sampleEntries の pair を参照）
  const push = (row, pair) => { rows.push(row); if (pair) pairOf.set(row, pair); };
  // 片方だけ空の場合も差とみなす
  const differs = cells => new Set(cells).size > 1;
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
      const m = meta.get(key);
      const counts = allDiff ? !(m.stamp || m.live) : !m.noDiff;
      const vals = es.map(e => e ? e.value : '');
      // 値の無いセルは単位も無いものとする。単位の空欄も1つの単位として数える
      // （空欄の値を、他のサンプルの単位で記録したように見せない）
      const unitOf = es.map((e, i) => vals[i] === '' ? '' : e.unit);
      const units = new Set(unitOf.filter((u, i) => vals[i] !== ''));
      // 差は値と単位を別々に比べる（「10 Pa·s」を値に書いたサンプルと、値 10・単位 Pa·s のサンプルも差にする）。
      // 画面と CSV で同じ判定にして、「差のある行だけ」に出る行をそろえる
      const valDiff = counts && differs(allDiff ? vals : es.map((e, i) => e?.cmp ?? vals[i]));
      const unitDiff = counts && differs(unitOf);
      if (units.size > 1 && csv) {
        // CSV では値に単位を付けると表計算で数値にならないので、値と単位を別の行に分ける。
        // 値の行には単位が混ざっていることを示し、単位の無い数値として集計されないようにする
        const pair = m.pair ?? key;
        push({ group: g.id, key, label: m.label, unit: MIXED_UNIT, cells: vals, diff: valDiff }, pair);
        push({ group: g.id, key: `${key}:unit`, label: `${m.label}［単位］`, unit: '',
          cells: unitOf.map((u, i) => vals[i] === '' ? '' : (u || UNIT_BLANK)), diff: unitDiff }, pair);
        continue;
      }
      const shared = units.size <= 1;
      const unit = shared ? ([...units][0] ?? m.unit) : '';
      const cells = vals.map((v, i) => (v === '' || shared || !unitOf[i]) ? v : `${v} ${unitOf[i]}`);
      push({ group: g.id, key, label: m.label, unit, cells, diff: valDiff || unitDiff }, m.pair);
    }
  }
  // 組で1つの値になる行（CSV の実濃度と区分、単位の揃わない値と単位）は、どれかに差があれば全部を差とし、
  // 「差のある行だけ」でも片方だけ残らないようにする（区分や単位が落ちると、値を取り違える）
  const pairDiff = new Map();
  for (const [r, p] of pairOf) pairDiff.set(p, pairDiff.get(p) || r.diff);
  for (const [r, p] of pairOf) r.diff = pairDiff.get(p);
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
  // 表計算ソフトで数式として実行されないようにする（負の数などの数値はそのまま）。全角の記号も対象にする。
  // 「-」1文字（無次元の単位などに使う）は数式にならないので、そのまま出す
  if (/^[=+\-@\t\r＝＋－＠]/.test(s) && !Number.isFinite(Number(s)) && !/^[-－]$/.test(s)) s = `'${s}`;
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
  const rows = visibleRows(buildMatrix(samples, zones, { csv: true }), onlyDiff && many);
  const header = ['区分', '項目', '単位', ...(many ? ['差'] : []), ...samples.map(s => s.code)];
  return csvText([header, ...rows.map(r =>
    [label[r.group], r.label, r.unit, ...(many ? [r.diff ? '有' : ''] : []), ...r.cells])]);
}

/** 1行1サンプルの CSV */
export function toCsv(samples, zones) {
  const rows = buildMatrix(samples, zones, { csv: true });
  const prefix = Object.fromEntries(GROUPS.map(g => [g.id, g.csv ?? '']));
  const header = rows.map(r => `${prefix[r.group]}${r.label}${r.unit ? ` (${r.unit})` : ''}`);
  const lines = [header, ...samples.map((_, i) => rows.map(r => r.cells[i]))];
  return csvText(lines);
}
