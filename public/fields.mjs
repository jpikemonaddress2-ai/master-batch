// サンプルの固定項目の定義。画面（入力欄・比較表・CSV）とサーバー（検証・SQL）で共用する。
// key は samples テーブルの列名と一致させる。

// 造粒条件（運転）。バレル温度とダイ温度は別枠で扱う
export const COND_FIELDS = [
  { key: 'screw_rpm',          label: 'スクリュー回転数', unit: 'rpm' },
  { key: 'feed_rate_kg_h',     label: '吐出量',           unit: 'kg/h' },
  { key: 'torque_pct',         label: 'トルク',           unit: '%' },
  { key: 'resin_pressure_mpa', label: '樹脂圧',           unit: 'MPa' },
  { key: 'vacuum_kpa',         label: '真空度',           unit: 'kPa' },
  { key: 'strand_bath_temp_c', label: '冷却水温',         unit: '℃' },
  { key: 'pelletizer_rpm',     label: 'ペレタイザ',       unit: 'rpm' },
  { key: 'predry_temp_c',      label: '予備乾燥 温度',    unit: '℃' },
  { key: 'predry_hours',       label: '予備乾燥 時間',    unit: 'h' },
];

export const JUDGEMENTS = { good: '良', ok: '可', ng: '不可' };
