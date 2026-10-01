// 配合計算ロジックと、それに付随する判定（使用停止の原料、組成の差分）。
// 画面（recipe.js / sample.js）とサーバー（db.mjs）の両方から import する。
// 計算はここ一箇所だけに置き、二重実装による食い違いを防ぐ。

// 浮動小数の誤差で「ちょうど総量」が配合過剰扱いにならないための許容幅 (g)
const EPS = 1e-9;

/**
 * 仕込み量を計算する。
 *   仕込み量 m_i = W × a_i / p_i
 *   ベース樹脂量 = W − Σ m_i
 *
 * @param {number} totalG 作成量 W (g)
 * @param {{active_pct:number, target_active_pct:number}[]} items
 *   active_pct: 原料の有効成分 p_i (%)、target_active_pct: 有効成分としての狙い濃度 a_i (wt%)
 * @returns {{rows:Array<object & {g:number}>, addTotal:number, baseG:number, over:boolean}}
 *   rows[i].g は計算できない行（有効成分%が未設定など）では NaN
 */
export function calcCharge(totalG, items) {
  const rows = items.map(it => {
    const ok = it.active_pct > 0 && Number.isFinite(it.target_active_pct);
    return { ...it, g: ok ? totalG * it.target_active_pct / it.active_pct : NaN };
  });
  const addTotal = rows.reduce((s, r) => s + (Number.isFinite(r.g) ? r.g : 0), 0);
  return { rows, addTotal, baseG: totalG - addTotal, over: addTotal > totalG + EPS };
}

/**
 * サンプルの秤量明細（狙い値）を作る。添加剤の行のあとにベース樹脂の行を1つ置く。
 * 新規サンプルでは配合から、既存サンプルでは保存済みスナップショットから items を渡す。
 *
 * @param {number} totalG 作成量 (g)
 * @param {number} baseMaterialId ベース樹脂の原料ID
 * @param {{material_id:number, active_pct:number, target_active_pct:number}[]} items
 */
export function targetWeighings(totalG, baseMaterialId, items) {
  const c = calcCharge(totalG, items);
  const rows = c.rows.map(r => ({
    material_id: r.material_id, row_type: 'additive',
    target_active_pct: r.target_active_pct, active_pct_snapshot: r.active_pct, target_g: r.g,
  }));
  rows.push({
    material_id: baseMaterialId, row_type: 'base',
    target_active_pct: null, active_pct_snapshot: null, target_g: c.baseG,
  });
  return { rows, over: c.over };
}

/**
 * 実秤量から実有効成分濃度を逆算する。
 *   実総量 W' = Σ actual_g（未入力の行は target_g で補完）
 *   実有効成分濃度 = actual_g × p / W' (%)
 *
 * @param {{row_type:string, target_active_pct:?number, active_pct_snapshot:?number,
 *          target_g:number, actual_g:?number}[]} rows
 * @returns {{total:number, entered:boolean, rows:Array<object & {real_pct:number, delta:number, estimated:boolean}>}}
 *   real_pct / delta（狙いとの差, pt）はベース樹脂の行では NaN。
 *   entered: 実秤量が1行でも入っている。
 *   estimated: 実秤量が入っている行と入っていない行が混ざっていて、補完した値で出した実濃度
 */
export function calcActual(rows) {
  const used = r => Number.isFinite(r.actual_g) ? r.actual_g : r.target_g;
  const total = rows.reduce((s, r) => s + (Number.isFinite(used(r)) ? used(r) : 0), 0);
  const entered = rows.some(r => Number.isFinite(r.actual_g));
  const partial = entered && rows.some(r => !Number.isFinite(r.actual_g));
  return {
    total,
    entered,
    rows: rows.map(r => {
      if (r.row_type !== 'additive' || !(total > 0)) return { ...r, real_pct: NaN, delta: NaN, estimated: false };
      const real = used(r) * r.active_pct_snapshot / total;
      return { ...r, real_pct: real, delta: real - r.target_active_pct, estimated: partial };
    }),
  };
}

// 実秤量が狙い量からこの割合を超えてずれたら、桁違いなどの取り違えを疑って知らせる
export const WEIGH_TOLERANCE = 0.1;

/** 実秤量が狙い量から WEIGH_TOLERANCE を超えてずれている行 */
export function weighOutliers(rows) {
  return rows.filter(r => Number.isFinite(r.actual_g) && r.target_g > 0 &&
    Math.abs(r.actual_g - r.target_g) / r.target_g > WEIGH_TOLERANCE);
}

/**
 * 配合の組成（ベース樹脂と、添加剤ごとの狙い濃度）を比較用の文字列にする。
 * 名前やメモの変更は含めない。配合の組成ロックと、新規サンプル保存時の「配合が変わったか」の判定に使う
 */
export function compositionSig(baseMaterialId, items) {
  return JSON.stringify([Number(baseMaterialId), items
    .map(i => [Number(i.material_id), Number(i.target_active_pct)])
    .sort((a, b) => a[0] - b[0])]);
}

/**
 * 配合に含まれる使用停止の原料の名前（ベース樹脂を含む）。
 * 使用停止の原料は有効成分%などの誤登録で止められていることがあり、そのまま秤量すると換算ミスになるので、
 * 新しいサンプルを作らせない（画面とサーバーで同じ判定にするため、ここに置く）
 * @param {{items:{archived:number, material_name:string}[]}} recipe GET /api/recipes の形
 * @param {{name:string, archived:number}|undefined} base ベース樹脂の原料
 */
export function archivedNames(recipe, base) {
  return [...(base?.archived ? [base.name] : []), ...recipe.items.filter(i => i.archived).map(i => i.material_name)];
}

/**
 * 使用停止の原料のうち、保存済みの組成に無かったもの（＝新しく組み込もうとしているもの）。
 * 配合の保存で拒否する。保存済みの組成に元からあるものは、名前やメモを直せるよう許す
 * @param {{id:number, name:string}[]} stopped 保存しようとしている組成に含まれる使用停止の原料
 * @param {{base_material_id:number, items:{material_id:number}[]}|null} saved 保存済みの配合（新規・複製なら null）
 */
export function archivedAdded(stopped, saved) {
  const had = new Set(saved ? [saved.base_material_id, ...saved.items.map(i => i.material_id)] : []);
  return stopped.filter(m => !had.has(m.id));
}

/** archivedAdded で見つかった原料を拒否するときの案内 */
export function archivedAddedMessage(added) {
  return `使用停止の原料（${added.map(m => m.name).join('、')}）は配合に使えません。別の原料に置き換えてください。`;
}

/** 使用停止の原料を含む配合から新しいサンプルを作ろうとしたときの案内 */
export function archivedMessage(names, sampleCount) {
  return `この配合には使用停止の原料（${names.join('、')}）が含まれているため、新しいサンプルを作れません。` +
    (sampleCount > 0
      ? '配合タブで「複製」し、原料を置き換えた配合を使ってください。'
      : '配合タブでこの配合の原料を置き換えてから作ってください。');
}

/**
 * 狙い量の計算元（basis）の違いを行ごとに出す。入力途中のサンプルで、配合の組成が変わった行を知らせるのに使う。
 * 行のキーは秤量の行と同じ 'base:<原料ID>' / 'additive:<原料ID>'
 * @returns {{changed:string[], removed:string[]}}
 *   changed: 新しい組成で増えた行と、狙い濃度・有効成分% が変わった行。removed: 新しい組成から外れた行
 */
export function compositionChanges(prev, next) {
  const rows = b => new Map([[`base:${b.base_material_id}`, ''],
    ...b.items.map(i => [`additive:${i.material_id}`, `${i.target_active_pct}/${i.active_pct}`])]);
  const before = rows(prev), now = rows(next);
  return {
    changed: [...now].filter(([k, v]) => before.get(k) !== v).map(([k]) => k),
    removed: [...before.keys()].filter(k => !now.has(k)),
  };
}

/** 保存済みサンプルの秤量明細（スナップショット）から、狙い量の計算元を作る */
export function basisFromWeighings(weighings) {
  return {
    base_material_id: weighings.find(w => w.row_type === 'base').material_id,
    items: weighings.filter(w => w.row_type === 'additive').map(w => ({
      material_id: w.material_id, target_active_pct: w.target_active_pct,
      active_pct: w.active_pct_snapshot, name: w.material_name,
    })),
  };
}
