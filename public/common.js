// 画面共通の小道具と、タブをまたいで使うマスタデータ
import { fmtG, fmtRaw } from './format.mjs';
import { archivedNames } from './calc.mjs';

export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (n, d = 1) =>
  (n === null || n === undefined || Number.isNaN(n)) ? '—' : Number(n).toFixed(d);
// 質量と、入力した値（有効成分%など）の表示。値が無ければ —
export const fmtGram = g => fmtG(g) || '—';
export const fmtVal = v => fmtRaw(v) || '—';
export const toNum = v => v === '' ? null : Number(v);
/**
 * エラー表示。保存の失敗のように一度だけ出るものは role="alert" で読み上げる。
 * 入力のたびに描き直す欄（配合過剰の警告など）では live: false にし、容器の aria-live に任せる
 * （role="alert" だと、1 文字打つごとに同じ警告が読み上げ直される）
 */
export const alertBox = (msg, { live = true } = {}) =>
  msg ? `<div class="alert"${live ? ' role="alert"' : ''}>${esc(msg)}</div>` : '';

/** 入力のたびに描き直す欄の中身を、変わったときだけ書き換える（aria-live の読み上げを繰り返さない） */
export function setIfChanged(box, html) {
  if (box.dataset.html === html) return;
  box.dataset.html = html;
  box.innerHTML = html;
}

/**
 * 数値として読めない入力（「40.5.」「40,5」など）のある数値欄を探す。
 * 数値欄はそういう入力のとき value が '' になり、未入力と区別できないため、保存の前にこれで止める
 * @returns {{el:HTMLInputElement, label:string}|null}
 */
export function findBadNumber(root) {
  const el = [...root.querySelectorAll('input[type=number]')].find(i => !i.disabled && i.validity.badInput);
  if (!el) return null;
  const label = el.getAttribute('aria-label') || el.labels?.[0]?.textContent.replace('*', '').trim() || '数値';
  return { el, label };
}

/** 保存の前の確認。読めない数値があれば box にエラーを出してその欄にフォーカスし、true を返す */
export function stopOnBadNumber(root, box) {
  const bad = findBadNumber(root);
  if (!bad) return false;
  box.innerHTML = alertBox(`「${bad.label}」の入力を数値として読めません。半角の数字と小数点 1 つで入力し直してください`);
  bad.el.focus();
  return true;
}

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
  box.innerHTML = `<div class="alert" role="alert">${esc(msg)}
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
export const state = { materials: [], recipes: [], config: { barrelZones: null } };

export const matById = id => state.materials.find(m => m.id === id);
export const recipeById = id => state.recipes.find(r => r.id === id);

/** 配合に含まれる使用停止の原料の名前（ベース樹脂を含む） */
export const archivedInRecipe = r => archivedNames(r, matById(r.base_material_id));

// 原料・配合を読み直し、各タブに知らせる（選択肢の更新など）
export async function reloadMasters() {
  [state.materials, state.recipes] = await Promise.all([api('GET', '/api/materials'), api('GET', '/api/recipes')]);
  document.dispatchEvent(new Event('masters-changed'));
}

/**
 * 原料の選択肢。使用停止の原料は出さないが、いま選ばれているものだけは「（使用停止）」と付けて残す
 * （残さないと、保存済みの配合を開いただけで別の原料に黙って置き換わってしまう）
 */
export function materialOptions(kind, selectedId) {
  return state.materials
    .filter(m => m.kind === kind && (!m.archived || m.id === selectedId))
    .map(m => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${esc(m.name)}${m.archived ? '（使用停止）' : ''}</option>`)
    .join('');
}

/* ---------- 未保存の変更 ---------- */
const dirtyChecks = [];
window.addEventListener('beforeunload', e => { if (dirtyChecks.some(f => f())) e.preventDefault(); });

/**
 * タブごとの「未保存の変更あり」の管理。
 * @param {string} markSel 「未保存の変更あり」を出す要素
 * @param {string} message 破棄の確認で出す文
 */
export function createDirty(markSel, message) {
  let dirty = false;
  dirtyChecks.push(() => dirty);
  return {
    get: () => dirty,
    set(v) {
      dirty = v;
      $(markSel).hidden = !v;
    },
    confirmDiscard: () => !dirty || confirm(message),
  };
}

/* ---------- タブ ---------- */
export function showTab(name) {
  document.querySelectorAll('nav button').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== `tab-${name}`; });
}

/* ---------- 記入者（このブラウザに覚えておく） ---------- */
export function rememberedAuthor() {
  try { return localStorage.getItem('mb.author') || ''; } catch { return ''; }
}
export function rememberAuthor(name) {
  try { localStorage.setItem('mb.author', name); } catch { /* 保存できなくても動作に支障なし */ }
}

export const today = () => new Date().toLocaleDateString('sv-SE');

/* ---------- 数値欄の読めない入力 ---------- */
// 「4e」「1-2」のように数値として読めない入力の欄に印を付ける（:invalid は必須の空欄にも当たるので使わない）
document.addEventListener('input', e => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'number') {
    e.target.classList.toggle('bad', e.target.validity.badInput);
    if (e.target.validity.badInput) e.target.setAttribute('aria-invalid', 'true');
    else e.target.removeAttribute('aria-invalid');
  }
});

/* ---------- 数値欄のホイール ---------- */
// フォーカス中の数値欄の上でホイールを回すと値が変わってしまう（実秤量の誤変更）ので、ページのスクロールにする
document.addEventListener('wheel', e => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'number' && e.target === document.activeElement) {
    e.target.blur();
  }
}, { passive: true });
