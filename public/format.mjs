// 表示用の数値の書式。画面・比較表・CSV で共用する。値が無いときは '' を返す（画面側で '—' にする）。
// 表示の桁に関わる入力の解釈（実秤量の小数の桁数 decimalsOf）もここに置く

/** 質量 (g)。大きい値は桁を減らし、少量の添加剤（例 0.04 g）が 0.0 にならないようにする */
export function fmtG(g) {
  if (!Number.isFinite(g)) return '';
  const a = Math.abs(g);
  return g.toFixed(a >= 100 ? 1 : a >= 1 ? 2 : 3);
}

/** 入力された値を丸めずに出す（有効成分 33.3% を 33 にしない）。浮動小数の端数（0.30000000000000004 など）だけ落とす */
export function fmtRaw(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : '';
}

// 実秤量の小数の桁数として記録・表示する上限
export const MAX_DP = 10;

/**
 * 入力した数値の文字列の小数の桁数（「250.0」→ 1）。
 * 指数表記など桁数を決められない形と、MAX_DP より細かい桁は null（不明。表示は丸めずに出す）
 */
export function decimalsOf(text) {
  const m = String(text ?? '').trim().match(/^[+-]?(?:\d+\.?(\d*)|\.(\d+))$/);
  if (!m) return null;
  const n = (m[1] ?? m[2] ?? '').length;
  return n <= MAX_DP ? n : null;
}

/** 実秤量。入力した桁数（dp）があればその桁で出す（天びんで読んだ「250.0」の 0 を落とさない） */
export function fmtActual(g, dp) {
  if (g === null || g === undefined || g === '' || !Number.isFinite(Number(g))) return '';
  return Number.isInteger(dp) && dp >= 0 && dp <= MAX_DP ? Number(g).toFixed(dp) : fmtRaw(g);
}

/** 符号付きの差。丸めると 0 になるときは符号を付けない（-0.000 や +0.000 を出さない） */
export function fmtDelta(d, digits) {
  if (!Number.isFinite(d)) return '';
  const s = d.toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return (d > 0 ? '+' : '') + s;
}
