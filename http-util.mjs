// ステータス付きの例外と、URL・ダウンロードまわりの小道具。
// db.mjs（入力の検証）と server.mjs（HTTP）で共用し、サーバーを起動せずにテストできるよう分けている。

export class HttpError extends Error {
  // code: 画面側で回復手段を出し分けるための識別子（例: 'stale' = 他の人が先に保存した）
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}

/**
 * URL などから来た id。正の整数（数字だけ）でなければ 400。
 * Number() に任せると NaN（SQL では NULL になり、絞り込みが外れる）や「1e2」「0x10」も通ってしまう
 */
export function positiveId(v, label) {
  const s = String(v ?? '').trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${label}の指定が不正です`);
  return n;
}

/** カンマ区切りの id の並び（例: "3,1,2"）。重複は除き、順番は保つ */
export function parseIds(raw, max, label) {
  const parts = String(raw ?? '').split(',').filter(Boolean);
  if (!parts.length) throw new HttpError(400, `${label}を選んでください`);
  if (parts.length > max) throw new HttpError(400, `一度に出せるのは ${max} 件までです`);
  return [...new Set(parts.map(v => positiveId(v, label)))];
}

/**
 * ダウンロードのファイル名。サンプル番号は日本語や記号を含みうるので、
 * ASCII に置き換えた名前と UTF-8 の名前（RFC 6266 / RFC 5987）の両方を付ける
 */
export function contentDisposition(name) {
  const filename = name.toWellFormed();   // 対になっていないサロゲートがあると encodeURIComponent が例外を投げる
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const utf8 = encodeURIComponent(filename).replace(/['()*!]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
