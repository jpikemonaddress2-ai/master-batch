// 画面2: サンプル記録
import { targetWeighings, calcActual } from './calc.mjs';
import { COND_FIELDS, JUDGEMENTS } from './fields.mjs';
import {
  $, esc, fmt, toNum, alertBox, api, toast, state, matById, recipeById,
  registerDirty, rememberedAuthor, rememberAuthor, today,
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
    extras: [], actuals: {}, basis: basisFromRecipe(recipe),
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
}

function drawSampleList() {
  const box = $('#sampleList');
  if (!samples.length) {
    box.innerHTML = '<div class="hint" style="padding:12px 14px">サンプルはまだありません。</div>';
    return;
  }
  box.innerHTML = samples.slice(0, 50).map(s => `
    <div class="list-item ${s.id === draft?.id ? 'on' : ''}" data-id="${s.id}">
      <span class="code">${esc(s.code)}</span>
      ${s.judgement ? `<span class="tag ${s.judgement}" style="float:right">${JUDGEMENTS[s.judgement]}</span>` : ''}
      <span class="nm">${esc(s.recipe_code)} ${esc(s.recipe_name)}</span>
      <span class="meta">${esc(s.made_on ?? '')}${s.created_by ? ` / ${esc(s.created_by)}` : ''}</span>
    </div>`).join('');
  box.querySelectorAll('.list-item').forEach(el => el.onclick = async () => {
    const id = Number(el.dataset.id);
    if (id === draft?.id || !confirmDiscard()) return;
    try {
      openDraft(fromSample(await api('GET', `/api/samples/${id}`)));
    } catch (e) {
      toast(e.message);
    }
  });
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
  $('#sDelete').hidden = draft.id === null;
  drawWeigh();
  drawExtras('condition');
  drawExtras('measurement');
}

/* ---------- 秤量 ---------- */
function currentRows() {
  const b = draft.basis;
  const tw = targetWeighings(draft.total_qty_g || 0, b.base_material_id, b.items);
  return { over: tw.over, rows: tw.rows.map(r => ({ ...r, actual_g: draft.actuals[rowKey(r)] ?? null })) };
}

function drawWeigh() {
  if (!draft.basis) {
    $('#sWeigh').innerHTML = '<tr><td colspan="7" class="hint">配合を選ぶと狙い量が並びます。</td></tr>';
    $('#sSummary').innerHTML = '';
    $('#sSave').disabled = $('#sSaveNext').disabled = true;
    return;
  }
  const { rows } = currentRows();
  $('#sWeigh').innerHTML = rows.map((r, i) => {
    const actual = `<input type="number" step="any" min="0" style="width:100%" data-key="${rowKey(r)}" value="${r.actual_g ?? ''}">`;
    if (r.row_type === 'base') {
      return `<tr>
        <td>${esc(matById(r.material_id)?.name ?? '（不明な原料）')} <span style="color:var(--sub);font-size:11px">（ベース樹脂・差引）</span></td>
        <td class="num">—</td><td class="num">—</td>
        <td class="num" data-target="${i}"></td><td class="num">${actual}</td>
        <td class="num">—</td><td class="num">—</td></tr>`;
    }
    return `<tr>
      <td>${esc(draft.basis.items[i].name)}</td>
      <td class="num">${fmt(r.target_active_pct, 2)}</td><td class="num">${fmt(r.active_pct_snapshot, 0)}</td>
      <td class="num" data-target="${i}"></td><td class="num">${actual}</td>
      <td class="num"><b data-real="${i}"></b></td><td class="num delta" data-delta="${i}"></td></tr>`;
  }).join('');
  $('#sWeigh').querySelectorAll('input[data-key]').forEach(el => el.oninput = () => {
    draft.actuals[el.dataset.key] = toNum(el.value);
    setDirty(true); calcSample();
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
async function save() {
  const { rows } = currentRows();
  const body = {
    ...draft,
    basis: undefined,
    extras: draft.extras.filter(e => e.label.trim() || e.value.trim() || e.unit.trim()),
    actuals: rows.map(r => ({ material_id: r.material_id, row_type: r.row_type, actual_g: r.actual_g })),
  };
  const saved = draft.id === null
    ? await api('POST', '/api/samples', body)
    : await api('PUT', `/api/samples/${draft.id}`, body);
  rememberAuthor(saved.created_by ?? '');
  await reloadSamples();
  return saved;
}

async function runSave(next) {
  $('#sSave').disabled = $('#sSaveNext').disabled = true;
  try {
    const saved = await save();
    if (next) {
      // 同じ配合で条件を振る実験が多いので、配合・日付・量・記入者・造粒条件を引き継ぐ
      const d = blankDraft(recipeById(saved.recipe_id));
      const s = fromSample(saved);
      Object.assign(d, {
        made_on: s.made_on, total_qty_g: s.total_qty_g, created_by: s.created_by,
        barrel_temps: s.barrel_temps, die_temp_c: s.die_temp_c,
        ...Object.fromEntries(COND_FIELDS.map(f => [f.key, s[f.key]])),
        extras: s.extras.filter(e => e.category === 'condition'),
      });
      openDraft(d);
      toast(`「${saved.code}」を保存しました。続けて次のサンプルを入力できます`);
      $('#sCode').focus();
    } else {
      openDraft(fromSample(saved));
      toast('保存しました');
    }
  } catch (e) {
    $('#sAlert').innerHTML = alertBox(e.message);
    calcSample();
  }
}

$('#sSave').onclick = () => runSave(false);
$('#sSaveNext').onclick = () => runSave(true);

$('#sDelete').onclick = async () => {
  if (!confirm(`サンプル「${draft.code}」を削除します。元に戻せません。よろしいですか？`)) return;
  try {
    const recipe = recipeById(draft.recipe_id);
    await api('DELETE', `/api/samples/${draft.id}`);
    await reloadSamples();
    openDraft(blankDraft(recipe ?? state.recipes[0]));
    toast('削除しました');
  } catch (e) {
    $('#sAlert').innerHTML = alertBox(e.message);
  }
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
  const r = recipeById(Number(e.target.value));
  Object.assign(draft, {
    recipe_id: r.id, recipe_version: r.version, total_qty_g: r.default_qty_g,
    basis: basisFromRecipe(r), actuals: {},
  });
  $('#sQty').value = r.default_qty_g;
  setDirty(true);
  drawWeigh();
};

// 配合タブで配合が保存されたら、新規サンプルの狙い量も最新の配合で作り直す
document.addEventListener('masters-changed', () => {
  if (!draft) return;
  if (draft.id === null) {
    const r = recipeById(draft.recipe_id) ?? (dirty ? null : state.recipes[0]);
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
