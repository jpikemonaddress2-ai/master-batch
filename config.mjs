import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = dirname(fileURLToPath(import.meta.url));

// 待ち受けポート。他のアプリと衝突する場合はここを変える。
export const PORT = Number(process.env.MB_PORT) || 5173;

// 待ち受けアドレス。
//   '127.0.0.1' … このPCからだけ開ける（初期値）
//   '0.0.0.0'   … 社内LANの他のPCからも http://<PC名>:5173 で開ける
//                 （Windows ファイアウォールの許可が必要）
export const HOST = process.env.MB_HOST || '127.0.0.1';

// 押出機のバレル温度ゾーン数。実機に合わせてこの数字を変えるだけで
// 入力欄・比較表・CSV の列がすべて追従する。
export const BARREL_ZONES = 8;

export const DB_PATH = process.env.MB_DB || join(ROOT, 'data', 'masterbatch.db');
export const PUBLIC_DIR = join(ROOT, 'public');
