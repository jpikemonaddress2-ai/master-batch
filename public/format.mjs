// 表示用の数値の書式。画面・比較表・CSV で共用する。値が無いときは '' を返す（画面側で '—' にする）

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

/** 符号付きの差。丸めると 0 になるときは符号を付けない（-0.000 や +0.000 を出さない） */
export function fmtDelta(d, digits) {
  if (!Number.isFinite(d)) return '';
  const s = d.toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return (d > 0 ? '+' : '') + s;
}
