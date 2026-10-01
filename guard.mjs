// 外部サイトからの書き込み・読み出しを防ぐ要求の検査。server.mjs から使い、test/guard.test.mjs で確かめる。
//
// 認証が無いので、社員が開いた外部の Web ページからこのサーバーへ送られる要求を拒否する。
// - Host 検証: DNS rebinding（外部ドメインをこのPCのアドレスに向ける手口）対策
// - Origin 検証と Content-Type: application/json の強制: CSRF（フォームや no-cors fetch からの POST）対策

/** Host ヘッダからポートを外して小文字にする（'[::1]:5173' → '[::1]'、'PU:5173' → 'pu'） */
export const stripPort = h => String(h).toLowerCase().replace(/:\d+$/, '');

/**
 * 受け付ける Host の集合を作る。
 * @param {{hostname:string, interfaces:object, extra:string[]}} p
 *   interfaces: os.networkInterfaces() の戻り値、extra: config.mjs の EXTRA_HOSTS
 */
export function allowedHostSet({ hostname, interfaces, extra = [] }) {
  return new Set([
    'localhost', '127.0.0.1', '[::1]', hostname.toLowerCase(),
    ...Object.values(interfaces).flat()
      .map(i => (i.family === 'IPv6' || i.family === 6 ? `[${i.address.split('%')[0]}]` : i.address).toLowerCase()),
    ...extra.map(stripPort),
  ]);
}

/**
 * 要求を検査する。問題がなければ null、拒否するなら { status, message }。
 * @param {{method:string, path:string, headers:object}} req headers は小文字のキー（node:http と同じ）
 * @param {Set<string>} allowed allowedHostSet の戻り値
 */
export function checkRequest({ method, path, headers }, allowed) {
  const host = headers.host ?? '';
  if (!allowed.has(stripPort(host))) {
    return { status: 403, message: `このアドレス（${host}）からは利用できません。config.mjs の EXTRA_HOSTS を確認してください` };
  }
  if (!path.startsWith('/api/') || method === 'GET' || method === 'HEAD') return null;
  const origin = headers.origin;
  if (origin !== undefined) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* 'null' など */ }
    if (originHost !== host.toLowerCase()) return { status: 403, message: '他のサイトからの要求は受け付けません' };
  }
  if (!/^application\/json\s*(;|$)/i.test(headers['content-type'] ?? '')) {
    return { status: 415, message: 'Content-Type は application/json にしてください' };
  }
  return null;
}
