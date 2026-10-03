// 画面3: サンプル一覧
import { JUDGEMENTS } from './fields.mjs';
import { $, esc, api, state, showTab, toast, alertBox, downloadCsv, whileBusy } from './common.js';
import { openSample, showSampleDiff, unitList } from './sample.js';
import { drawCompare } from './compare.js';

const FILTERS = {
  fRecipe: 'recipe', fFrom: 'from', fTo: 'to', fJudge: 'judgement', fText: 'q', fMLabel: 'mlabel', fMMin: 'mmin', fMMax: 'mmax',
};

let rows = [];
let total = 0;
let shownQuery = '';   // いま表に出している絞り込み条件（CSV に使う）
let seq = 0;   // 絞り込みの要求の通し番号。遅れて返ってきた古い結果で上書きしないため
export const selected = new Set();

function query() {
  const p = new URLSearchParams();
  for (const [id, key] of Object.entries(FILTERS)) {
    const v = $(`#${id}`).value.trim();
    if (v) p.set(key, v);
  }
  // 項目名の無い範囲は送らない（絞り込まずに一覧を出し、入力の不足は drawMeasureWarn で知らせる）
  if (!p.has('mlabel')) { p.delete('mmin'); p.delete('mmax'); }
  return p.toString();
}

async function refresh() {
  const from = $('#fFrom').value, to = $('#fTo').value;
  $('#fRangeWarn').hidden = !(from && to && from > to);
  const q = query();
  const my = ++seq;
  drawMeasureWarn(my);
  $('#lAlert').innerHTML = '';   // 前の CSV のエラーは、条件を変えたら消す
  $('#lRows').setAttribute('aria-busy', 'true');
  $('#lCount').textContent = '読み込み中…';
  let result, count;
  try {
    [result, count] = await Promise.all([api('GET', `/api/samples?${q}`), api('GET', '/api/samples/count')]);
  } catch (e) {
    if (my !== seq) return;
    $('#lRows').innerHTML = `<tr><td colspan="11" class="alert">${esc(e.message)}</td></tr>`;
    $('#lCount').textContent = '';
    return;
  } finally {
    if (my === seq) $('#lRows').removeAttribute('aria-busy');
  }
  if (my !== seq) return;
  rows = result;
  total = count.count;
  shownQuery = q;
  draw();
}

// 自由項目の項目名と単位（測定値の絞り込みの注意に使う）。サンプルが保存・削除されたら取り直す
let labelsCache = null;

/**
 * 測定値の絞り込みの注意。数値として読めない下限・上限、下限 > 上限、範囲だけで項目名が空のとき、
 * その項目に単位が複数あるとき（単位は区別せずに絞り込むため）、記録の無い項目名のとき
 */
async function drawMeasureWarn(my) {
  const label = $('#fMLabel').value.trim();
  const min = $('#fMMin'), max = $('#fMMax');
  const ranged = min.value.trim() || max.value.trim();
  let msg = '';
  if (min.validity.badInput || max.validity.badInput) {
    msg = '測定値の下限・上限に数値として読めない値があります（その条件は使っていません）';
  } else if (min.value !== '' && max.value !== '' && Number(min.value) > Number(max.value)) {
    msg = '測定値の下限が上限より大きくなっています';
  } else if (!label) {
    msg = ranged ? '測定値の範囲で絞り込むときは、項目名を入力してください' : '';
  } else {
    try {
      labelsCache ??= await api('GET', '/api/extra-labels');
    } catch {
      labelsCache = null;
    }
    if (my !== seq) return;
    const known = labelsCache?.find(l => l.category === 'measurement' && l.label === label);
    if (labelsCache && !known) msg = `測定値「${label}」の記録はありません（項目名は完全一致）`;
    else if (known?.units.length > 1) msg = `「${label}」は単位が複数あります（${unitList(known.units)}）。単位を区別せずに絞り込みます`;
  }
  $('#fMWarn').textContent = msg;
  $('#fMWarn').hidden = !msg;
}

// 件数と「全選択」・比較ボタンだけを更新する（表を描き直すとチェック中のフォーカスが失われるため）
function drawCount() {
  $('#lCount').textContent = `${rows.length} 件表示 / 全 ${total} 件　選択 ${selected.size} 件`;
  $('#chkAll').checked = rows.length > 0 && rows.every(s => selected.has(s.id));
  $('#goCompare').disabled = selected.size < 2;
  $('#goCompare').title = selected.size < 2 ? '2 件以上を選択してください' : '';
}

function draw() {
  drawCount();
  $('#lRows').innerHTML = rows.length ? rows.map(s => `
    <tr data-id="${s.id}" class="clickable">
      <td class="sel"><input type="checkbox" data-c="${s.id}" ${selected.has(s.id) ? 'checked' : ''} aria-label="${esc(s.code)} を選択"></td>
      <td><button type="button" class="link code-link">${esc(s.code)}</button></td>
      <td>${esc(s.made_on ?? '')}</td>
      <td>${esc(s.recipe_code)} <span style="color:var(--sub)">${esc(s.recipe_name)}</span></td>
      <td class="num">${s.total_qty_g?.toLocaleString() ?? ''}</td>
      <td class="num">${s.screw_rpm ?? ''}</td>
      <td class="num">${s.die_temp_c ?? ''}</td>
      <td class="num">${s.torque_pct ?? ''}</td>
      <td>${s.judgement ? `<span class="tag ${s.judgement}">${JUDGEMENTS[s.judgement]}</span>` : ''}</td>
      <td class="meas" title="${esc(s.measurements ?? '')}">${esc(s.measurements ?? '')}</td>
      <td style="color:var(--muted)">${esc(s.appearance_note ?? '')}</td>
    </tr>`).join('')
    : `<tr><td colspan="11" class="empty">条件に一致するサンプルがありません</td></tr>`;

  $('#lRows').querySelectorAll('input[data-c]').forEach(el => el.onchange = () => {
    const id = Number(el.dataset.c);
    el.checked ? selected.add(id) : selected.delete(id);
    drawCount();
  });
  // 行（またはサンプル番号のボタン）でサンプル記録を開く。
  // チェックボックスの列は、押し損ねても別の画面へ移らないよう、列のどこを押してもチェックの切り替えにする
  $('#lRows').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = async e => {
    if (e.target.closest('td.sel')) {
      if (!e.target.closest('input')) tr.querySelector('input[data-c]').click();
      return;
    }
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
  $(`#${id}`).addEventListener('input', e => {
    // 日本語入力の変換中は検索しない（確定したときに検索する）
    if (e.isComposing) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  });
}
for (const id of ['fText', 'fMLabel']) {
  $(`#${id}`).addEventListener('compositionend', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  });
}

$('#csv').onclick = () => whileBusy($('#csv'), 'CSV を作成中…', async () => {
  $('#lAlert').innerHTML = '';
  try {
    await downloadCsv(`/api/samples.csv?${shownQuery}`);
  } catch (e) {
    $('#lAlert').innerHTML = alertBox(`CSV をエクスポートできませんでした: ${e.message}`);
  }
});

$('#fClear').onclick = () => {
  for (const id of Object.keys(FILTERS)) $(`#${id}`).value = '';
  refresh();
};

$('#chkAll').onchange = e => {
  rows.forEach(s => e.target.checked ? selected.add(s.id) : selected.delete(s.id));
  $('#lRows').querySelectorAll('input[data-c]').forEach(el => { el.checked = e.target.checked; });
  drawCount();
};

$('#clearSel').onclick = () => {
  selected.clear();
  draw();
};

$('#goCompare').onclick = () => {
  showTab('compare');
  drawCompare([...selected]);
};

/* ---------- 削除済みサンプル ---------- */
$('#openDeleted').onclick = async () => {
  let list;
  try {
    list = await api('GET', '/api/deleted-samples');
  } catch (e) {
    toast(e.message);
    return;
  }
  $('#delRows').innerHTML = list.length ? list.map((d, i) => `
    <tr>
      <td>${esc(d.snapshot.code)}</td><td>${esc(d.snapshot.recipe_code)}</td><td>${esc(d.snapshot.made_on ?? '')}</td>
      <td>${esc(d.changed_at)}</td><td>${esc(d.changed_by)}</td>
      <td><button type="button" class="link" data-d="${i}">削除前の内容</button></td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="empty">削除したサンプルはありません。</td></tr>';
  $('#delRows').querySelectorAll('button[data-d]').forEach(b => b.onclick = () => {
    const d = list[Number(b.dataset.d)];
    $('#delDlg').close();
    showSampleDiff(`削除済み: ${d.snapshot.code}（${d.changed_at} ${d.changed_by} が削除）`, d.snapshot, null);
  });
  $('#delDlg').showModal();
};
$('#delClose').onclick = () => $('#delDlg').close();

document.addEventListener('masters-changed', drawRecipeFilter);

// サンプルの保存・削除のあとに一覧を取り直す
document.addEventListener('samples-changed', () => {
  labelsCache = null;
  refresh();
});

export async function initListTab() {
  drawRecipeFilter();
  await refresh();
}
