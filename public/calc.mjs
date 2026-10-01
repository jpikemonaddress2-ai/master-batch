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
