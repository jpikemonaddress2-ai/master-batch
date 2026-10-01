import { $, api, alertBox, state, reloadMasters, showTab } from './common.js';
import { initRecipeTab } from './recipe.js';
import { initSampleTab } from './sample.js';
import { initListTab, selected } from './list.js';
import { drawCompare } from './compare.js';

document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  showTab(b.dataset.tab);
  if (b.dataset.tab === 'compare') drawCompare([...selected]);
});

try {
  state.config = await api('GET', '/api/config');
  await reloadMasters();
  initRecipeTab();
  await initListTab();
  await initSampleTab();
} catch (e) {
  $('main').innerHTML = alertBox(`サーバーに接続できません: ${e.message}`);
}
