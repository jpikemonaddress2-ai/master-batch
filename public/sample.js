// 画面2: サンプル記録
import {
  targetWeighings, calcActual, weighOutliers, compositionSig, compositionChanges, basisFromWeighings, archivedMessage, WEIGH_TOLERANCE,
} from './calc.mjs';
import { COND_FIELDS, JUDGEMENTS } from './fields.mjs';
import { fmtDelta, fmtActual } from './format.mjs';
import { buildMatrix } from './matrix.mjs';
import {
  $, esc, fmt, fmtGram, fmtVal, toNum, alertBox, api, toast, state, matById, recipeById, reloadMasters,
  createDirty, rememberedAuthor, rememberAuthor, today, showAlertWithAction, archivedInRecipe, stopOnBadNumber, setIfChanged, downloadCsv, whileBusy,
} from './common.js';

const RECENT = 50;     // 左の一覧に出す件数
let samples = [];      // 最近のサンプル（左の一覧・引用元・番号の提案に使う）
let extraLabels = [];  // 自由項目で過去に使った項目名
let draft = null;      // 編集中のサンプル
const dirty = createDirty('#sDirtyMark', '保存していないサンプルの変更があります。破棄してよろしいですか？');

const zones = () => state.config.barrelZones;
const rowKey = r => `${r.row_type}:${r.material_id}`;

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
    id: null, version: null, recipe_id: recipe?.id ?? null,
    code: suggestCode(), made_on: today(), total_qty_g: recipe?.default_qty_g ?? 1000,
    created_by: rememberedAuthor(),
    barrel_temps: Array(zones()).fill(null), die_temp_c: null,
    ...Object.fromEntries(COND_FIELDS.map(f => [f.key, null])),
    judgement: null, appearance_note: '', memo: '',
    // actuals: 実秤量（計算用の数値）
    // actualText: この画面で入力した行の文字列（「250.0」の桁数を残して保存する）。入力していない行は持たない
    // actualDp: 保存済みの行の小数の桁数（入力していない行はこの値のまま送り直す。不明なら null のまま）
    // lotAuto: 「前回のロットを入れる」で入れたロットの行（自分で直したら外す）
    extras: [], actuals: {}, actualText: {}, actualDp: {}, lots: {}, lotAuto: new Set(), basis: basisFromRecipe(recipe),
    source_id: null, source_code: null,   // 引用元のサンプル（画面表示用）
    changed: new Set(),                   // 他の人の配合変更で狙い量が変わった行（強調表示用）
  };
}

function fromSample(s) {
  return {
    id: s.id, version: s.version, recipe_id: s.recipe_id,
    code: s.code, made_on: s.made_on ?? '', total_qty_g: s.total_qty_g, created_by: s.created_by ?? '',
    // ゾーン数を減らした後でも、記録済みのゾーンの温度は落とさない（画面に出ない分もそのまま保存し直す）
    barrel_temps: Array.from({ length: Math.max(zones(), s.barrel_temps.length) }, (_, i) => s.barrel_temps[i] ?? null),
    die_temp_c: s.die_temp_c,
    ...Object.fromEntries(COND_FIELDS.map(f => [f.key, s[f.key]])),
    judgement: s.judgement, appearance_note: s.appearance_note ?? '', memo: s.memo ?? '',
    extras: s.extras.map(e => ({ ...e })),
    actuals: Object.fromEntries(s.weighings.map(w => [rowKey(w), w.actual_g])),
    actualText: {},
    actualDp: Object.fromEntries(s.weighings.map(w => [rowKey(w), w.actual_dp ?? null])),
    lotAuto: new Set(),
    lots: Object.fromEntries(s.weighings.map(w => [rowKey(w), w.lot ?? ''])),
    created_at: s.created_at, updated_at: s.updated_at,
    basis: basisFromWeighings(s.weighings),
    changed: new Set(),
  };
}

/* ===================== 一覧 ===================== */
async function reloadSamples() {
  [samples, extraLabels] = await Promise.all([
    api('GET', `/api/samples?limit=${RECENT}`), api('GET', '/api/extra-labels'),
  ]);
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
  box.innerHTML = samples.map(s => `
    <button type="button" class="list-item ${s.id === draft?.id ? 'on' : ''}" data-id="${s.id}" ${s.id === draft?.id ? 'aria-current="true"' : ''}>
      <span class="code">${esc(s.code)}</span>
      ${s.judgement ? `<span class="tag ${s.judgement}" style="float:right">${JUDGEMENTS[s.judgement]}</span>` : ''}
      <span class="nm">${esc(s.recipe_code)} ${esc(s.recipe_name)}</span>
      <span class="meta">${esc(s.made_on ?? '')}${s.created_by ? ` / ${esc(s.created_by)}` : ''}</span>
    </button>`).join('') +
    (samples.length >= RECENT ? `<div class="hint" style="padding:8px 14px">最新 ${RECENT} 件を表示。それより前は「サンプル一覧」から開けます。</div>` : '');
  box.querySelectorAll('.list-item').forEach(el => el.onclick = () => openSample(Number(el.dataset.id)));
}

/**
 * 保存済みサンプルを開く。破棄を断られた・読めなかったら false。
 * force: 開いている同じサンプルも、未保存の変更を確かめずに読み直す（他の人が先に保存したとき）
 */
export async function openSample(id, { force = false } = {}) {
  if (!force && id === draft?.id) return true;
  if (!force && !dirty.confirmDiscard()) return false;
  try {
    openDraft(fromSample(await api('GET', `/api/samples/${id}`)));
    return true;
  } catch (e) {
    $('#sAlert').innerHTML = alertBox(`サンプルを開けませんでした: ${e.message}`);
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
  dirty.set(false);
  $('#sAlert').innerHTML = '';
  $('#sCsvAlert').innerHTML = '';
  drawSampleList();
  drawForm();
}

function drawRecipeSelect() {
  const sel = $('#sRecipe');
  sel.innerHTML = state.recipes.length
    ? state.recipes.map(r => `<option value="${r.id}" ${r.id === draft.recipe_id ? 'selected' : ''}>${esc(r.code)} — ${esc(r.name)}${
      archivedInRecipe(r).length ? '（使用停止の原料を含む）' : ''}</option>`).join('')
    : '<option value="">（先に「配合」タブで配合を登録してください）</option>';
  // 既存サンプルの配合は変えられない（秤量のスナップショットが配合に紐づくため）
  sel.disabled = draft.id !== null || !state.recipes.length;
  sel.title = draft.id !== null ? '保存済みのサンプルの配合は変更できません（別の配合なら新規に作成してください）' : '';
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
  $('#sCsv').hidden = isNew;
  // 保存済みのサンプルでは、後から作ったサンプルのロットが入ってしまうので出さない
  $('#sLastLotsBar').hidden = !isNew;
  $('#sLotNote').textContent = '';
  // 記入者は作成時に確定する。既存サンプルを直す人は「変更者」として毎回名前を残す
  $('#sBy').disabled = !isNew;
  $('#sEditorField').hidden = isNew;
  if (!isNew) $('#sEditor').value = rememberedAuthor();
  $('#sSourceField').hidden = !isNew;
  drawSourceSelect();
  const hidden = draft.barrel_temps.length - zones();
  $('#sMeta').textContent = (isNew
    ? (draft.source_code ? `新規サンプル（${draft.source_code} から引用。実秤量・ロット・評価・測定値の値は空です）` : '新規サンプル')
    : `作成 ${draft.created_at}（${draft.created_by || '記入者なし'}）／ 最終更新 ${draft.updated_at}`) +
    (hidden > 0 ? `　※ 設定より多い ${hidden} ゾーン分のバレル温度が記録されています（比較表・CSV に出ます）` : '');
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
      showSampleDiff(`${hist[i].changed_at} ${hist[i].changed_by} による変更`, hist[i].snapshot, after);
    } catch (e) {
      toast(e.message);
    }
  });
}

/** 2つの版の差分をダイアログに出す。after が null なら before の内容をそのまま一覧にする（削除済みの閲覧） */
export function showSampleDiff(title, before, after) {
  $('#histTitle').textContent = title;
  if (!after) {
    const rows = buildMatrix([before], zones()).filter(r => r.cells[0] !== '');
    $('#histRows').innerHTML = '<tr><th scope="col">項目</th><th scope="col">削除前の内容</th></tr>' + rows.map(r =>
      `<tr><td>${esc(r.label)}${r.unit ? ` (${esc(r.unit)})` : ''}</td><td>${esc(r.cells[0])}</td></tr>`).join('');
  } else {
    // 監査用なので、比較表では差分にしないサンプル番号・作成日・記入者の書き換えも出す
    const rows = buildMatrix([before, after], zones(), { allDiff: true }).filter(r => r.diff);
    $('#histRows').innerHTML = rows.length
      ? '<tr><th scope="col">項目</th><th scope="col">変更前</th><th scope="col">変更後</th></tr>' + rows.map(r => `<tr class="diff">
          <td>${esc(r.label)}${r.unit ? ` (${esc(r.unit)})` : ''}</td>${r.cells.map(v => `<td>${v === '' ? '—' : esc(v)}</td>`).join('')}</tr>`).join('')
      : '<tr><td class="empty">内容の変更はありません（保存のみ）。</td></tr>';
  }
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
    const mat = matById(r.material_id);
    const name = r.row_type === 'base' ? (mat?.name ?? '（不明な原料）') : draft.basis.items[i].name;
    const key = rowKey(r);
    const caution = mat?.caution ? `<div class="caution">⚠ ${esc(mat.caution)}</div>` : '';
    const auto = draft.lotAuto.has(key);
    const lot = `<input style="width:100%" data-lot="${key}" value="${esc(draft.lots[key] ?? '')}" aria-label="${esc(name)} のロット${auto ? '（前回のロットを入れました）' : ''}"${
      auto ? ' class="lot-auto" title="前回のロットを入れました。袋が替わっていないか確認してください"' : ''}>`;
    const actual = `<input type="number" step="any" min="0" style="width:100%" data-key="${key}" value="${esc(draft.actualText[key] ?? fmtActual(r.actual_g, draft.actualDp[key]))}" aria-label="${esc(name)} の実秤量 g">`;
    const cls = draft.changed.has(key) ? 'class="changed"' : '';
    if (r.row_type === 'base') {
      return `<tr ${cls}>
        <td>${esc(name)} <span style="color:var(--sub);font-size:11px">（ベース樹脂・差引）</span>${caution}</td>
        <td class="num">—</td><td class="num">—</td>
        <td class="num" data-target="${i}"></td><td>${lot}</td><td class="num" data-actual="${i}">${actual}</td>
        <td class="num">—</td><td class="num">—</td></tr>`;
    }
    return `<tr ${cls}>
      <td>${esc(name)}${caution}</td>
      <td class="num">${fmtVal(r.target_active_pct)}</td><td class="num">${fmtVal(r.active_pct_snapshot)}</td>
      <td class="num" data-target="${i}"></td><td>${lot}</td><td class="num" data-actual="${i}">${actual}</td>
      <td class="num"><b data-real="${i}"></b></td><td class="num delta" data-delta="${i}"></td></tr>`;
  }).join('');
  $('#sWeigh').querySelectorAll('input[data-key]').forEach(el => el.oninput = () => {
    draft.actuals[el.dataset.key] = toNum(el.value);
    draft.actualText[el.dataset.key] = el.value;
    dirty.set(true); calcSample();
  });
  $('#sWeigh').querySelectorAll('input[data-lot]').forEach(el => el.oninput = () => {
    draft.lots[el.dataset.lot] = el.value;
    draft.lotAuto.delete(el.dataset.lot);
    el.classList.remove('lot-auto');
    el.removeAttribute('title');
    dirty.set(true);
  });
  calcSample();
}

function calcSample() {
  if (!draft?.basis) return;
  const { rows, over } = currentRows();
  const a = calcActual(rows);
  const outliers = new Set(weighOutliers(rows).map(rowKey));
  a.rows.forEach((r, i) => {
    $(`#sWeigh [data-target="${i}"]`).textContent = fmtGram(r.target_g);
    $(`#sWeigh [data-actual="${i}"]`).classList.toggle('outlier', outliers.has(rowKey(r)));
    if (r.row_type !== 'additive') return;
    $(`#sWeigh [data-real="${i}"]`).innerHTML = Number.isNaN(r.real_pct) ? '—'
      : `${fmt(r.real_pct, 3)}${r.estimated ? '<small class="est" title="実秤量が未入力の行を狙い量で補った推定値">推定</small>' : ''}`;
    const cell = $(`#sWeigh [data-delta="${i}"]`);
    const d = r.delta;
    const s = fmtDelta(d, 3);
    cell.className = `num delta ${!s ? '' : Number(s) === 0 ? 'zero' : d > 0 ? 'plus' : 'minus'}`;
    cell.textContent = s ? `${s} pt` : '—';
  });
  const qty = draft.total_qty_g || 0;
  const diff = a.total - qty;
  // 一部の行だけ入力したときは、未入力の行を狙い量で補った推定の総量（実濃度の「推定」と同じ扱い）
  const partial = a.entered && rows.some(r => !Number.isFinite(r.actual_g));
  const est = partial ? '<small class="est" title="実秤量が未入力の行を狙い量で補った推定値">推定</small>' : '';
  const kind = partial ? '推定' : '実測';
  $('#sSummary').innerHTML = `
    <div><div class="k">狙い総量</div><div class="v">${fmtGram(qty)}<small>g</small></div></div>
    <div><div class="k">${a.entered ? `${kind}総量` : '実測総量（未入力）'}</div><div class="v">${a.entered ? fmtGram(a.total) : '—'}<small>g</small>${est}</div></div>
    <div><div class="k">総量差（${kind}−狙い）</div><div class="v">${a.entered ? fmtDelta(diff, 1) : '—'}<small>g</small>${est}</div></div>`;
  // 新規のときだけ。保存済みのサンプルはスナップショットで計算するので、原料の使用停止は関係ない
  const r = draft.id === null ? recipeById(draft.recipe_id) : null;
  const stopped = r ? archivedInRecipe(r) : [];
  setIfChanged($('#sWeighAlert'),
    (stopped.length ? alertBox(archivedMessage(stopped, r.sample_count), { live: false }) : '') +
    (over ? alertBox('配合過剰: 添加剤の合計が作成量を超えています。作成量を見直してください。', { live: false }) : '') +
    (outliers.size ? `<div class="warn">実秤量が狙い量から ${WEIGH_TOLERANCE * 100}% 以上ずれている行があります（桁の打ち間違いがないか確認してください）。</div>` : ''));
  // 保存できない理由は、保存ボタンの横にも出す（秤量表の下の警告は、ボタンまでスクロールすると見えない）
  const why = stopped.length ? '使用停止の原料を含む配合のため保存できません（秤量表の下を参照）'
    : over ? '配合過剰のため保存できません（秤量表の下を参照）' : '';
  $('#sSaveWhy').textContent = why;
  $('#sSave').disabled = $('#sSaveNext').disabled = !!why;
}

/* ---------- 自由項目 ---------- */
const knownLabel = (cat, label) => extraLabels.find(l => l.category === cat && l.label === label.trim());

// 単位の入力候補: その項目名で使われた単位（多い順）。項目名が新しければ、同じ区分で使われた単位すべて
function unitOptions(cat, label) {
  const units = knownLabel(cat, label)?.units
    ?? [...new Set(extraLabels.filter(l => l.category === cat).flatMap(l => l.units))];
  return units.filter(Boolean).map(u => `<option value="${esc(u)}">`).join('');
}

// 単位の一覧の表示（空欄は「単位なし」と書く）
export const unitList = units => units.map(u => u || '単位なし').join('、');

/**
 * その項目名で最も多く使われた単位と違う単位で書いた行を知らせる
 * （g/10min と g/10分 のような表記ゆれは、比較表・CSV で別の単位として扱われる）。
 * 一度紛れ込んだ表記も、多数派でなければ知らせ続ける。単位が本当に違う測り方なら、そのままでよい
 */
function drawUnitWarn(cat) {
  const msgs = draft.extras.filter(e => e.category === cat).flatMap(e => {
    // units は空欄（単位なし）も含めて多い順。最も多いのが「単位なし」なら、空欄はそれに合っている
    const units = knownLabel(cat, e.label)?.units ?? [];
    const u = e.unit.trim();
    if (!units.length || u === units[0]) return [];
    return [`「${e.label.trim()}」の単位${u ? `「${u}」` : 'が空欄'}は、これまで最も多い「${units[0] || '単位なし'}」と違います` +
      (units.length > 1 ? `（これまで: ${unitList(units)}）` : '')];
  });
  setIfChanged($(`#sUnitWarn-${cat}`), msgs.length
    ? `<div class="warn">${msgs.map(esc).join('<br>')}。同じ単位なら表記をそろえてください（違う表記は、比較表・CSV で別の単位として扱われます）。</div>` : '');
}

function drawExtras(cat) {
  const tbody = $(`#sExtras-${cat}`);
  const idx = draft.extras.map((e, i) => (e.category === cat ? i : -1)).filter(i => i >= 0);
  tbody.innerHTML = idx.length ? idx.map((i, n) => {
    const e = draft.extras[i];
    return `<tr>
      <td><input style="width:100%" data-i="${i}" data-f="label" list="dl-${cat}" value="${esc(e.label)}" aria-label="${n + 1} 行目の項目名"></td>
      <td><input style="width:100%" data-i="${i}" data-f="value" value="${esc(e.value)}" aria-label="${esc(e.label) || `${n + 1} 行目`} の値"></td>
      <td><input style="width:100%" data-i="${i}" data-f="unit" list="dlu-${i}" value="${esc(e.unit)}" aria-label="${esc(e.label) || `${n + 1} 行目`} の単位">
        <datalist id="dlu-${i}">${unitOptions(cat, e.label)}</datalist></td>
      <td><button class="del" data-i="${i}" aria-label="${esc(e.label) || `${n + 1} 行目`} を削除">削除</button></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="hint">項目はありません。</td></tr>';

  tbody.querySelectorAll('input[data-f]').forEach(el => el.oninput = () => {
    draft.extras[el.dataset.i][el.dataset.f] = el.value;
    dirty.set(true);
  });
  // 単位の注意は入力を確定したときに出す（打っている途中で出たり消えたりしない）
  tbody.querySelectorAll('input[data-f="unit"]').forEach(el => el.onchange = () => drawUnitWarn(cat));
  // 既知の項目名を選んだら、単位の候補をその項目で使われた単位にし、単位が空なら最も多い単位を入れる
  tbody.querySelectorAll('input[data-f="label"]').forEach(el => el.onchange = () => {
    const e = draft.extras[el.dataset.i];
    $(`#dlu-${el.dataset.i}`).innerHTML = unitOptions(cat, e.label);
    const known = knownLabel(cat, e.label);
    if (known?.unit && !e.unit) {
      e.unit = known.unit;
      tbody.querySelector(`input[data-i="${el.dataset.i}"][data-f="unit"]`).value = known.unit;
    }
    drawUnitWarn(cat);
  });
  drawUnitWarn(cat);
  tbody.querySelectorAll('button.del').forEach(el => el.onclick = () => {
    draft.extras.splice(Number(el.dataset.i), 1);
    dirty.set(true);
    drawExtras('condition');
    drawExtras('measurement');
  });
}

function addExtra(cat) {
  draft.extras.push({ category: cat, label: '', value: '', unit: '' });
  dirty.set(true);
  drawExtras(cat);
  const inputs = $(`#sExtras-${cat}`).querySelectorAll('input[data-f="label"]');
  inputs[inputs.length - 1]?.focus();
}

/* ---------- 保存・削除 ---------- */
function body(changedBy) {
  const { rows } = currentRows();
  return {
    ...draft,
    basis: undefined, lots: undefined, changed: undefined, actualText: undefined, actualDp: undefined, lotAuto: undefined,
    changed_by: changedBy,
    // 画面で見ていた組成。保存までに他の人が配合を変えていたらサーバーが気づけるようにする
    recipe_sig: compositionSig(draft.basis.base_material_id, draft.basis.items),
    // 値の無い行は保存しない（引用で項目名だけ並べた測定値を、測らなかった場合など）
    extras: draft.extras.filter(e => e.value.trim()),
    actuals: rows.map(r => ({
      // この画面で入力した実秤量は文字列のまま送る（サーバーが小数の桁数を記録する）。
      // 入力していない行は保存済みの数値と桁数をそのまま送る（桁数が不明な古い記録を、表示の文字列から決め直さない）
      material_id: r.material_id, row_type: r.row_type,
      ...(rowKey(r) in draft.actualText
        ? { actual_g: draft.actualText[rowKey(r)] }
        : { actual_g: r.actual_g, actual_dp: draft.actualDp[rowKey(r)] ?? null }),
      lot: draft.lots[rowKey(r)] ?? '',
    })),
  };
}

// サンプルの件数が変わると配合タブの組成ロックも変わるので、配合も取り直す
async function reloadAfterChange() {
  try {
    await Promise.all([reloadSamples(), reloadMasters()]);
  } catch (e) {
    toast(`一覧の更新に失敗しました: ${e.message}`);
  }
}

// 保存が競合したときの回復。入力中の内容をできるだけ残す
async function recoverFromConflict(e) {
  if (e.code === 'recipe_changed' || e.code === 'archived') {
    // 他の人が配合を変えた・原料を使用停止にした: 配合を読み直す。
    // 狙い量の取り直しと変わった行の色付けは syncNewDraft がする（実秤量・ロットは残す）
    let shown;
    try {
      shown = await reloadMastersAndSync({ force: true });
    } catch (err) {
      $('#sAlert').innerHTML = alertBox(`${e.message}（配合の読み直しに失敗しました: ${err.message}）`);
      return;
    }
    if (!shown) $('#sAlert').innerHTML = alertBox(e.message);
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
  if (draft.id !== null && !dirty.get() && !next) {
    toast('変更はありません');
    return;
  }
  if (stopOnBadNumber($('#tab-sample'), $('#sAlert'))) return;
  let changedBy = null;
  if (draft.id !== null) {
    changedBy = editorName();
    if (!changedBy) return;
  }
  const outliers = weighOutliers(currentRows().rows);
  if (outliers.length && !confirm(`実秤量が狙い量から ${WEIGH_TOLERANCE * 100}% 以上ずれている行が ${outliers.length} 行あります。\n桁の打ち間違いではありませんか？ このまま保存しますか？`)) {
    return;
  }
  $('#sSave').disabled = $('#sSaveNext').disabled = true;
  let saved;
  try {
    saved = draft.id === null
      ? await api('POST', '/api/samples', body(changedBy))
      : await api('PUT', `/api/samples/${draft.id}`, body(changedBy));
  } catch (e) {
    await recoverFromConflict(e);
    calcSample();
    return;
  }
  // 保存はできている。一覧の更新に失敗しても、画面は保存済みの内容にする（二重登録を防ぐ）
  if (draft.id === null) rememberAuthor(saved.created_by ?? '');
  openDraft(fromSample(saved));
  await reloadAfterChange();
  if (next) {
    // 同じ配合で条件を振る実験が多いので、今保存したサンプルを引用して次を作る
    openDraft(draftFromSource(saved, { continued: true }));
    toast(`「${saved.code}」を保存しました。続けて次のサンプルを入力できます`);
    $('#sCode').focus();
  } else {
    drawSampleList();
    toast('保存しました');
  }
}

$('#sSave').onclick = () => runSave(false);
$('#sSaveNext').onclick = () => runSave(true);

$('#sDelete').onclick = async () => {
  $('#sAlert').innerHTML = '';
  const changedBy = editorName();
  if (!changedBy) return;
  if (!confirm(`サンプル「${draft.code}」を削除します（変更者: ${changedBy}）。\n一覧からは消えます。削除前の内容は「サンプル一覧」の「削除済みサンプル」から見られます。よろしいですか？`)) return;
  try {
    const recipe = recipeById(draft.recipe_id);
    await api('DELETE', `/api/samples/${draft.id}`, { changed_by: changedBy, version: draft.version });
    dirty.set(false);
    await reloadAfterChange();
    openDraft(blankDraft(recipe ?? state.recipes[0]));
    toast('削除しました');
  } catch (e) {
    await recoverFromConflict(e);
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
  if (!dirty.confirmDiscard()) {
    drawSourceSelect();
    return;
  }
  const id = Number(e.target.value);
  if (id) copyFrom(id);
  else openDraft(blankDraft(recipeById(draft.recipe_id) ?? state.recipes[0]));
};

// 開いている既存サンプルを元に新規作成
$('#sCopy').onclick = () => {
  if (!dirty.confirmDiscard()) return;
  copyFrom(draft.id);
};

$('#newSample').onclick = () => {
  if (!dirty.confirmDiscard()) return;
  openDraft(blankDraft(recipeById(draft?.recipe_id) ?? state.recipes[0]));
};

// CSV は保存済みの内容で出る。未保存の変更があるときは、その旨を確かめる
// エラーは保存のエラー（#sAlert。「最新を読み直す」などの回復ボタンが出る）とは別の欄に出す
$('#sCsv').onclick = () => {
  if (dirty.get() && !confirm('保存していない変更は CSV に含まれません（保存済みの内容でエクスポートします）。よろしいですか？')) return;
  return whileBusy($('#sCsv'), 'CSV を作成中…', async () => {
    $('#sCsvAlert').innerHTML = '';
    try {
      await downloadCsv(`/api/samples/compare.csv?ids=${draft.id}`);
    } catch (e) {
      $('#sCsvAlert').innerHTML = alertBox(`CSV をエクスポートできませんでした: ${e.message}`);
    }
  });
};

/**
 * 空欄のロットに、その原料を直近のサンプルで使ったロットを入れる。同じ袋を続けて使うことが多いので打ち直しを減らす。
 * 引用や「続けて新規」では黙って引き継がない（袋が替わったのに前のロットが残る取り違えを防ぐ）ので、押したときだけ入れる
 */
$('#sLastLots').onclick = () => whileBusy($('#sLastLots'), 'ロットを読み込み中…', async () => {
  if (!draft?.basis) return;
  // 読んでいる間に別のサンプルを開いた・配合や作成日を変えたときは入れない（配合の変更は draft を差し替えないので組成で見る）
  const d = draft;
  const sig = () => `${compositionSig(draft.basis.base_material_id, draft.basis.items)}|${draft.made_on}`;
  const before = sig();
  const ids = [...new Set(currentRows().rows.map(r => r.material_id))];
  $('#sLotNote').textContent = '';
  let last;
  try {
    // 作成日より後のサンプルのロットは入れない（過去の日付のサンプルを後から記録するとき）
    last = await api('GET', `/api/last-lots?materials=${ids.join(',')}&until=${encodeURIComponent(draft.made_on || '')}`);
  } catch (e) {
    if (draft === d) toast(`前回のロットを読めませんでした: ${e.message}`);
    return;
  }
  if (draft !== d || sig() !== before) return;
  const rows = currentRows().rows;
  const by = new Map(last.map(l => [l.material_id, l]));
  const filled = [];
  for (const r of rows) {
    const k = rowKey(r);
    const l = by.get(r.material_id);
    if ((draft.lots[k] ?? '').trim() || !l) continue;
    draft.lots[k] = l.lot;
    draft.lotAuto.add(k);
    filled.push(`${matById(r.material_id)?.name ?? '原料'}: ${l.lot}（${l.code}, ${l.made_on}）`);
  }
  if (filled.length) {
    dirty.set(true);
    drawWeigh();
  }
  $('#sLotNote').textContent = filled.length
    ? `${filled.length} 行に入れました（色の付いた欄）— ${filled.join(' ／ ')}。袋が替わっていないか確認してください`
    : '入れられるロットはありませんでした（空欄の行の原料で、作成日までにロットを記録したサンプルがありません）';
});

$('#addCond').onclick = () => addExtra('condition');
$('#addMeas').onclick = () => addExtra('measurement');

/* ---------- 入力欄 → 下書き ---------- */
function bind(sel, key, conv = v => v, after) {
  $(sel).addEventListener('input', e => {
    draft[key] = conv(e.target.value);
    dirty.set(true);
    after?.();
  });
}

$('#sRecipe').onchange = e => {
  // いま表に出ている行に入力があるか（配合から外れた行の古い入力は数えない）
  const keys = draft.basis ? currentRows().rows.map(rowKey) : [];
  const entered = keys.some(k => Number.isFinite(draft.actuals[k]) || draft.lots[k]);
  if (entered && !confirm('配合を変えると、入力済みの実秤量とロットがクリアされ、作成量は配合の基準量に戻ります。よろしいですか？')) {
    e.target.value = draft.recipe_id;
    return;
  }
  const r = recipeById(Number(e.target.value));
  Object.assign(draft, {
    recipe_id: r.id, total_qty_g: r.default_qty_g,
    basis: basisFromRecipe(r), actuals: {}, actualText: {}, actualDp: {}, lots: {}, lotAuto: new Set(), changed: new Set(),
  });
  $('#sLotNote').textContent = '';
  $('#sQty').value = r.default_qty_g;
  dirty.set(true);
  drawWeigh();
};

/**
 * 新規の下書きの狙い量を、配合の最新の内容で作り直す。
 * 入力中に他の人が組成を変えていたら、黙って差し替えず、変わった行を色付けして知らせる。
 * @returns {boolean} 組成の変更を知らせたか
 */
function syncNewDraft({ force = false } = {}) {
  const r = recipeById(draft.recipe_id) ?? (draft.recipe_id === null || !dirty.get() ? state.recipes[0] : null);
  if (!r) return false;
  const prev = draft.recipe_id === r.id ? draft.basis : null;
  Object.assign(draft, { recipe_id: r.id, basis: basisFromRecipe(r) });
  // 何も入力していなければ黙って最新にしてよい。保存しようとして止められたとき（force）は、どこが変わったかを示す
  if (!prev || (!dirty.get() && !force)) return false;
  const { changed, removed } = compositionChanges(prev, draft.basis);
  if (!changed.length && !removed.length) return false;
  // 色付けは、この下書きを開き直すか配合を選び直すまで残す（続けて2回変わっても、最初の変更の印を消さない）
  changed.forEach(k => draft.changed.add(k));
  const dropped = removed.filter(k => Number.isFinite(draft.actuals[k]));
  const droppedAdd = dropped.filter(k => k.startsWith('additive:')).length;
  const droppedBase = dropped.some(k => k.startsWith('base:'));
  $('#sAlert').innerHTML = alertBox(`配合「${r.code}」の組成が、この画面を開いた後に変更されました。最新の配合で狙い量を取り直したので、色付けした行を確認してから保存してください` +
    (droppedAdd ? `（配合から外れた添加剤 ${droppedAdd} 行の実秤量は使われません）` : '') +
    (droppedBase ? '（ベース樹脂が変わったため、入力したベース樹脂の実秤量は使われません）' : '') + '。');
  return true;
}

// reloadMastersAndSync から masters-changed のハンドラーへ渡す指定と、その結果
let syncRun = { force: false, notified: false };

/**
 * 配合を読み直し、新規の下書きを最新の配合に合わせる。
 * @returns {Promise<boolean>} 組成の変更を画面で知らせたか
 */
async function reloadMastersAndSync({ force = false } = {}) {
  syncRun = { force, notified: false };
  try {
    // reloadMasters は masters-changed を dispatchEvent で同期に発火するので、戻った時点でハンドラーは済んでいる
    await reloadMasters();
    return syncRun.notified;
  } finally {
    syncRun = { force: false, notified: false };
  }
}

// 配合・原料が保存されたら、新規サンプルの狙い量も最新の配合で作り直す
document.addEventListener('masters-changed', () => {
  if (!draft) return;
  if (draft.id === null && syncNewDraft({ force: syncRun.force })) syncRun.notified = true;
  drawRecipeSelect();
  drawWeigh();   // 原料の取扱注意・使用停止の変更も反映する
});

/** 配合タブの「この配合でサンプルを作る」から呼ばれる。破棄を断られたら false */
export function newSampleFor(recipeId) {
  if (!dirty.confirmDiscard()) return false;
  openDraft(blankDraft(recipeById(recipeId)));
  return true;
}

export async function initSampleTab() {
  // バレル温度と運転条件の入力欄は設定（ゾーン数・項目定義）から作る
  $('#sZones').innerHTML = Array.from({ length: zones() }, (_, i) =>
    `<div class="field"><label for="sZ${i}">C${i + 1}</label><input type="number" step="any" id="sZ${i}" data-z="${i}"></div>`
  ).join('') + '<div class="field"><label for="s_die_temp_c">ダイ</label><input type="number" step="any" id="s_die_temp_c"></div>';
  $('#sCond').innerHTML = COND_FIELDS.map(f =>
    `<div class="field"><label for="s_${f.key}">${esc(f.label)} (${esc(f.unit)})</label><input type="number" step="any" class="w-sm" id="s_${f.key}"></div>`
  ).join('');

  document.querySelectorAll('#sZones input[data-z]').forEach(el => el.addEventListener('input', () => {
    draft.barrel_temps[el.dataset.z] = toNum(el.value);
    dirty.set(true);
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
    dirty.set(true);
  }));

  await reloadSamples();
  openDraft(blankDraft(state.recipes[0]));
}
