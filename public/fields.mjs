// サンプルの固定項目の定義と、項目の値の検証（原料の CAS 番号など）。画面（入力欄・比較表・CSV）とサーバー（検証・SQL）で共用する。
// key は samples テーブルの列名と一致させる。
// 項目を足したら、db.mjs の MIGRATIONS の末尾に `ALTER TABLE samples ADD COLUMN <key> REAL;` を足すこと
// （足さないと既存の DB で保存が失敗する）。足す前に保存した記録や変更履歴では、その項目は空になる。

// 造粒条件（運転）。バレル温度とダイ温度は別枠で扱う
export const COND_FIELDS = [
  { key: 'screw_rpm',          label: 'スクリュー回転数',   unit: 'rpm' },
  { key: 'feed_rate_kg_h',     label: '吐出量',             unit: 'kg/h' },
  { key: 'torque_pct',         label: 'トルク',             unit: '%' },
  { key: 'resin_pressure_mpa', label: '樹脂圧',             unit: 'MPa' },
  { key: 'resin_temp_c',       label: '樹脂温度（実測）',   unit: '℃' },
  { key: 'vacuum_kpa',         label: '真空度（ゲージ圧）', unit: 'kPa' },
  { key: 'strand_bath_temp_c', label: '冷却水温',           unit: '℃' },
  { key: 'pelletizer_rpm',     label: 'ペレタイザ',         unit: 'rpm' },
  { key: 'predry_temp_c',      label: '予備乾燥 温度',      unit: '℃' },
  { key: 'predry_hours',       label: '予備乾燥 時間',      unit: 'h' },
];

export const JUDGEMENTS = { good: '良', ok: '可', ng: '不可' };

/** CAS 番号の表記をそろえる（全角の数字・ハイフンを半角に、前後の空白を除く） */
export const normCas = s => String(s ?? '').normalize('NFKC').replace(/[‐-―−ー]/g, '-').trim();

/**
 * CAS 番号の形（2〜7桁-2桁-1桁）とチェックディジットを確かめる。正しければ null、誤りなら理由
 * チェックディジット: 末尾以外の数字を右から 1, 2, 3… 倍して足し、10 で割った余り
 */
export function casError(cas) {
  const m = cas.match(/^(\d{2,7})-(\d{2})-(\d)$/);
  if (!m) return `CAS 番号「${cas}」の形が正しくありません（例: 6683-19-8）`;
  const digits = (m[1] + m[2]).split('').reverse();
  const sum = digits.reduce((s, d, i) => s + Number(d) * (i + 1), 0);
  return sum % 10 === Number(m[3]) ? null : `CAS 番号「${cas}」のチェックディジットが合いません（打ち間違いがないか確認してください）`;
}

// 1サンプルあたりの上限（不正な要求で巨大なデータを作らせないため）
export const MAX_ZONES = 30;
export const MAX_EXTRAS = 200;
export const MAX_ITEMS = 50;
