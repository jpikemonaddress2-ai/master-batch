// 画面2: サンプル記録
import { targetWeighings, calcActual } from './calc.mjs';
import { COND_FIELDS, JUDGEMENTS } from './fields.mjs';
import { buildMatrix } from './matrix.mjs';
import {
  $, esc, fmt, toNum, alertBox, api, toast, state, matById, recipeById, reloadMasters,
  registerDirty, rememberedAuthor, rememberAuthor, today, showAlertWithAction,
} from './common.js';

let samples = [];      // 左の一覧
let extraLabels = [];  // 自由項目で過去に使った項目名
let draft = null;      // 編集中のサンプル
let dirty = false;

const zones = () => state.config.barrelZones;
const rowKey = r => `${r.row_type}:${r.material_id}`;

registerDirty(() => dirty);

function setDirty(v) {
  dirty = v;
  $('#sDirtyMark').hidden = !v;
}

function confirmDiscard() {
  return !dirty || confirm('保存していないサンプルの変更があります。破棄してよろしいですか？');
}

/* ===================== 下書きの作成 ===================== */

// 狙い量の計算元。新規は配合の現在の内容、既存は保存済みスナップショット
function basisFromRecipe(r) {
  return r ? {
    base_material_id: r.base_material_id,
    items: r.items.map(i => ({
      material_id: i.material_id, target_active_pct: i.target_active_pct,
      active_pct: i.active_pct, name: i.material_name,
    })),
  } : null;
}

// 直近に登録したサンプル番号の末尾の数字を 1 つ進める（例: S-2026-012 → S-2026-013）
function suggestCode() {
  const last = samples.reduce((a, s) => (!a || s.id > a.id ? s : a), null);
  const m = last?.code.match(/^(.*?)(\d+)$/);
  if (!m) return '';
  const used = new Set(samples.map(s => s.code));
  let n = Number(m[2]);
  let code;
  do { code = m[1] + String(++n).padStart(m[2].length, '0'); } while (used.has(code));
  return code;
}

function blankDraft(recipe) {
  return {
    id: null, version: null,
    recipe_id: recipe?.id ?? null, recipe_version: recipe?.version ?? null,
    code: suggestCode(), made_on: today(), total_qty_g: recipe?.default_qty_g ?? 1000,
    created_by: rememberedAuthor(),
    barrel_temps: Array(zones()).fill(null), die_temp_c: null,
    ...Object.fromEntries(COND_FIELDS.map(f => [f.key, null])),
    judgement: null, appearance_note: '', memo: '',
    extras: [], actuals: {}, lots: {}, basis: basisFromRecipe(recipe),
    source_id: null, source_code: null,   // 引用元のサンプル（画面表示用）
  };
}

function fromSample(s) {
  const base = s.weighings.find(w => w.row_type === 'base');
  return {
    id: s.id, version: s.version, recipe_id: s.recipe_id, recipe_version: null,
    code: s.code, made_on: s.made_on ?? '', total_qty_g: s.total_qty_g, created_by: s.created_by ?? '',
    barrel_temps: Array.from({ length: zones() }, (_, i) => s.barrel_temps[i] ?? null),
    die_temp_c: s.die_temp_c,
    ...Object.fromEntries(COND_FIELDS.map(f => [f.key, s[f.key]])),
    judgement: s.judgement, appearance_note: s.appearance_note ?? '', memo: s.memo ?? '',
    extras: s.extras.map(e => ({ ...e })),
    actuals: Object.fromEntries(s.weighings.map(w => [rowKey(w), w.actual_g])),
    lots: Object.fromEntries(s.weighings.map(w => [rowKey(w), w.lot ?? ''])),
    created_at: s.created_at, updated_at: s.updated_at,
    basis: {
      base_material_id: base.material_id,
      items: s.weighings.filter(w => w.row_type === 'additive').map(w => ({
        material_id: w.material_id, target_active_pct: w.target_active_pct,
        active_pct: w.active_pct_snapshot, name: w.material_name,
      })),
    },
  };
}

/* ===================== 一覧 ===================== */
async function reloadSamples() {
  [samples, extraLabels] = await Promise.all([api('GET', '/api/samples'), api('GET', '/api/extra-labels')]);
  drawSampleList();
  drawLabelLists();
  document.dispatchEvent(new Event('samples-changed'));
}

function drawSampleList() {
  const box = $('#sampleList');
  if (!samples.length) {
    box.innerHTML = '<div class="hint" style="padding:12px 14px">サンプルはまだありません。</div>';
    return;
  }
  box.innerHTML = samples.slice(0, 50).map(s => `
    <button type="button" class="list-item ${s.id === draft?.id ? 'on' : ''}" data-id="${s.id}" ${s.id === draft?.id ? 'aria-current="true"' : ''}>
      <span class="code">${esc(s.code)}</span>
      ${s.judgement ? `<span class="tag ${s.judgement}" style="float:right">${JUDGEMENTS[s.judgement]}</span>` : ''}
      <span class="nm">${esc(s.recipe_code)} ${esc(s.recipe_name)}</span>
      <span class="meta">${esc(s.made_on ?? '')}${s.created_by ? ` / ${esc(s.created_by)}` : ''}</span>
    </button>`).join('');
  box.querySelectorAll('.list-item').forEach(el => el.onclick = () => openSample(Number(el.dataset.id)));
}

/**
 * 保存済みサンプルを開く。破棄を断られた・読めなかったら false。
 * force: 開いている同じサンプルも、未保存の変更を確かめずに読み直す（他の人が先に保存したとき）
 */
export async function openSample(id, { force = false } = {}) {
  if (!force && id === draft?.id) return true;
  if (!force && !confirmDiscard()) return false;
  try {
    openDraft(fromSample(await api('GET', `/api/samples/${id}`)));
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

function drawLabelLists() {
  for (const cat of ['condition', 'measurement']) {
    $(`#dl-${cat}`).innerHTML = extraLabels.filter(l => l.category === cat)
      .map(l => `<option value="${esc(l.label)}">`).join('');
  }
}

/* ===================== 編集フォーム ===================== */
function openDraft(d) {
  draft = d;
  setDirty(false);
  $('#sAlert').innerHTML = '';
  drawSampleList();
  drawForm();
}

function drawRecipeSelect() {
  const sel = $('#sRecipe');
  sel.innerHTML = state.recipes.length
    ? state.recipes.map(r => `<option value="${r.id}" ${r.id === draft.recipe_id ? 'selected' : ''}>${esc(r.code)} — ${esc(r.name)}</option>`).join('')
    : '<option value="">（先に「配合」タブで配合を登録してください）</option>';
  // 既存サンプルの配合は変えられない（秤量のスナップショットが配合に紐づくため）
  sel.disabled = draft.id !== null || !state.recipes.length;
  if (draft.id !== null && !recipeById(draft.recipe_id)) sel.innerHTML = '<option>（不明な配合）</option>';
}

function drawForm() {
  drawRecipeSelect();
  $('#sCode').value = draft.code;
  $('#sDate').value = draft.made_on;
  $('#sQty').value = draft.total_qty_g ?? '';
  $('#sBy').value = draft.created_by;
  document.querySelectorAll('#sZones input[data-z]').forEach(el => { el.value = draft.barrel_temps[el.dataset.z] ?? ''; });
  $('#s_die_temp_c').value = draft.die_temp_c ?? '';
  for (const f of COND_FIELDS) $(`#s_${f.key}`).value = draft[f.key] ?? '';
  document.querySelectorAll('input[name="sJudge"]').forEach(el => { el.checked = el.value === (draft.judgement ?? ''); });
  $('#sNote').value = draft.appearance_note;
  $('#sMemo').value = draft.memo;
  const isNew = draft.id === null;
  $('#sDelete').hidden = isNew;
  $('#sCopy').hidden = isNew;
  // 記入者は作成時に確定する。既存サンプルを直す人は「変更者」として毎回名前を残す
  $('#sBy').disabled = !isNew;
  $('#sEditorField').hidden = isNew;
  if (!isNew) $('#sEditor').value = rememberedAuthor();
  $('#sSourceField').hidden = !isNew;
  drawSourceSelect();
  $('#sMeta').textContent = isNew
    ? (draft.source_code ? `新規サンプル（${draft.source_code} から引用。実秤量・ロット・評価・測定値の値は空です）` : '新規サンプル')
    : `作成 ${draft.created_at}（${draft.created_by || '記入者なし'}）／ 最終更新 ${draft.updated_at}`;
  drawWeigh();
  drawExtras('condition');
  drawExtras('measurement');
  drawHistory();
}

/* ---------- 変更履歴 ---------- */
async function drawHistory() {
  const box = $('#sHistory');
  box.innerHTML = '';
  if (draft.id === null) return;
  const id = draft.id;
  let hist;
  try {
    hist = await api('GET', `/api/samples/${id}/history`);
  } catch {
    return;
  }
  if (draft.id !== id || !hist.length) return;
  // hist は新しい順。i 番目の変更は「hist[i].snapshot（変更前）→ 一つ新しい版（変更後）」で、
  // 一つ新しい版は hist[i-1].snapshot、最新の変更だけは現在の内容になる
  box.innerHTML = `<div class="sub-h history">変更履歴（${hist.length} 件）</div><ul class="history" style="margin:0; padding-left:18px">${
    hist.map((h, i) => `<li>${esc(h.changed_at)} ${esc(h.changed_by)} が${h.op === 'delete' ? '削除' : '変更'}
      <button type="button" class="link" data-h="${i}">この変更の内容</button></li>`).join('')}</ul>`;
  box.querySelectorAll('button[data-h]').forEach(b => b.onclick = async () => {
    const i = Number(b.dataset.h);
    try {
      const after = i === 0 ? await api('GET', `/api/samples/${id}`) : hist[i - 1].snapshot;
      showHistoryDiff(hist[i], after);
    } catch (e) {
      toast(e.message);
    }
  });
}

function showHistoryDiff(h, after) {
  // 監査用なので、比較表では差分にしないサンプル番号・作成日・記入者の書き換えも出す
  const rows = buildMatrix([h.snapshot, after], zones(), { allDiff: true }).filter(r => r.diff);
  $('#histTitle').textContent = `${h.changed_at} ${h.changed_by} による変更`;
  $('#histRows').innerHTML = rows.length
    ? '<tr><th scope="col">項目</th><th scope="col">変更前</th><th scope="col">変更後</th></tr>' + rows.map(r => `<tr class="diff">
        <td>${esc(r.label)}${r.unit ? ` (${esc(r.unit)})` : ''}</td>${r.cells.map(v => `<td>${v === '' ? '—' : esc(v)}</td>`).join('')}</tr>`).join('')
    : '<tr><td class="empty">内容の変更はありません（保存のみ）。</td></tr>';
  $('#histDlg').showModal();
}
$('#histClose').onclick = () => $('#histDlg').close();

/* ---------- 秤量 ---------- */
function currentRows() {
  const b = draft.basis;
  const tw = targetWeighings(draft.total_qty_g || 0, b.base_material_id, b.items);
  return { over: tw.over, rows: tw.rows.map(r => ({ ...r, actual_g: draft.actuals[rowKey(r)] ?? null })) };
}

function drawWeigh() {
  if (!draft.basis) {
    $('#sWeigh').innerHTML = '<tr><td colspan="8" class="hint">配合を選ぶと狙い量が並びます。</td></tr>';
    $('#sSummary').innerHTML = '';
    $('#sSave').disabled = $('#sSaveNext').disabled = true;
    return;
  }
  const { rows } = currentRows();
  $('#sWeigh').innerHTML = rows.map((r, i) => {
    const name = r.row_type === 'base' ? (matById(r.material_id)?.name ?? '（不明な原料）') : draft.basis.items[i].name;
    const key = rowKey(r);
    const lot = `<input style="width:100%" data-lot="${key}" value="${esc(draft.lots[key] ?? '')}" aria-label="${esc(name)} のロット">`;
    const actual = `<input type="number" step="any" min="0" style="width:100%" data-key="${key}" value="${r.actual_g ?? ''}" aria-label="${esc(name)} の実秤量 g">`;
    if (r.row_type === 'base') {
      return `<tr>
        <td>${esc(name)} <span style="color:var(--sub);font-size:11px">（ベース樹脂・差引）</span></td>
        <td class="num">—</td><td class="num">—</td>
        <td class="num" data-target="${i}"></td><td>${lot}</td><td class="num">${actual}</td>
        <td class="num">—</td><td class="num">—</td></tr>`;
    }
    return `<tr>
      <td>${esc(name)}</td>
      <td class="num">${fmt(r.target_active_pct, 2)}</td><td class="num">${fmt(r.active_pct_snapshot, 0)}</td>
      <td class="num" data-target="${i}"></td><td>${lot}</td><td class="num">${actual}</td>
      <td class="num"><b data-real="${i}"></b></td><td class="num delta" data-delta="${i}"></td></tr>`;
  }).join('');
  $('#sWeigh').querySelectorAll('input[data-key]').forEach(el => el.oninput = () => {
    draft.actuals[el.dataset.key] = toNum(el.value);
    setDirty(true); calcSample();
  });
  $('#sWeigh').querySelectorAll('input[data-lot]').forEach(el => el.oninput = () => {
    draft.lots[el.dataset.lot] = el.value;
    setDirty(true);
  });
  calcSample();
}

function calcSample() {
  if (!draft.basis) return;
  const { rows, over } = currentRows();
  const a = calcActual(rows);
  a.rows.forEach((r, i) => {
    $(`#sWeigh [data-target="${i}"]`).textContent = fmt(r.target_g, 1);
    if (r.row_type !== 'additive') return;
    $(`#sWeigh [data-real="${i}"]`).textContent = fmt(r.real_pct, 3);
    const cell = $(`#sWeigh [data-delta="${i}"]`);
    const d = r.delta;
    cell.className = `num delta ${Number.isNaN(d) ? '' : Math.abs(d) < 0.0005 ? 'zero' : d > 0 ? 'plus' : 'minus'}`;
    cell.textContent = Number.isNaN(d) ? '—' : `${d > 0 ? '+' : ''}${fmt(d, 3)} pt`;
  });
  const qty = draft.total_qty_g || 0;
  const entered = rows.some(r => Number.isFinite(r.actual_g));
  const diff = a.total - qty;
  $('#sSummary').innerHTML = `
    <div><div class="k">狙い総量</div><div class="v">${fmt(qty, 1)}<small>g</small></div></div>
    <div><div class="k">実測総量${entered ? '' : '（未入力）'}</div><div class="v">${entered ? fmt(a.total, 1) : '—'}<small>g</small></div></div>
    <div><div class="k">総量差（実測−狙い）</div><div class="v">${entered ? `${diff >= 0 ? '+' : ''}${fmt(diff, 1)}` : '—'}<small>g</small></div></div>`;
  $('#sWeighAlert').innerHTML = over ? alertBox('配合過剰: 添加剤の合計が作成量を超えています。作成量を見直してください。') : '';
  $('#sSave').disabled = $('#sSaveNext').disabled = over;
}

/* ---------- 自由項目 ---------- */
function drawExtras(cat) {
  const tbody = $(`#sExtras-${cat}`);
  const idx = draft.extras.map((e, i) => (e.category === cat ? i : -1)).filter(i => i >= 0);
  tbody.innerHTML = idx.length ? idx.map(i => {
    const e = draft.extras[i];
    return `<tr>
      <td><input style="width:100%" data-i="${i}" data-f="label" list="dl-${cat}" value="${esc(e.label)}"></td>
      <td><input style="width:100%" data-i="${i}" data-f="value" value="${esc(e.value)}"></td>
      <td><input style="width:100%" data-i="${i}" data-f="unit" value="${esc(e.unit)}"></td>
      <td><button class="del" data-i="${i}">削除</button></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="hint">項目はありません。</td></tr>';

  tbody.querySelectorAll('input[data-f]').forEach(el => el.oninput = () => {
    draft.extras[el.dataset.i][el.dataset.f] = el.value;
    setDirty(true);
  });
  // 既知の項目名を選んだら、単位が空なら過去の単位を入れる
  tbody.querySelectorAll('input[data-f="label"]').forEach(el => el.onchange = () => {
    const e = draft.extras[el.dataset.i];
    const known = extraLabels.find(l => l.category === cat && l.label === e.label.trim());
    if (known?.unit && !e.unit) {
      e.unit = known.unit;
      tbody.querySelector(`input[data-i="${el.dataset.i}"][data-f="unit"]`).value = known.unit;
    }
  });
  tbody.querySelectorAll('button.del').forEach(el => el.onclick = () => {
    draft.extras.splice(Number(el.dataset.i), 1);
    setDirty(true);
    drawExtras('condition');
    drawExtras('measurement');
  });
}

function addExtra(cat) {
  draft.extras.push({ category: cat, label: '', value: '', unit: '' });
  setDirty(true);
  drawExtras(cat);
  const inputs = $(`#sExtras-${cat}`).querySelectorAll('input[data-f="label"]');
  inputs[inputs.length - 1]?.focus();
}

/* ---------- 保存・削除 ---------- */
async function save(changedBy) {
  const { rows } = currentRows();
  const body = {
    ...draft,
    basis: undefined, lots: undefined,
    changed_by: changedBy,
    // 値の無い行は保存しない（引用で項目名だけ並べた測定値を、測らなかった場合など）
    extras: draft.extras.filter(e => e.value.trim()),
    actuals: rows.map(r => ({
      material_id: r.material_id, row_type: r.row_type, actual_g: r.actual_g, lot: draft.lots[rowKey(r)] ?? '',
    })),
  };
  const saved = draft.id === null
    ? await api('POST', '/api/samples', body)
    : await api('PUT', `/api/samples/${draft.id}`, body);
  if (draft.id === null) rememberAuthor(saved.created_by ?? '');
  await reloadAfterChange();
  return saved;
}

// サンプルの件数が変わると配合タブの組成ロックも変わるので、配合も取り直す
async function reloadAfterChange() {
  await Promise.all([reloadSamples(), reloadMasters()]);
}

// 保存が競合したときの回復。入力中の内容をできるだけ残す
async function recoverFromConflict(e) {
  if (e.code === 'recipe_changed') {
    // 他の人が配合を変えた: 最新の配合で狙い量を取り直す（実秤量・ロットは残す）。
    // reloadMasters が masters-changed を発火し、新規の下書きの狙い量を作り直す
    try {
      await reloadMasters();
      $('#sAlert').innerHTML = alertBox(e.message);
    } catch (err) {
      $('#sAlert').innerHTML = alertBox(`${e.message}（配合の読み直しに失敗しました: ${err.message}）`);
    }
  } else if (e.code === 'stale') {
    showAlertWithAction($('#sAlert'), e.message, '最新を読み直す（自分の変更は破棄）',
      () => openSample(draft.id, { force: true }));
  } else {
    $('#sAlert').innerHTML = alertBox(e.message);
  }
}

// 既存サンプルを直す・消す人の名前。画面の「変更者」欄から取り、空なら止める
function editorName() {
  const name = $('#sEditor').value.trim();
  if (!name) {
    $('#sAlert').innerHTML = alertBox('既存のサンプルを変更・削除するときは「変更者」に名前を入力してください（変更履歴に残ります）');
    $('#sEditor').focus();
    return null;
  }
  rememberAuthor(name);
  return name;
}

async function runSave(next) {
  $('#sAlert').innerHTML = '';
  let changedBy = null;
  if (draft.id !== null) {
    changedBy = editorName();
    if (!changedBy) return;
  }
  $('#sSave').disabled = $('#sSaveNext').disabled = true;
  try {
    const saved = await save(changedBy);
    if (next) {
      // 同じ配合で条件を振る実験が多いので、今保存したサンプルを引用して次を作る
      openDraft(draftFromSource(saved, { continued: true }));
      toast(`「${saved.code}」を保存しました。続けて次のサンプルを入力できます`);
      $('#sCode').focus();
    } else {
      openDraft(fromSample(saved));
      toast('保存しました');
    }
  } catch (e) {
    await recoverFromConflict(e);
  } finally {
    calcSample();
  }
}

$('#sSave').onclick = () => runSave(false);
$('#sSaveNext').onclick = () => runSave(true);

$('#sDelete').onclick = async () => {
  $('#sAlert').innerHTML = '';
  const changedBy = editorName();
  if (!changedBy) return;
  if (!confirm(`サンプル「${draft.code}」を削除します（変更者: ${changedBy}）。\n一覧からは消えます。削除前の内容はサーバーの変更履歴に残ります。よろしいですか？`)) return;
  try {
    const recipe = recipeById(draft.recipe_id);
    await api('DELETE', `/api/samples/${draft.id}`, { changed_by: changedBy });
    await reloadAfterChange();
    openDraft(blankDraft(recipe ?? state.recipes[0]));
    toast('削除しました');
  } catch (e) {
    $('#sAlert').innerHTML = alertBox(e.message);
  }
};

/* ---------- 前のサンプルを引用して新規作成 ---------- */

/**
 * 保存済みサンプルを元に新規の下書きを作る。
 * 引き継ぐ: 配合・作成量・造粒条件（バレル・ダイ・運転・自由項目）・測定値の項目名と単位
 * 引き継がない: サンプル番号（次の番号を提案）・作成日（今日）・実秤量・ロット・評価・所見・メモ・測定値の値
 * continued: 「保存して続けて新規」のとき。作成日と記入者も引き継ぐ
 */
function draftFromSource(s, { continued = false } = {}) {
  const src = fromSample(s);
  const d = blankDraft(recipeById(s.recipe_id));
  Object.assign(d, {
    total_qty_g: src.total_qty_g,
    barrel_temps: src.barrel_temps, die_temp_c: src.die_temp_c,
    ...Object.fromEntries(COND_FIELDS.map(f => [f.key, src[f.key]])),
    extras: [
      ...src.extras.filter(e => e.category === 'condition'),
      ...src.extras.filter(e => e.category === 'measurement').map(e => ({ ...e, value: '' })),
    ],
    source_id: s.id, source_code: s.code,
  });
  if (continued) Object.assign(d, { made_on: src.made_on || today(), created_by: src.created_by });
  return d;
}

async function copyFrom(id) {
  try {
    const s = await api('GET', `/api/samples/${id}`);
    openDraft(draftFromSource(s));
    toast(`「${s.code}」を引用しました。サンプル番号・実秤量・評価を入力してください`);
    $('#sCode').focus();
  } catch (e) {
    toast(e.message);
    drawSourceSelect();
  }
}

function drawSourceSelect() {
  $('#sSource').innerHTML = '<option value="">（引用しない）</option>' + samples.map(s =>
    `<option value="${s.id}" ${s.id === draft.source_id ? 'selected' : ''}>${esc(s.code)} — ${esc(s.recipe_code)}（${esc(s.made_on ?? '')}）</option>`
  ).join('');
}

$('#sSource').onchange = e => {
  if (!confirmDiscard()) {
    drawSourceSelect();
    return;
  }
  const id = Number(e.target.value);
  if (id) copyFrom(id);
  else openDraft(blankDraft(recipeById(draft.recipe_id) ?? state.recipes[0]));
};

// 開いている既存サンプルを元に新規作成
$('#sCopy').onclick = () => {
  if (!confirmDiscard()) return;
  copyFrom(draft.id);
};

$('#newSample').onclick = () => {
  if (!confirmDiscard()) return;
  openDraft(blankDraft(recipeById(draft?.recipe_id) ?? state.recipes[0]));
};

$('#addCond').onclick = () => addExtra('condition');
$('#addMeas').onclick = () => addExtra('measurement');

/* ---------- 入力欄 → 下書き ---------- */
function bind(sel, key, conv = v => v, after) {
  $(sel).addEventListener('input', e => {
    draft[key] = conv(e.target.value);
    setDirty(true);
    after?.();
  });
}

$('#sRecipe').onchange = e => {
  const entered = Object.values(draft.actuals).some(v => Number.isFinite(v)) ||
    Object.values(draft.lots).some(v => v);
  if (entered && !confirm('配合を変えると、入力済みの実秤量とロットがクリアされ、作成量は配合の基準量に戻ります。よろしいですか？')) {
    e.target.value = draft.recipe_id;
    return;
  }
  const r = recipeById(Number(e.target.value));
  Object.assign(draft, {
    recipe_id: r.id, recipe_version: r.version, total_qty_g: r.default_qty_g,
    basis: basisFromRecipe(r), actuals: {}, lots: {},
  });
  $('#sQty').value = r.default_qty_g;
  setDirty(true);
  drawWeigh();
};

// 配合タブで配合が保存されたら、新規サンプルの狙い量も最新の配合で作り直す
document.addEventListener('masters-changed', () => {
  if (!draft) return;
  if (draft.id === null) {
    const r = recipeById(draft.recipe_id) ?? (draft.recipe_id === null || !dirty ? state.recipes[0] : null);
    if (r) Object.assign(draft, { recipe_id: r.id, recipe_version: r.version, basis: basisFromRecipe(r) });
    drawRecipeSelect();
    drawWeigh();
  } else {
    drawRecipeSelect();
  }
});

/** 配合タブの「この配合でサンプルを作る」から呼ばれる。破棄を断られたら false */
export function newSampleFor(recipeId) {
  if (!confirmDiscard()) return false;
  openDraft(blankDraft(recipeById(recipeId)));
  return true;
}

export async function initSampleTab() {
  // バレル温度と運転条件の入力欄は設定（ゾーン数・項目定義）から作る
  $('#sZones').style.gridTemplateColumns = `repeat(${zones() + 1}, minmax(0, 1fr))`;
  $('#sZones').innerHTML = Array.from({ length: zones() }, (_, i) =>
    `<div class="field"><label for="sZ${i}">C${i + 1}</label><input type="number" step="any" id="sZ${i}" data-z="${i}"></div>`
  ).join('') + '<div class="field"><label for="s_die_temp_c">ダイ</label><input type="number" step="any" id="s_die_temp_c"></div>';
  $('#sCond').innerHTML = COND_FIELDS.map(f =>
    `<div class="field"><label for="s_${f.key}">${esc(f.label)} (${esc(f.unit)})</label><input type="number" step="any" class="w-sm" id="s_${f.key}"></div>`
  ).join('');

  document.querySelectorAll('#sZones input[data-z]').forEach(el => el.addEventListener('input', () => {
    draft.barrel_temps[el.dataset.z] = toNum(el.value);
    setDirty(true);
  }));
  bind('#s_die_temp_c', 'die_temp_c', toNum);
  for (const f of COND_FIELDS) bind(`#s_${f.key}`, f.key, toNum);
  bind('#sCode', 'code');
  bind('#sDate', 'made_on');
  bind('#sQty', 'total_qty_g', toNum, calcSample);
  bind('#sBy', 'created_by');
  bind('#sNote', 'appearance_note');
  bind('#sMemo', 'memo');
  document.querySelectorAll('input[name="sJudge"]').forEach(el => el.addEventListener('change', () => {
    draft.judgement = el.value || null;
    setDirty(true);
  }));

  await reloadSamples();
  openDraft(blankDraft(state.recipes[0]));
}
