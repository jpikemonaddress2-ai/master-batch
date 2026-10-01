// 画面3: サンプル一覧
import { JUDGEMENTS } from './fields.mjs';
import { $, esc, api, state, showTab } from './common.js';
import { openSample } from './sample.js';
import { drawCompare } from './compare.js';

const FILTERS = { fRecipe: 'recipe', fFrom: 'from', fTo: 'to', fJudge: 'judgement', fText: 'q' };

let rows = [];
let total = 0;
export const selected = new Set();

function query() {
  const p = new URLSearchParams();
  for (const [id, key] of Object.entries(FILTERS)) {
    const v = $(`#${id}`).value.trim();
    if (v) p.set(key, v);
  }
  return p.toString();
}

async function refresh() {
  const q = query();
  let all;
  try {
    [rows, all] = await Promise.all([api('GET', `/api/samples?${q}`), q ? api('GET', '/api/samples') : null]);
  } catch (e) {
    $('#lRows').innerHTML = `<tr><td colspan="10" class="alert">${esc(e.message)}</td></tr>`;
    return;
  }
  all ??= rows;
  total = all.length;
  // 削除されたサンプルは選択から外す
  const exists = new Set(all.map(s => s.id));
  for (const id of selected) if (!exists.has(id)) selected.delete(id);
  $('#csv').href = `/api/samples.csv?${q}`;
  draw();
}

function draw() {
  $('#lCount').textContent = `${rows.length} 件表示 / 全 ${total} 件　選択 ${selected.size} 件`;
  $('#chkAll').checked = rows.length > 0 && rows.every(s => selected.has(s.id));
  $('#lRows').innerHTML = rows.length ? rows.map(s => `
    <tr data-id="${s.id}" class="clickable">
      <td><input type="checkbox" data-c="${s.id}" ${selected.has(s.id) ? 'checked' : ''} aria-label="${esc(s.code)} を選択"></td>
      <td style="font-family:var(--mono);color:var(--accent);font-weight:600">${esc(s.code)}</td>
      <td>${esc(s.made_on ?? '')}</td>
      <td>${esc(s.recipe_code)} <span style="color:var(--sub)">${esc(s.recipe_name)}</span></td>
      <td class="num">${s.total_qty_g?.toLocaleString() ?? ''}</td>
      <td class="num">${s.screw_rpm ?? ''}</td>
      <td class="num">${s.die_temp_c ?? ''}</td>
      <td class="num">${s.torque_pct ?? ''}</td>
      <td>${s.judgement ? `<span class="tag ${s.judgement}">${JUDGEMENTS[s.judgement]}</span>` : ''}</td>
      <td style="color:var(--muted)">${esc(s.appearance_note ?? '')}</td>
    </tr>`).join('')
    : `<tr><td colspan="10" class="empty">条件に一致するサンプルがありません</td></tr>`;

  $('#lRows').querySelectorAll('input[data-c]').forEach(el => el.onchange = () => {
    const id = Number(el.dataset.c);
    el.checked ? selected.add(id) : selected.delete(id);
    draw();
  });
  // 行をクリックするとサンプル記録で開く（チェックボックスは除く）
  $('#lRows').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = async e => {
    if (e.target.closest('input')) return;
    if (await openSample(Number(tr.dataset.id))) showTab('sample');
  });
}

function drawRecipeFilter() {
  const cur = $('#fRecipe').value;
  $('#fRecipe').innerHTML = '<option value="">すべて</option>' +
    state.recipes.map(r => `<option value="${r.id}">${esc(r.code)} — ${esc(r.name)}</option>`).join('');
  $('#fRecipe').value = state.recipes.some(r => String(r.id) === cur) ? cur : '';
}

let timer;
for (const id of Object.keys(FILTERS)) {
  $(`#${id}`).addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  });
}

$('#fClear').onclick = () => {
  for (const id of Object.keys(FILTERS)) $(`#${id}`).value = '';
  refresh();
};

$('#chkAll').onchange = e => {
  rows.forEach(s => e.target.checked ? selected.add(s.id) : selected.delete(s.id));
  draw();
};

$('#clearSel').onclick = () => {
  selected.clear();
  draw();
};

$('#goCompare').onclick = () => {
  showTab('compare');
  drawCompare([...selected]);
};

document.addEventListener('masters-changed', drawRecipeFilter);

// サンプルの保存・削除のあとに一覧を取り直す
document.addEventListener('samples-changed', refresh);

export async function initListTab() {
  drawRecipeFilter();
  await refresh();
}
