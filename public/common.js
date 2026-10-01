// 画面共通の小道具と、タブをまたいで使うマスタデータ

export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (n, d = 1) =>
  (n === null || n === undefined || Number.isNaN(n)) ? '—' : Number(n).toFixed(d);
export const toNum = v => v === '' ? null : Number(v);
export const alertBox = msg => msg ? `<div class="alert">${esc(msg)}</div>` : '';

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `通信エラー (${res.status})`);
    err.status = res.status;
    err.code = data.code ?? null;   // 'stale' = 他の人が先に保存した、など
    throw err;
  }
  return data;
}

/**
 * エラー表示に回復用のボタンを1つ付けて box に出す。
 * 「他の人が先に保存しました」のように、読み直す以外に抜け道がないエラーで使う。
 */
export function showAlertWithAction(box, msg, label, onClick) {
  box.innerHTML = `<div class="alert">${esc(msg)}
    <button type="button" class="btn" style="margin-left:10px">${esc(label)}</button></div>`;
  box.querySelector('button').onclick = onClick;
}

export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- マスタ ---------- */
export const state = { materials: [], recipes: [], config: { barrelZones: 8 } };

export const matById = id => state.materials.find(m => m.id === id);
export const recipeById = id => state.recipes.find(r => r.id === id);

// 原料・配合を読み直し、各タブに知らせる（選択肢の更新など）
export async function reloadMasters() {
  [state.materials, state.recipes] = await Promise.all([api('GET', '/api/materials'), api('GET', '/api/recipes')]);
  document.dispatchEvent(new Event('masters-changed'));
}

/* ---------- 未保存の変更 ---------- */
const dirtyChecks = [];
export const registerDirty = fn => dirtyChecks.push(fn);
window.addEventListener('beforeunload', e => { if (dirtyChecks.some(f => f())) e.preventDefault(); });

/* ---------- タブ ---------- */
export function showTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== `tab-${name}`; });
}

/* ---------- 記入者（このブラウザに覚えておく） ---------- */
export function rememberedAuthor() {
  try { return localStorage.getItem('mb.author') || ''; } catch { return ''; }
}
export function rememberAuthor(name) {
  try { localStorage.setItem('mb.author', name); } catch { /* 保存できなくても動作に支障なし */ }
}

/** 変更履歴に残す名前。覚えていなければ尋ねる。断られたら null */
export function askEditor() {
  let name = rememberedAuthor();
  if (!name) {
    name = (prompt('あなたの名前を入力してください（変更履歴に残します）') ?? '').trim();
    if (name) rememberAuthor(name);
  }
  return name || null;
}

export const today = () => new Date().toLocaleDateString('sv-SE');
