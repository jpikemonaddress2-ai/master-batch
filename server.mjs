import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { hostname } from 'node:os';
import { exec } from 'node:child_process';
import { PORT, HOST, PUBLIC_DIR, BARREL_ZONES } from './config.mjs';
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON の形式が不正です');
  }
}

// [メソッド, パスの正規表現, 処理]。正規表現のキャプチャは params として渡す
const routes = [
  ['GET', /^\/api\/config$/, () => ({ barrelZones: BARREL_ZONES })],
  ['GET', /^\/api\/materials$/, () => store.listMaterials()],
  ['POST', /^\/api\/materials$/, async req => store.createMaterial(await readJson(req))],
  ['GET', /^\/api\/recipes$/, () => store.listRecipes()],
  ['GET', /^\/api\/recipes\/(\d+)$/, (req, [id]) => store.getRecipe(Number(id))],
  ['POST', /^\/api\/recipes$/, async req => store.saveRecipe(await readJson(req))],
  ['PUT', /^\/api\/recipes\/(\d+)$/, async (req, [id]) => store.saveRecipe(await readJson(req), Number(id))],
];

async function handleApi(req, res, path) {
  for (const [method, re, fn] of routes) {
    const m = path.match(re);
    if (m && req.method === method) {
      return send(res, 200, await fn(req, m.slice(1)));
    }
  }
  throw new HttpError(404, 'API が見つかりません');
}

async function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
  const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
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
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (path.startsWith('/api/')) await handleApi(req, res, path);
    else await serveStatic(req, res, path);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
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

server.listen(PORT, HOST, () => {
  const local = `http://localhost:${PORT}`;
  console.log(`マスターバッチ管理を起動しました: ${local}`);
  if (HOST === '0.0.0.0') {
    console.log(`社内LANの他のPCからは: http://${hostname()}:${PORT}`);
  }
  console.log('終了するにはこのウィンドウを閉じるか Ctrl+C を押してください。');
  if (process.argv.includes('--open')) exec(`start "" ${local}`);
});
