// 画面1: 配合
import { calcCharge } from './calc.mjs';
import {
  $, esc, fmt, toNum, alertBox, api, toast, state, matById, recipeById, reloadMasters, registerDirty, showTab,
  showAlertWithAction,
} from './common.js';
import { newSampleFor } from './sample.js';

let draft = null;   // 編集中の配合（保存前のコピー）
let dirty = false;

const resins = () => state.materials.filter(m => m.kind === 'resin' && !m.archived);
const additives = () => state.materials.filter(m => m.kind === 'additive' && !m.archived);

registerDirty(() => dirty);

function setDirty(v) {
  dirty = v;
  $('#dirtyMark').hidden = !v;
}

function confirmDiscard() {
  return !dirty || confirm('保存していない配合の変更があります。破棄してよろしいですか？');
}

function blankDraft() {
  return { id: null, code: '', name: '', base_material_id: resins()[0]?.id ?? null,
    default_qty_g: 1000, memo: '', items: [], version: null, sample_count: 0 };
}

function toDraft(r) {
  return {
    id: r.id, code: r.code, name: r.name, base_material_id: r.base_material_id,
    default_qty_g: r.default_qty_g, memo: r.memo ?? '', version: r.version, sample_count: r.sample_count,
    items: r.items.map(i => ({ material_id: i.material_id, target_active_pct: i.target_active_pct })),
  };
}

/* ===================== 配合一覧 ===================== */
function drawRecipeList() {
  const box = $('#recipeList');
  if (!state.recipes.length) {
    box.innerHTML = '<div class="hint" style="padding:12px 14px">配合はまだありません。下の「新規配合」から登録してください。</div>';
    return;
  }
  box.innerHTML = state.recipes.map(r => `
    <button type="button" class="list-item ${r.id === draft?.id ? 'on' : ''}" data-id="${r.id}" ${r.id === draft?.id ? 'aria-current="true"' : ''}>
      <span class="code">${esc(r.code)}</span>
      <span class="nm">${esc(r.name)}</span>
      <span class="meta">添加剤 ${r.items.length} 種 / 基準 ${Number(r.default_qty_g).toLocaleString()} g / サンプル ${r.sample_count} 件</span>
    </button>`).join('');
  box.querySelectorAll('.list-item').forEach(el => el.onclick = () => {
    const r = state.recipes.find(x => x.id === Number(el.dataset.id));
    if (r.id === draft?.id || !confirmDiscard()) return;
    openDraft(toDraft(r));
  });
}

/* ===================== 配合の編集 ===================== */
function openDraft(d) {
  draft = d;
  setDirty(false);
  $('#rSaveAlert').innerHTML = '';
  drawRecipeList();
  drawForm();
}

// サンプルが付いた配合は組成を変えられない（サーバー側でも拒否する）。名前・コード・作成量・メモは変えられる
const locked = () => draft.id !== null && draft.sample_count > 0;

function drawForm() {
  $('#rCode').value = draft.code;
  $('#rName').value = draft.name;
  $('#rQty').value = draft.default_qty_g ?? '';
  $('#rMemo').value = draft.memo;
  $('#rLockNote').innerHTML = locked()
    ? `<div class="note" style="margin-top:0; margin-bottom:12px">この配合にはサンプルが ${draft.sample_count} 件あるため、組成（ベース樹脂・添加剤・狙い濃度）は変更できません。組成を変える場合は「複製」で新しい配合を作ってください。</div>`
    : '';
  drawBaseSelect();
  drawItems();
}

function drawBaseSelect() {
  const list = resins();
  $('#rBase').innerHTML = list.length
    ? list.map(m => `<option value="${m.id}" ${m.id === draft.base_material_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')
    : '<option value="">（樹脂を原料マスタに登録してください）</option>';
  if (list.length && !list.some(m => m.id === draft.base_material_id)) draft.base_material_id = list[0].id;
  $('#rBase').disabled = locked();
}

function drawItems() {
  const adds = additives();
  const opts = sel => adds.map(m =>
    `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const dis = locked() ? 'disabled' : '';
  $('#addItem').disabled = locked();
  $('#rItems').innerHTML = draft.items.length ? draft.items.map((it, i) => `
    <tr>
      <td><select style="width:100%" data-i="${i}" class="itMat" aria-label="添加剤 ${i + 1} の原料" ${dis}>${opts(it.material_id)}</select></td>
      <td class="num" data-active="${i}"></td>
      <td class="num"><input type="number" step="any" min="0" style="width:100%" value="${it.target_active_pct ?? ''}" data-i="${i}" class="itPct" aria-label="添加剤 ${i + 1} の狙い濃度 wt%" ${dis}></td>
      <td class="num" data-g="${i}"></td>
      <td><button class="del" data-i="${i}" aria-label="添加剤 ${i + 1} を削除" ${dis}>削除</button></td>
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

// 編集中の内容のまま、新しい配合として開き直す（コードは空にする）
function duplicateDraft() {
  const copy = { ...structuredClone(draft), id: null, version: null, sample_count: 0, code: '', name: `${draft.name}（複製）` };
  openDraft(copy);
  setDirty(true);
  $('#rCode').focus();
}

$('#duplicate').onclick = () => {
  if (!confirmDiscard()) return;
  duplicateDraft();
};

// 他の人が先に保存したとき: 自分の変更を捨てて最新を読み直す
async function reloadCurrent() {
  const id = draft.id;
  try {
    await reloadMasters();
  } catch (e) {
    toast(`読み直せませんでした: ${e.message}`);
    return;
  }
  const r = recipeById(id);
  if (!r) {
    toast('この配合は見つかりませんでした');
    return;
  }
  openDraft(toDraft(r));
  toast('最新の内容を読み直しました');
}

// サンプルの保存・削除などで配合（サンプル件数）が変わったら、一覧とロック表示を取り直す。
// 編集中の入力は残し、サンプル件数（＝ロックの有無）だけを反映する
document.addEventListener('masters-changed', () => {
  if (!draft) return;
  drawRecipeList();
  const r = draft.id !== null ? recipeById(draft.id) : null;
  if (!r || r.sample_count === draft.sample_count) return;
  if (dirty) {
    draft.sample_count = r.sample_count;
    drawForm();
    setDirty(true);
  } else {
    openDraft(toDraft(r));
  }
});

$('#save').onclick = async () => {
  const btn = $('#save');
  btn.disabled = true;
  $('#rSaveAlert').innerHTML = '';
  try {
    const saved = draft.id === null
      ? await api('POST', '/api/recipes', draft)
      : await api('PUT', `/api/recipes/${draft.id}`, draft);
    await reloadMasters();
    openDraft(toDraft(saved));
    toast('保存しました');
  } catch (e) {
    if (e.code === 'stale') {
      showAlertWithAction($('#rSaveAlert'), e.message, '最新を読み直す（自分の変更は破棄）', reloadCurrent);
    } else if (e.code === 'locked') {
      // 開いている間に他の人がこの配合でサンプルを作った: 件数を取り直してロック表示にし、複製へ誘導する
      await reloadMasters().catch(() => {});
      showAlertWithAction($('#rSaveAlert'), e.message, 'この内容で複製する', duplicateDraft);
    } else {
      $('#rSaveAlert').innerHTML = alertBox(e.message);
    }
  } finally {
    btn.disabled = false;
    calcRecipe();
  }
};

$('#toSample').onclick = () => {
  if (draft.id === null || dirty) {
    toast('先に配合を保存してください');
    return;
  }
  if (newSampleFor(draft.id)) showTab('sample');
};

/* ===================== 原料マスタ登録 ===================== */
$('#addMat').onclick = () => {
  $('#matForm').reset();
  $('#mAlert').innerHTML = '';
  $('#matDlg').showModal();
  $('#mName').focus();
};

$('#mCancel').onclick = () => $('#matDlg').close();

// 樹脂はほぼ常に 100%。添加剤は既製MBの取り違えを防ぐため空欄から入力してもらう
$('#mKind').onchange = () => {
  const el = $('#mActive');
  if ($('#mKind').value === 'resin' && el.value === '') el.value = '100';
  else if ($('#mKind').value === 'additive' && el.value === '100') el.value = '';
};

$('#matForm').onsubmit = async e => {
  e.preventDefault();
  // 既製MBを純品のまま登録すると仕込み量が狂う（このアプリが防ぎたい事故）ので、添加剤の 100% は確かめる
  if ($('#mKind').value === 'additive' && Number($('#mActive').value) === 100 &&
      !confirm('有効成分 100%（純品）で登録してよろしいですか？\n\n既製マスターバッチ（例: 有効成分 50%）の場合は［キャンセル］を押して、有効成分 % を直してください。')) {
    $('#mActive').focus();
    return;
  }
  try {
    const m = await api('POST', '/api/materials', {
      name: $('#mName').value, kind: $('#mKind').value, active_pct: $('#mActive').value,
      supplier: $('#mSupplier').value, memo: $('#mMemo').value,
    });
    state.materials = await api('GET', '/api/materials');
    // 編集中の内容は保ったまま、選択肢だけ更新する
    drawBaseSelect();
    drawItems();
    $('#matDlg').close();
    toast(`原料「${m.name}」を登録しました`);
  } catch (err) {
    $('#mAlert').innerHTML = alertBox(err.message);
  }
};

export function initRecipeTab() {
  openDraft(state.recipes[0] ? toDraft(state.recipes[0]) : blankDraft());
}
