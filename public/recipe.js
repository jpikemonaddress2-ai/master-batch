// 画面1: 配合
import { calcCharge, archivedAdded, archivedAddedMessage } from './calc.mjs';
import { fmtRaw } from './format.mjs';
import {
  $, esc, fmt, fmtGram, fmtVal, toNum, alertBox, api, toast, state, matById, recipeById, reloadMasters,
  createDirty, showTab, showAlertWithAction, materialOptions, rememberedAuthor, rememberAuthor, archivedInRecipe, stopOnBadNumber, setIfChanged,
} from './common.js';
import { newSampleFor } from './sample.js';

let draft = null;   // 編集中の配合（保存前のコピー）
const dirty = createDirty('#dirtyMark', '保存していない配合の変更があります。破棄してよろしいですか？');

const activeOf = kind => state.materials.filter(m => m.kind === kind && !m.archived);

function blankDraft() {
  return { id: null, code: '', name: '', base_material_id: activeOf('resin')[0]?.id ?? null,
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
      ${r.sample_count ? `<span class="tag count" style="float:right" title="サンプル ${r.sample_count} 件">S ${r.sample_count}</span>` : ''}
      <span class="nm">${esc(r.name)}</span>
      <span class="meta">添加剤 ${r.items.length} 種 / ${Number(r.default_qty_g).toLocaleString()} g</span>
      ${archivedInRecipe(r).length ? `<span class="caution block">⚠ 使用停止の原料を含む（${r.sample_count ? '複製して' : ''}原料を置き換えてください）</span>` : ''}
    </button>`).join('');
  box.querySelectorAll('.list-item').forEach(el => el.onclick = () => {
    const r = state.recipes.find(x => x.id === Number(el.dataset.id));
    if (r.id === draft?.id || !dirty.confirmDiscard()) return;
    openDraft(toDraft(r));
  });
}

/* ===================== 配合の編集 ===================== */
function openDraft(d) {
  draft = d;
  dirty.set(false);
  $('#rSaveAlert').innerHTML = '';
  drawRecipeList();
  drawForm();
}

// サンプルが付いた配合は配合コードと組成を変えられない（サーバー側でも拒否する）。名前・作成量・メモは変えられる
const locked = () => draft.id !== null && draft.sample_count > 0;

function drawForm() {
  const isNew = draft.id === null;
  $('#rCode').value = draft.code;
  $('#rCode').disabled = locked();
  $('#rName').value = draft.name;
  $('#rQty').value = draft.default_qty_g ?? '';
  $('#rMemo').value = draft.memo;
  $('#rLockNote').innerHTML = locked()
    ? `<div class="note" style="margin-top:0; margin-bottom:12px">この配合にはサンプルが ${draft.sample_count} 件あるため、配合コードと組成（ベース樹脂・添加剤・狙い濃度）は変更できません。変える場合は「複製」で新しい配合を作ってください。</div>`
    : '';
  $('#rItemsLock').hidden = !locked();
  $('#rEditorField').hidden = isNew;
  if (!isNew) $('#rEditor').value = rememberedAuthor();
  $('#toSample').disabled = isNew;
  drawBaseSelect();
  drawItems();
  drawRecipeHistory();
}

function drawBaseSelect() {
  const opts = materialOptions('resin', draft.base_material_id);
  $('#rBase').innerHTML = opts || '<option value="">（樹脂を原料マスタに登録してください）</option>';
  // 未選択（新規）のときだけ先頭を当てる。保存済みの配合の原料を黙って置き換えない
  if (draft.base_material_id === null && activeOf('resin').length) {
    draft.base_material_id = Number($('#rBase').value);
  }
  $('#rBase').disabled = locked();
}

function drawItems() {
  const dis = locked() ? 'disabled' : '';
  $('#addItem').disabled = locked();
  $('#rItems').innerHTML = draft.items.length ? draft.items.map((it, i) => `
    <tr>
      <td><select style="width:100%" data-i="${i}" class="itMat" aria-label="添加剤 ${i + 1} の原料" ${dis}>${materialOptions('additive', it.material_id)}</select></td>
      <td class="num" data-active="${i}"></td>
      <td class="num"><input type="number" step="any" min="0" style="width:100%" value="${it.target_active_pct ?? ''}" data-i="${i}" class="itPct" aria-label="添加剤 ${i + 1} の狙い濃度 wt%" ${dis}></td>
      <td class="num" data-g="${i}"></td>
      <td><button class="del" data-i="${i}" aria-label="添加剤 ${i + 1} を削除" ${dis}>削除</button></td>
    </tr>`).join('')
    : `<tr><td colspan="5" class="hint">${locked() ? '添加剤なし' : '添加剤がありません。「＋ 添加剤を追加」で行を足してください。'}</td></tr>`;

  $('#rItems').querySelectorAll('.itPct').forEach(el => el.oninput = () => {
    draft.items[el.dataset.i].target_active_pct = toNum(el.value);
    dirty.set(true); calcRecipe();
  });
  $('#rItems').querySelectorAll('.itMat').forEach(el => el.onchange = () => {
    draft.items[el.dataset.i].material_id = Number(el.value);
    dirty.set(true); calcRecipe();
  });
  $('#rItems').querySelectorAll('.del').forEach(el => el.onclick = () => {
    draft.items.splice(Number(el.dataset.i), 1);
    dirty.set(true); drawItems();
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
    $(`#rItems [data-g="${i}"]`).textContent = fmtGram(row.g);
    $(`#rItems [data-active="${i}"]`).textContent = fmtVal(row.active_pct);
  });
  const activeTotal = draft.items.reduce((s, it) => s + (Number(it.target_active_pct) || 0), 0);
  $('#rSummary').innerHTML = `
    <div><div class="k">ベース樹脂</div><div class="v">${fmtGram(c.baseG)}<small>g</small></div></div>
    <div><div class="k">添加剤 合計</div><div class="v">${fmtGram(c.addTotal)}<small>g</small></div></div>
    <div><div class="k">総量</div><div class="v">${fmtGram(W)}<small>g</small></div></div>
    <div><div class="k">仕込み比率（MB・キャリア込み）</div><div class="v">${fmt(W ? c.addTotal / W * 100 : 0, 2)}<small>wt%</small></div></div>
    <div><div class="k">有効成分 合計</div><div class="v">${fmtRaw(activeTotal) || '0'}<small>wt%</small></div></div>`;
  // 使用停止の原料を新しく組み込もうとしていないか。手元の一覧（state）は古いことがあり、最終判定はサーバー
  const added = archivedAdded(stoppedInDraft(), draft.id !== null ? recipeById(draft.id) ?? null : null);
  setIfChanged($('#rAlert'),
    (added.length ? alertBox(archivedAddedMessage(added), { live: false }) : '') +
    (c.over ? alertBox(`配合過剰: 添加剤の合計 ${fmtGram(c.addTotal)} g が総量 ${fmtGram(W)} g を超えています。狙い濃度か作成量を見直してください。`, { live: false }) : ''));
  // 保存できない理由は、保存ボタンの横にも出す（上の警告は、ボタンまでスクロールすると見えない）
  const why = added.length ? '使用停止の原料を置き換えると保存できます（集計の下を参照）'
    : c.over ? '配合過剰のため保存できません（集計の下を参照）' : '';
  $('#rSaveWhy').textContent = why;
  $('#save').disabled = !!why;
}

// 編集中の組成に含まれる使用停止の原料（ベース樹脂を含む）
function stoppedInDraft() {
  return [draft.base_material_id, ...draft.items.map(it => it.material_id)]
    .map(matById).filter(m => m?.archived).map(m => ({ id: m.id, name: m.name }));
}

$('#rCode').oninput = e => { draft.code = e.target.value; dirty.set(true); };
$('#rName').oninput = e => { draft.name = e.target.value; dirty.set(true); };
$('#rMemo').oninput = e => { draft.memo = e.target.value; dirty.set(true); };
$('#rBase').onchange = e => { draft.base_material_id = Number(e.target.value); dirty.set(true); calcRecipe(); };
$('#rQty').oninput = e => { draft.default_qty_g = toNum(e.target.value); dirty.set(true); calcRecipe(); };

$('#addItem').onclick = () => {
  const adds = activeOf('additive');
  if (!adds.length) {
    toast('先に「原料マスタに登録」で添加剤を登録してください');
    return;
  }
  const used = new Set(draft.items.map(it => it.material_id));
  const next = adds.find(m => !used.has(m.id)) ?? adds[0];
  draft.items.push({ material_id: next.id, target_active_pct: null });
  dirty.set(true);
  drawItems();
  $(`#rItems .itPct[data-i="${draft.items.length - 1}"]`)?.focus();
};

$('#newRecipe').onclick = () => {
  if (!dirty.confirmDiscard()) return;
  openDraft(blankDraft());
  $('#rCode').focus();
};

// 編集中の内容のまま、新しい配合として開き直す（コードは空にする）
function duplicateDraft() {
  const copy = { ...structuredClone(draft), id: null, version: null, sample_count: 0, code: '', name: `${draft.name}（複製）` };
  openDraft(copy);
  dirty.set(true);
  $('#rCode').focus();
}

$('#duplicate').onclick = () => {
  if (!dirty.confirmDiscard()) return;
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
  if (dirty.get()) {
    draft.sample_count = r.sample_count;
    drawForm();
    dirty.set(true);
  } else {
    openDraft(toDraft(r));
  }
});

$('#save').onclick = async () => {
  $('#rSaveAlert').innerHTML = '';
  if (stopOnBadNumber($('#tab-recipe'), $('#rSaveAlert'))) return;
  let changedBy = null;
  if (draft.id !== null) {
    changedBy = $('#rEditor').value.trim();
    if (!changedBy) {
      $('#rSaveAlert').innerHTML = alertBox('保存済みの配合を変更するときは「変更者」に名前を入力してください（変更履歴に残ります）');
      $('#rEditor').focus();
      return;
    }
    rememberAuthor(changedBy);
  }
  const btn = $('#save');
  btn.disabled = true;
  try {
    const body = { ...draft, changed_by: changedBy };
    const saved = draft.id === null
      ? await api('POST', '/api/recipes', body)
      : await api('PUT', `/api/recipes/${draft.id}`, body);
    openDraft(toDraft(saved));
    toast('保存しました');
    await reloadMasters().catch(e => toast(`保存しました（一覧の更新に失敗: ${e.message}）`));
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
  if (draft.id === null || dirty.get()) {
    toast('先に配合を保存してください');
    return;
  }
  if (newSampleFor(draft.id)) showTab('sample');
};

/* ---------- 配合の変更履歴 ---------- */
function recipeFields(r) {
  return [
    ['配合コード', r.code],
    ['配合名', r.name],
    ['ベース樹脂', matById(r.base_material_id)?.name ?? `#${r.base_material_id}`],
    ['作成量 (g)', fmtRaw(r.default_qty_g)],
    ['添加剤（狙い濃度 wt%）', r.items.map(i => `${i.material_name ?? matById(i.material_id)?.name}: ${fmtRaw(i.target_active_pct)}`).join(' / ')],
    ['メモ', r.memo ?? ''],
  ];
}

async function drawRecipeHistory() {
  const box = $('#rHistory');
  box.innerHTML = '';
  if (draft.id === null) return;
  const id = draft.id;
  let hist;
  try {
    hist = await api('GET', `/api/recipes/${id}/history`);
  } catch {
    return;
  }
  if (draft.id !== id || !hist.length) return;
  box.innerHTML = `<div class="sub-h history">変更履歴（${hist.length} 件）</div><ul class="history" style="margin:0; padding-left:18px">${
    hist.map((h, i) => `<li>${esc(h.changed_at)} ${esc(h.changed_by)} が変更
      <button type="button" class="link" data-h="${i}">この変更の内容</button></li>`).join('')}</ul>`;
  box.querySelectorAll('button[data-h]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.h);
    // 変更後 = 一つ新しい履歴の変更前。最新の変更だけは現在の内容
    const after = i === 0 ? recipeById(id) : hist[i - 1].snapshot;
    const before = recipeFields(hist[i].snapshot);
    const now = recipeFields(after);
    const rows = before.map(([label, v], k) => [label, v, now[k][1]]).filter(([, a, b2]) => a !== b2);
    $('#histTitle').textContent = `${hist[i].changed_at} ${hist[i].changed_by} による変更`;
    $('#histRows').innerHTML = rows.length
      ? '<tr><th scope="col">項目</th><th scope="col">変更前</th><th scope="col">変更後</th></tr>' + rows.map(([l, a, b2]) =>
        `<tr class="diff"><td>${esc(l)}</td><td>${esc(a) || '—'}</td><td>${esc(b2) || '—'}</td></tr>`).join('')
      : '<tr><td class="empty">内容の変更はありません（保存のみ）。</td></tr>';
    $('#histDlg').showModal();
  });
}

/* ===================== 原料マスタ ===================== */
let editingMat = null;   // 編集中の原料（新規なら null）

function openMaterialDialog(m = null) {
  editingMat = m;
  $('#matForm').reset();
  $('#mAlert').innerHTML = '';
  $('#mTitle').textContent = m ? `原料を編集: ${m.name}` : '原料マスタに登録';
  $('#mSave').textContent = m ? '保存' : '登録';
  $('#mArchivedField').hidden = !m;
  const usedLock = !!m && m.used_count > 0;
  if (m) {
    $('#mName').value = m.name;
    $('#mKind').value = m.kind;
    $('#mActive').value = fmtRaw(m.active_pct);
    $('#mSupplier').value = m.supplier ?? '';
    $('#mMemo').value = m.memo ?? '';
    $('#mCaution').value = m.caution ?? '';
    $('#mGrade').value = m.grade ?? '';
    $('#mCas').value = m.cas_no ?? '';
    $('#mArchived').checked = !!m.archived;
  }
  for (const id of ['#mName', '#mKind', '#mActive']) $(id).disabled = usedLock;
  // グレード・CAS 番号は、使われている原料でも空欄なら後から入れられる（入っていれば変えられない）
  $('#mGrade').disabled = usedLock && !!m.grade;
  $('#mCas').disabled = usedLock && !!m.cas_no;
  $('#mUsedNote').hidden = !usedLock;
  $('#matDlg').showModal();
  (usedLock ? $('#mSupplier') : $('#mName')).focus();
}

$('#addMat').onclick = () => openMaterialDialog();
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
  if (!$('#mActive').disabled && $('#mKind').value === 'additive' && Number($('#mActive').value) === 100 &&
      !confirm('有効成分 100%（純品）で登録してよろしいですか？\n\n既製マスターバッチ（例: 有効成分 50%）の場合は［キャンセル］を押して、有効成分 % を直してください。')) {
    $('#mActive').focus();
    return;
  }
  const body = {
    name: $('#mName').value, kind: $('#mKind').value, active_pct: $('#mActive').value,
    supplier: $('#mSupplier').value, memo: $('#mMemo').value, caution: $('#mCaution').value,
    grade: $('#mGrade').value, cas_no: $('#mCas').value,
    archived: $('#mArchived').checked,
  };
  try {
    const m = editingMat
      ? await api('PUT', `/api/materials/${editingMat.id}`, body)
      : await api('POST', '/api/materials', body);
    await reloadMasters();
    // 編集中の配合は保ったまま、選択肢だけ更新する
    drawBaseSelect();
    drawItems();
    drawMaterialList();
    $('#matDlg').close();
    toast(editingMat ? `原料「${m.name}」を保存しました` : `原料「${m.name}」を登録しました`);
  } catch (err) {
    $('#mAlert').innerHTML = alertBox(err.message);
  }
};

function drawMaterialList() {
  const kinds = { resin: '樹脂', additive: '添加剤' };
  $('#matRows').innerHTML = state.materials.length ? state.materials.map(m => `
    <tr class="${m.archived ? 'archived' : ''}">
      <td>${esc(m.name)}${m.archived ? ' <span class="tag">使用停止</span>' : ''}</td>
      <td>${kinds[m.kind]}</td>
      <td class="num">${fmtVal(m.active_pct)}</td>
      <td>${esc(m.grade ?? '')}</td>
      <td>${esc(m.cas_no ?? '')}</td>
      <td>${esc(m.supplier ?? '')}</td>
      <td>${m.caution ? `<span class="caution">⚠ ${esc(m.caution)}</span>` : ''}</td>
      <td class="num">${m.used_count}</td>
      <td><button type="button" class="link" data-mid="${m.id}" aria-label="${esc(m.name)} を編集">編集</button></td>
    </tr>`).join('')
    : '<tr><td colspan="9" class="empty">原料はまだありません。</td></tr>';
  $('#matRows').querySelectorAll('button[data-mid]').forEach(b => b.onclick = () =>
    openMaterialDialog(matById(Number(b.dataset.mid))));
}

$('#openMatList').onclick = () => {
  drawMaterialList();
  $('#matListDlg').showModal();
};
$('#matListClose').onclick = () => $('#matListDlg').close();
$('#matListAdd').onclick = () => openMaterialDialog();

export function initRecipeTab() {
  openDraft(state.recipes[0] ? toDraft(state.recipes[0]) : blankDraft());
}
