import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { exec } from 'node:child_process';
import { PORT, HOST, PUBLIC_DIR, BARREL_ZONES, EXTRA_HOSTS } from './config.mjs';
import { allowedHostSet, checkRequest } from './guard.mjs';
import * as store from './db.mjs';

const { HttpError } = store;

// 配信するファイルの種類。ここに無い拡張子は返さない
// （Windows の予約名 CON / AUX などを開こうとして止まるのも防ぐ）
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',   // 他のサイトに埋め込ませない（削除ボタンなどを押させる手口を防ぐ）
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...headers });
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

// 受け付けるアドレス。IP は DHCP や VPN で変わるので、知らないアドレスで来たら一度だけ作り直して確かめる
const buildAllowed = () => allowedHostSet({ hostname: hostname(), interfaces: networkInterfaces(), extra: EXTRA_HOSTS });
let allowedHosts = buildAllowed();

function guard(req, url) {
  const r = { method: req.method, path: url.pathname, headers: req.headers };
  let bad = checkRequest(r, allowedHosts);
  if (bad?.status === 403) {
    allowedHosts = buildAllowed();
    bad = checkRequest(r, allowedHosts);
  }
  if (bad) throw new HttpError(bad.status, bad.message);
}

class Csv { constructor(body, filename) { this.body = body; this.filename = filename; } }
const filters = q => Object.fromEntries(['recipe', 'from', 'to', 'judgement', 'q'].map(k => [k, q.get(k) || null]));
const stamp = () => new Date().toLocaleDateString('sv-SE').replaceAll('-', '');

// [メソッド, パスの正規表現, 処理(req, params, query)]。正規表現のキャプチャを params、クエリ文字列を query として渡す。
// 処理の戻り値は JSON で返す。Csv を返したときだけ CSV ファイルとしてダウンロードさせる
const routes = [
  ['GET', /^\/api\/config$/, () => ({ barrelZones: BARREL_ZONES })],
  ['GET', /^\/api\/materials$/, () => store.listMaterials()],
  ['POST', /^\/api\/materials$/, async req => store.createMaterial(await readJson(req))],
  ['PUT', /^\/api\/materials\/(\d+)$/, async (req, [id]) => store.updateMaterial(Number(id), await readJson(req))],
  ['GET', /^\/api\/recipes$/, () => store.listRecipes()],
  ['GET', /^\/api\/recipes\/(\d+)$/, (req, [id]) => store.getRecipe(Number(id))],
  ['GET', /^\/api\/recipes\/(\d+)\/history$/, (req, [id]) => store.listRecipeHistory(Number(id))],
  ['POST', /^\/api\/recipes$/, async req => store.saveRecipe(await readJson(req))],
  ['PUT', /^\/api\/recipes\/(\d+)$/, async (req, [id]) => store.saveRecipe(await readJson(req), Number(id))],
  ['GET', /^\/api\/samples$/, (req, p, q) => store.listSamples(filters(q), { limit: Number(q.get('limit')) || null })],
  ['GET', /^\/api\/samples\/count$/, () => ({ count: store.countSamples() })],
  ['GET', /^\/api\/samples\.csv$/, (req, p, q) => new Csv(store.samplesCsv(filters(q)), `samples_${stamp()}.csv`)],
  ['GET', /^\/api\/samples\/(\d+)$/, (req, [id]) => store.getSample(Number(id))],
  ['POST', /^\/api\/samples$/, async req => store.saveSample(await readJson(req))],
  ['PUT', /^\/api\/samples\/(\d+)$/, async (req, [id]) => store.saveSample(await readJson(req), Number(id))],
  ['DELETE', /^\/api\/samples\/(\d+)$/, async (req, [id]) => store.deleteSample(Number(id), await readJson(req))],
  ['GET', /^\/api\/samples\/(\d+)\/history$/, (req, [id]) => store.listHistory(Number(id))],
  ['GET', /^\/api\/deleted-samples$/, () => store.listDeletedSamples()],
  ['GET', /^\/api\/extra-labels$/, () => store.listExtraLabels()],
];

async function handleApi(req, res, url) {
  for (const [method, re, fn] of routes) {
    const m = url.pathname.match(re);
    if (m && req.method === method) {
      const out = await fn(req, m.slice(1), url.searchParams);
      if (out instanceof Csv) {
        return send(res, 200, out.body, 'text/csv; charset=utf-8',
          { 'Content-Disposition': `attachment; filename="${out.filename}"` });
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
  const type = MIME[extname(file).toLowerCase()];
  // public/ の外（../ など）と、配信対象でない種類のファイルは読ませない
  if (!file.startsWith(PUBLIC_DIR + sep) || !type) throw new HttpError(404, 'Not Found');
  let data;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  send(res, 200, data, type);
}

const server = createServer(async (req, res) => {
  try {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      throw new HttpError(400, 'Bad Request');
    }
    guard(req, url);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    send(res, 500, { error: 'サーバー内部でエラーが発生しました' });
  }
});

// 想定外の例外でサーバーごと落ちないようにする（記録だけ残して動き続ける）
process.on('unhandledRejection', e => console.error(e));

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は既に使われています。既に起動していないか確認するか、config.mjs の PORT を変えてください。`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

// 終了時に WAL を本体へ書き戻して DB を閉じる（Ctrl+C / ウィンドウを閉じる）。
// タスクマネージャーなどでの強制終了では呼ばれないが、その場合も次に起動したときに WAL から復元される
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
