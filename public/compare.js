// 画面4: 比較（選んだサンプルを列に並べた転置表）
import { buildMatrix, GROUPS, sortForCompare, visibleRows } from './matrix.mjs';
import { JUDGEMENTS } from './fields.mjs';
import { $, esc, api, state, alertBox, warnBox, downloadCsv, whileBusy } from './common.js';

const MAX_CSV = 200;   // CSV に出せる件数（server.mjs の MAX_COMPARE と同じ）

const JUDGE_CLASS = Object.fromEntries(Object.entries(JUDGEMENTS).map(([k, v]) => [v, k]));

let matrix = [];
let ids = [];    // 表に出しているサンプル（左からの順）。CSV に使う
let count = 0;
let seq = 0;   // 遅れて返ってきた古い要求の結果で上書きしないため

export async function drawCompare(selectedIds) {
  const my = ++seq;
  if (selectedIds.length < 2) {
    clear();
    $('#cNote').textContent = '';
    $('#cRows').innerHTML = '<tr><td class="empty">サンプル一覧で 2 件以上を選択してください。</td></tr>';
    return;
  }
  clear();
  $('#cRows').innerHTML = '<tr><td class="empty">読み込み中…</td></tr>';
  // 他の人が削除したサンプルは飛ばして、残りで比べる
  const results = await Promise.allSettled(selectedIds.map(id => api('GET', `/api/samples/${id}`)));
  if (my !== seq) return;
  const samples = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const missing = results.length - samples.length;
  $('#cNote').textContent = missing ? `${missing} 件のサンプルは読めませんでした（削除された可能性があります）。` : '';
  if (samples.length < 2) {
    clear();
    $('#cRows').innerHTML = '<tr><td class="empty">比べられるサンプルが 2 件未満です。サンプル一覧で選び直してください。</td></tr>';
    return;
  }
  const sorted = sortForCompare(samples);
  matrix = buildMatrix(sorted, state.config.barrelZones);
  ids = sorted.map(s => s.id);
  count = sorted.length;
  render();
}

function clear() {
  matrix = [];
  ids = [];
  $('#cCsv').hidden = true;
  $('#cAlert').innerHTML = '';
}

function cell(row, v) {
  if (v === '') return '<td style="color:var(--sub)">—</td>';
  if (row.key === 'judgement') return `<td><span class="tag ${JUDGE_CLASS[v]}">${esc(v)}</span></td>`;
  return `<td>${esc(v)}</td>`;
}

function render() {
  if (!matrix.length) return;
  const onlyDiff = $('#cOnlyDiff').checked;
  const shown = visibleRows(matrix, onlyDiff);
  const out = [];
  for (const g of GROUPS) {
    const rows = shown.filter(r => r.group === g.id);
    if (!rows.length) continue;
    out.push(`<tr class="grp"><th colspan="${count + 1}" scope="colgroup">${esc(g.label)}</th></tr>`);
    for (const r of rows) {
      out.push(`<tr class="${r.diff ? 'diff' : ''}">
        <th scope="row">${r.diff ? '<span class="diff-sign" aria-hidden="true">≠</span>' : ''}${esc(r.label)}${r.unit ? ` (${esc(r.unit)})` : ''}${r.diff ? '<span class="sr-only">（差あり）</span>' : ''}</th>${r.cells.map(v => cell(r, v)).join('')}</tr>`);
    }
  }
  $('#cRows').innerHTML = out.join('');
  $('#cAlert').innerHTML = '';   // 前の CSV の知らせは、表示を変えたら消す
  $('#cCsv').hidden = ids.length > MAX_CSV;
  if (ids.length > MAX_CSV) $('#cNote').textContent = `CSV に出せるのは ${MAX_CSV} 件までです。サンプル一覧で選び直してください。`;
}

$('#cOnlyDiff').onchange = render;

// 画面に出している行・列のまま CSV にする（他の人がその後で直した場合は、ダウンロード時点の内容になる）
$('#cCsv').onclick = () => whileBusy($('#cCsv'), 'CSV を作成中…', async () => {
  $('#cAlert').innerHTML = '';
  const my = seq;   // 取得している間に比べるサンプルを選び直したら、古い結果は出さない
  let msg;
  try {
    const { skipped } = await downloadCsv(`/api/samples/compare.csv?ids=${ids.join(',')}${$('#cOnlyDiff').checked ? '&onlyDiff=1' : ''}`);
    // ダウンロードはできているので、エラー（赤）ではなく注意（橙）で知らせる
    msg = skipped ? warnBox(`${skipped} 件のサンプルは、この画面を開いた後に削除されたため CSV に含めていません（画面の表より列が少なくなっています）。`) : '';
  } catch (e) {
    msg = alertBox(`CSV をエクスポートできませんでした: ${e.message}`);
  }
  if (my === seq) $('#cAlert').innerHTML = msg;
});
