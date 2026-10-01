import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { exec } from 'node:child_process';
import { PORT, HOST, PUBLIC_DIR, BARREL_ZONES, EXTRA_HOSTS } from './config.mjs';
import * as store from './db.mjs';

const { HttpError } = store;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'リクエストが大きすぎます');
    chunks.push(c);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON の形式が不正です');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON の形式が不正です');
  return body;
}

/* ---------- 外部サイトからの書き込み・読み出しを防ぐ ----------
 * 認証が無いので、社員が開いた外部の Web ページからこのサーバーへ送られる要求を拒否する。
 * - Host 検証: DNS rebinding（外部ドメインをこのPCのアドレスに向ける手口）対策
 * - Origin 検証と Content-Type: application/json の強制: CSRF（フォームや no-cors fetch からの POST）対策 */
const allowedHosts = new Set([
  'localhost', '127.0.0.1', '[::1]', hostname().toLowerCase(),
  ...Object.values(networkInterfaces()).flat()
    .map(i => (i.family === 'IPv6' ? `[${i.address.split('%')[0]}]` : i.address).toLowerCase()),
  ...EXTRA_HOSTS.map(h => h.toLowerCase()),
]);
const stripPort = h => h.toLowerCase().replace(/:\d+$/, '');

function checkRequest(req, url) {
  const host = req.headers.host ?? '';
  if (!allowedHosts.has(stripPort(host))) {
    throw new HttpError(403, `このアドレス（${host}）からは利用できません。config.mjs の EXTRA_HOSTS を確認してください`);
  }
  if (!url.pathname.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* 'null' など */ }
    if (originHost !== host.toLowerCase()) throw new HttpError(403, '他のサイトからの要求は受け付けません');
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Content-Type は application/json にしてください');
  }
}

// [メソッド, パスの正規表現, 処理(req, params, query)]。正規表現のキャプチャを params、クエリ文字列を query として渡す。
// 処理の戻り値は JSON で返す。Csv を返したときだけ CSV ファイルとしてダウンロードさせる
class Csv { constructor(body, filename) { this.body = body; this.filename = filename; } }
const filters = q => Object.fromEntries(['recipe', 'from', 'to', 'judgement', 'q'].map(k => [k, q.get(k) || null]));
const stamp = () => new Date().toLocaleDateString('sv-SE').replaceAll('-', '');

const routes = [
  ['GET', /^\/api\/config$/, () => ({ barrelZones: BARREL_ZONES })],
  ['GET', /^\/api\/materials$/, () => store.listMaterials()],
  ['POST', /^\/api\/materials$/, async req => store.createMaterial(await readJson(req))],
  ['GET', /^\/api\/recipes$/, () => store.listRecipes()],
  ['GET', /^\/api\/recipes\/(\d+)$/, (req, [id]) => store.getRecipe(Number(id))],
  ['POST', /^\/api\/recipes$/, async req => store.saveRecipe(await readJson(req))],
  ['PUT', /^\/api\/recipes\/(\d+)$/, async (req, [id]) => store.saveRecipe(await readJson(req), Number(id))],
  ['GET', /^\/api\/samples$/, (req, p, q) => store.listSamples(filters(q))],
  ['GET', /^\/api\/samples\.csv$/, (req, p, q) => new Csv(store.samplesCsv(filters(q)), `samples_${stamp()}.csv`)],
  ['GET', /^\/api\/samples\/(\d+)$/, (req, [id]) => store.getSample(Number(id))],
  ['POST', /^\/api\/samples$/, async req => store.saveSample(await readJson(req))],
  ['PUT', /^\/api\/samples\/(\d+)$/, async (req, [id]) => store.saveSample(await readJson(req), Number(id))],
  ['DELETE', /^\/api\/samples\/(\d+)$/, async (req, [id]) => store.deleteSample(Number(id), await readJson(req))],
  ['GET', /^\/api\/samples\/(\d+)\/history$/, (req, [id]) => store.listHistory(Number(id))],
  ['GET', /^\/api\/extra-labels$/, () => store.listExtraLabels()],
];

async function handleApi(req, res, url) {
  for (const [method, re, fn] of routes) {
    const m = url.pathname.match(re);
    if (m && req.method === method) {
      const out = await fn(req, m.slice(1), url.searchParams);
      if (out instanceof Csv) {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${out.filename}"`,
          'Cache-Control': 'no-store',
        });
        return res.end(out.body);
      }
      return send(res, 200, out);
    }
  }
  throw new HttpError(404, 'API が見つかりません');
}

async function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
  let rel;
  try {
    rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  } catch {
    throw new HttpError(400, 'Bad Request');
  }
  const file = normalize(join(PUBLIC_DIR, rel));
  // public/ の外（../ など）は読ませない
  if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'Not Found');
  let data;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  send(res, 200, data, MIME[extname(file).toLowerCase()] || 'application/octet-stream');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    checkRequest(req, url);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    send(res, 500, { error: 'サーバー内部でエラーが発生しました' });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は既に使われています。既に起動していないか確認するか、config.mjs の PORT を変えてください。`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

// 終了時に WAL を本体へ書き戻して DB を閉じる（Ctrl+C / ウィンドウを閉じる / タスク終了）
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  try { store.closeDb(); } catch (e) { console.error(e); }
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);

server.listen(PORT, HOST, () => {
  const local = `http://localhost:${PORT}`;
  console.log(`マスターバッチ管理を起動しました: ${local}`);
  if (HOST === '0.0.0.0') {
    console.log(`社内LANの他のPCからは: http://${hostname()}:${PORT}`);
  }
  console.log('終了するにはこのウィンドウを閉じるか Ctrl+C を押してください。');
  if (process.argv.includes('--open')) exec(`start "" ${local}`);
});
