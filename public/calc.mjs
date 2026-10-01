// 配合計算ロジック。画面（app.js）とサーバー（db.mjs）の両方から import する。
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
 * @returns {{total:number, rows:Array<object & {real_pct:number, delta:number}>}}
 *   real_pct / delta（狙いとの差, pt）はベース樹脂の行では NaN
 */
export function calcActual(rows) {
  const used = r => Number.isFinite(r.actual_g) ? r.actual_g : r.target_g;
  const total = rows.reduce((s, r) => s + (Number.isFinite(used(r)) ? used(r) : 0), 0);
  return {
    total,
    rows: rows.map(r => {
      if (r.row_type !== 'additive' || !(total > 0)) return { ...r, real_pct: NaN, delta: NaN };
      const real = used(r) * r.active_pct_snapshot / total;
      return { ...r, real_pct: real, delta: real - r.target_active_pct };
    }),
  };
}
