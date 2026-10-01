// 画面4: 比較（選んだサンプルを列に並べた転置表）
import { buildMatrix, GROUPS } from './matrix.mjs';
import { JUDGEMENTS } from './fields.mjs';
import { $, esc, api, state } from './common.js';

const JUDGE_CLASS = Object.fromEntries(Object.entries(JUDGEMENTS).map(([k, v]) => [v, k]));

let matrix = [];
let count = 0;
let seq = 0;   // 遅れて返ってきた古い要求の結果で上書きしないため

export async function drawCompare(ids) {
  const my = ++seq;
  if (ids.length < 2) {
    matrix = [];
    $('#cNote').textContent = '';
    $('#cRows').innerHTML = '<tr><td class="empty">サンプル一覧で 2 件以上を選択してください。</td></tr>';
    return;
  }
  $('#cRows').innerHTML = '<tr><td class="empty">読み込み中…</td></tr>';
  // 他の人が削除したサンプルは飛ばして、残りで比べる
  const results = await Promise.allSettled(ids.map(id => api('GET', `/api/samples/${id}`)));
  if (my !== seq) return;
  const samples = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const missing = results.length - samples.length;
  $('#cNote').textContent = missing ? `${missing} 件のサンプルは読めませんでした（削除された可能性があります）。` : '';
  if (samples.length < 2) {
    matrix = [];
    $('#cRows').innerHTML = '<tr><td class="empty">比べられるサンプルが 2 件未満です。サンプル一覧で選び直してください。</td></tr>';
    return;
  }
  // 作成日の古い順に左から並べる
  samples.sort((a, b) => (a.made_on ?? '').localeCompare(b.made_on ?? '') || a.id - b.id);
  matrix = buildMatrix(samples, state.config.barrelZones);
  count = samples.length;
  render();
}

function cell(row, v) {
  if (v === '') return '<td style="color:var(--sub)">—</td>';
  if (row.key === 'judgement') return `<td><span class="tag ${JUDGE_CLASS[v]}">${esc(v)}</span></td>`;
  return `<td>${esc(v)}</td>`;
}

function render() {
  if (!matrix.length) return;
  const onlyDiff = $('#cOnlyDiff').checked;
  const out = [];
  for (const g of GROUPS) {
    const rows = matrix.filter(r => r.group === g.id && (!onlyDiff || r.diff || r.key === 'code'));
    if (!rows.length) continue;
    out.push(`<tr class="grp"><th colspan="${count + 1}" scope="colgroup">${esc(g.label)}</th></tr>`);
    for (const r of rows) {
      out.push(`<tr class="${r.diff ? 'diff' : ''}">
        <th scope="row">${esc(r.label)}${r.unit ? ` (${esc(r.unit)})` : ''}${r.diff ? '<span class="sr-only">（差あり）</span>' : ''}</th>${r.cells.map(v => cell(r, v)).join('')}</tr>`);
    }
  }
  $('#cRows').innerHTML = out.join('');
}

$('#cOnlyDiff').onchange = render;
