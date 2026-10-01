// サンプルの固定項目の定義。画面（入力欄・比較表・CSV）とサーバー（検証・SQL）で共用する。
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

// 1サンプルあたりの上限（不正な要求で巨大なデータを作らせないため）
export const MAX_ZONES = 30;
export const MAX_EXTRAS = 200;
export const MAX_ITEMS = 50;
