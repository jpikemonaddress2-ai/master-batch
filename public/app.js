import { calcCharge } from './calc.mjs';

/* ===================== 共通 ===================== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : Number(n).toFixed(d);
const toNum = v => v === '' ? null : Number(v);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `通信エラー (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

const alertBox = msg => msg ? `<div class="alert">${esc(msg)}</div>` : '';

/* ===================== 状態 ===================== */
let materials = [];
let recipes = [];
let draft = null;   // 編集中の配合（保存前のコピー）
let dirty = false;

const matById = id => materials.find(m => m.id === id);
const resins = () => materials.filter(m => m.kind === 'resin' && !m.archived);
const additives = () => materials.filter(m => m.kind === 'additive' && !m.archived);

function setDirty(v) {
  dirty = v;
  $('#dirtyMark').hidden = !v;
}

function confirmDiscard() {
  return !dirty || confirm('保存していない変更があります。破棄してよろしいですか？');
}

window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });

function blankDraft() {
  return { id: null, code: '', name: '', base_material_id: resins()[0]?.id ?? null,
    default_qty_g: 1000, memo: '', items: [], version: null };
}

function toDraft(r) {
  return {
    id: r.id, code: r.code, name: r.name, base_material_id: r.base_material_id,
    default_qty_g: r.default_qty_g, memo: r.memo ?? '', version: r.version,
    items: r.items.map(i => ({ material_id: i.material_id, target_active_pct: i.target_active_pct })),
  };
}

async function reload() {
  [materials, recipes] = await Promise.all([api('GET', '/api/materials'), api('GET', '/api/recipes')]);
}

/* ===================== 配合一覧 ===================== */
function drawRecipeList() {
  const box = $('#recipeList');
  if (!recipes.length) {
    box.innerHTML = '<div class="hint" style="padding:12px 14px">配合はまだありません。下の「新規配合」から登録してください。</div>';
    return;
  }
  box.innerHTML = recipes.map(r => `
    <div class="list-item ${r.id === draft?.id ? 'on' : ''}" data-id="${r.id}">
      <span class="code">${esc(r.code)}</span>
      <span class="nm">${esc(r.name)}</span>
      <span class="meta">添加剤 ${r.items.length} 種 / 基準 ${Number(r.default_qty_g).toLocaleString()} g</span>
    </div>`).join('');
  box.querySelectorAll('.list-item').forEach(el => el.onclick = () => {
    const r = recipes.find(x => x.id === Number(el.dataset.id));
    if (r.id === draft?.id || !confirmDiscard()) return;
    openDraft(toDraft(r));
  });
}

/* ===================== 配合の編集 ===================== */
function openDraft(d) {
  draft = d;
  setDirty(false);
  drawRecipeList();
  drawForm();
}

function drawForm() {
  $('#rCode').value = draft.code;
  $('#rName').value = draft.name;
  $('#rQty').value = draft.default_qty_g ?? '';
  $('#rMemo').value = draft.memo;
  drawBaseSelect();
  drawItems();
}

function drawBaseSelect() {
  const list = resins();
  $('#rBase').innerHTML = list.length
    ? list.map(m => `<option value="${m.id}" ${m.id === draft.base_material_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')
    : '<option value="">（樹脂を原料マスタに登録してください）</option>';
  if (list.length && !list.some(m => m.id === draft.base_material_id)) draft.base_material_id = list[0].id;
}

function drawItems() {
  const adds = additives();
  const opts = sel => adds.map(m =>
    `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  $('#rItems').innerHTML = draft.items.length ? draft.items.map((it, i) => `
    <tr>
      <td><select style="width:100%" data-i="${i}" class="itMat">${opts(it.material_id)}</select></td>
      <td class="num" data-active="${i}"></td>
      <td class="num"><input type="number" step="any" min="0" style="width:100%" value="${it.target_active_pct ?? ''}" data-i="${i}" class="itPct"></td>
      <td class="num" data-g="${i}"></td>
      <td><button class="del" data-i="${i}">削除</button></td>
    </tr>`).join('')
    : `<tr><td colspan="5" class="hint">添加剤がありません。「＋ 添加剤を追加」で行を足してください。</td></tr>`;

  $('#rItems').querySelectorAll('.itPct').forEach(el => el.oninput = () => {
    draft.items[el.dataset.i].target_active_pct = toNum(el.value);
    setDirty(true); calcRecipe();
  });
  $('#rItems').querySelectorAll('.itMat').forEach(el => el.onchange = () => {
    draft.items[el.dataset.i].material_id = Number(el.value);
    setDirty(true); calcRecipe();
  });
  $('#rItems').querySelectorAll('.del').forEach(el => el.onclick = () => {
    draft.items.splice(Number(el.dataset.i), 1);
    setDirty(true); drawItems();
  });
  calcRecipe();
}

function calcRecipe() {
  const W = draft.default_qty_g || 0;
  const c = calcCharge(W, draft.items.map(it => ({
    active_pct: matById(it.material_id)?.active_pct,
    target_active_pct: it.target_active_pct ?? NaN,
  })));
  c.rows.forEach((row, i) => {
    $(`#rItems [data-g="${i}"]`).textContent = fmt(row.g, 2);
    $(`#rItems [data-active="${i}"]`).textContent = fmt(row.active_pct, 0);
  });
  $('#rSummary').innerHTML = `
    <div><div class="k">ベース樹脂</div><div class="v">${fmt(c.baseG, 1)}<small>g</small></div></div>
    <div><div class="k">添加剤 合計</div><div class="v">${fmt(c.addTotal, 1)}<small>g</small></div></div>
    <div><div class="k">総量</div><div class="v">${fmt(W, 1)}<small>g</small></div></div>
    <div><div class="k">添加剤 比率</div><div class="v">${fmt(W ? c.addTotal / W * 100 : 0, 2)}<small>wt%</small></div></div>`;
  $('#rAlert').innerHTML = c.over
    ? alertBox(`配合過剰: 添加剤の合計 ${fmt(c.addTotal, 1)} g が総量 ${fmt(W, 1)} g を超えています。狙い濃度か作成量を見直してください。`)
    : '';
  $('#save').disabled = c.over;
}

$('#rCode').oninput = e => { draft.code = e.target.value; setDirty(true); };
$('#rName').oninput = e => { draft.name = e.target.value; setDirty(true); };
$('#rMemo').oninput = e => { draft.memo = e.target.value; setDirty(true); };
$('#rBase').onchange = e => { draft.base_material_id = Number(e.target.value); setDirty(true); };
$('#rQty').oninput = e => { draft.default_qty_g = toNum(e.target.value); setDirty(true); calcRecipe(); };

$('#addItem').onclick = () => {
  const adds = additives();
  if (!adds.length) {
    toast('先に「原料マスタに登録」で添加剤を登録してください');
    return;
  }
  const used = new Set(draft.items.map(it => it.material_id));
  const next = adds.find(m => !used.has(m.id)) ?? adds[0];
  draft.items.push({ material_id: next.id, target_active_pct: null });
  setDirty(true);
  drawItems();
  $(`#rItems .itPct[data-i="${draft.items.length - 1}"]`)?.focus();
};

$('#newRecipe').onclick = () => {
  if (!confirmDiscard()) return;
  openDraft(blankDraft());
  $('#rCode').focus();
};

$('#duplicate').onclick = () => {
  if (!confirmDiscard()) return;
  const copy = { ...structuredClone(draft), id: null, version: null, code: '', name: `${draft.name}（複製）` };
  openDraft(copy);
  setDirty(true);
  $('#rCode').focus();
};

$('#save').onclick = async () => {
  const btn = $('#save');
  btn.disabled = true;
  try {
    const saved = draft.id === null
      ? await api('POST', '/api/recipes', draft)
      : await api('PUT', `/api/recipes/${draft.id}`, draft);
    await reload();
    openDraft(toDraft(saved));
    toast('保存しました');
  } catch (e) {
    $('#rAlert').innerHTML = alertBox(e.message);
  } finally {
    btn.disabled = false;
    calcRecipe();
  }
};

/* ===================== 原料マスタ登録 ===================== */
$('#addMat').onclick = () => {
  $('#matForm').reset();
  $('#mAlert').innerHTML = '';
  $('#matDlg').showModal();
  $('#mName').focus();
};

$('#matForm').onsubmit = async e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  try {
    const m = await api('POST', '/api/materials', {
      name: $('#mName').value, kind: $('#mKind').value, active_pct: $('#mActive').value,
      supplier: $('#mSupplier').value, memo: $('#mMemo').value,
    });
    materials = await api('GET', '/api/materials');
    // 編集中の内容は保ったまま、選択肢だけ更新する
    drawBaseSelect();
    drawItems();
    $('#matDlg').close();
    toast(`原料「${m.name}」を登録しました`);
  } catch (err) {
    $('#mAlert').innerHTML = alertBox(err.message);
  }
};

/* ===================== 起動 ===================== */
try {
  await reload();
  openDraft(recipes[0] ? toDraft(recipes[0]) : blankDraft());
} catch (e) {
  document.querySelector('main').innerHTML = alertBox(`サーバーに接続できません: ${e.message}`);
}
