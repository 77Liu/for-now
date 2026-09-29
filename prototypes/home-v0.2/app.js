/* Standalone interaction reference: no API requests, no production data, no storage. */
'use strict';
const $ = selector => document.querySelector(selector);
const emptyMode = new URLSearchParams(location.search).has('empty');
const samples = [
  { id: 'thought-1', type: 'thought', source: '思绪 · 9月26日', title: '我想把时间留给什么？', text: '把晚上留出半小时，不急着回复消息，读几页书，或把今天真正想过的事写下来。', full: '把晚上留出半小时，不急着回复消息，读几页书，或把今天真正想过的事写下来。\n\n不需要把每一段空闲都安排满。先试一周，再看看这样的晚上是否适合自己。' },
  { id: 'book-1', type: 'book', source: '阅读笔记 · 书间 ·《园冶》· 9月22日', title: '一扇窗，也能收进远山。', text: '读到借景这一页，想到家里的窗。也许不必添置很多，只需让视线有一个可以停留的地方。', full: '读到借景这一页，想到家里的窗。也许不必添置很多，只需让视线有一个可以停留的地方。\n\n这段是示例读者的阅读感想，不是《园冶》原文。' },
  { id: 'quote-1', type: 'quote', source: '拾句 · 9月18日', title: '', text: '晚风吹过时，先把这一刻留下。' },
  { id: 'thought-2', type: 'thought', source: '思绪 · 9月24日', title: '什么时候，我会想起一个好问题？', text: '今天走路的时候，忽然想通了早上卡住的地方。下次遇到难题，可以先记下来，带它出门走一走。' },
  { id: 'book-2', type: 'book', source: '阅读笔记 · 书间 · 9月20日', title: '读完以后，留下一个问题。', text: '比起记下所有句子，我更想知道：这里的想法，和自己的生活有什么关系？先留一处空白，等经历来回答。' },
  { id: 'quote-2', type: 'quote', source: '拾句 · 9月15日', title: '', text: '窗前的光，今天又向里走了一点。' }
];
const pool = emptyMode ? [] : [...samples];
let currentIds = [];
let series = emptyMode ? [] : [3, 3.5, 3.2, 4, 3.4, 3.1, 3.6];
const todayValues = emptyMode ? [] : [3.6];
let draft = { question: '', idea: '', answer: '' };
let toastTimer;
let restoreFocus;
let saveDraft;
const today = new Date();
const shortDate = date => `${date.getMonth() + 1}月${date.getDate()}日`;
$('#today-date').dateTime = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
$('#today-date').textContent = `${shortDate(today)} · ${new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(today)}`;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}
function arrowButton(label, handler) {
  const button = node('button', 'text-action', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-arrow'); svg.append(use); button.append(svg);
  button.addEventListener('click', handler);
  return button;
}
function notify(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function displayItems(items) {
  const content = $('#content'); content.replaceChildren();
  currentIds = items.map(item => item.id);
  if (!items.length) {
    const empty = node('div', 'empty-content');
    empty.append(node('p', '', '留下第一条思考，往后在这里重逢。'));
    content.append(empty); $('#shuffle').hidden = true;
    return;
  }
  $('#shuffle').hidden = false;
  for (const item of items) {
    const article = node('article', `fragment ${item.type === 'quote' ? 'quote' : ''}`);
    article.append(node('p', 'provenance', item.source));
    if (item.title) article.append(node('h2', '', item.title));
    article.append(node('p', 'excerpt', item.text));
    const open = arrowButton('查看原文', () => openItem(item));
    open.setAttribute('aria-label', `查看原文：${item.title || item.text}`);
    article.append(open); content.append(article);
  }
}
function shuffleItems() {
  const selected = [];
  for (const type of ['thought', 'book', 'quote']) {
    const candidates = pool.filter(item => item.type === type && !currentIds.includes(item.id));
    const fallback = pool.filter(item => item.type === type);
    const choices = candidates.length ? candidates : fallback;
    if (choices.length) selected.push(choices[Math.floor(Math.random() * choices.length)]);
  }
  displayItems(selected);
  $('#content-status').textContent = `已更换${selected.length}条内容。`;
}
function openDialog(title, content) {
  if (!$('#dialog').open) restoreFocus = document.activeElement;
  saveDraft = null;
  $('#dialog-title').textContent = title;
  $('#dialog-content').replaceChildren(content);
  if (!$('#dialog').open) $('#dialog').showModal();
}
function closeDialog() {
  if (saveDraft) saveDraft();
  $('#dialog').close();
}
$('#dialog').addEventListener('cancel', () => { if (saveDraft) saveDraft(); });
$('#dialog').addEventListener('close', () => {
  saveDraft = null;
  if (restoreFocus?.isConnected) restoreFocus.focus();
});
$('#close-dialog').addEventListener('click', closeDialog);
function openItem(item) {
  const body = node('div');
  body.append(node('p', 'provenance', item.source), node('p', 'detail-body', item.full || item.text));
  body.append(node('p', 'fine-print', '示例原文 · 正式接入时打开对应记录及其完整上下文。'));
  openDialog(item.title || '拾句', body);
}
function openThought() {
  const form = node('form', 'dialog-form');
  const fields = [['question', '问题', '你真正想问的是什么？'], ['idea', '初步想法（可选）', '你现在怎么看？'], ['answer', '自己的回答（可选）', '也可以留待以后回答。']];
  for (const [name, label, placeholder] of fields) {
    const field = node('label', '', label);
    const input = node('textarea'); input.name = name; input.placeholder = placeholder;
    input.value = draft[name]; input.maxLength = name === 'question' ? 300 : 5000;
    input.required = name === 'question'; input.rows = name === 'question' ? 2 : 3;
    field.append(input); form.append(field);
  }
  form.append(node('p', 'fine-print', '原型演示：保存仅在本页生效，刷新后清空；不调用模型。关闭后，本次未提交草稿仍会保留。'));
  const footer = node('div', 'form-footer');
  const cancel = node('button', 'text-action', '收起'); cancel.type = 'button'; cancel.onclick = closeDialog;
  const submit = node('button', 'solid-action', '收进思绪'); submit.type = 'submit';
  footer.append(cancel, submit); form.append(footer);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    if (!values.question.trim()) { form.elements.question.setCustomValidity('请写下一个问题。'); form.elements.question.reportValidity(); return; }
    const text = values.idea.trim() || values.answer.trim() || '还没有展开的想法。';
    const item = { id: `demo-${Date.now()}`, type: 'thought', source: `思绪 · ${shortDate(today)}`, title: values.question.trim(), text, full: [values.idea.trim(), values.answer.trim()].filter(Boolean).join('\n\n') || text };
    pool.unshift(item);
    draft = { question: '', idea: '', answer: '' }; saveDraft = null;
    $('#dialog').close();
    displayItems([item, ...currentIds.map(id => pool.find(row => row.id === id)).filter(row => row && row.type !== 'thought')].slice(0, 3));
    notify('已收进本次原型的思绪，刷新后清空。');
  });
  form.addEventListener('input', () => form.elements.question.setCustomValidity(''));
  openDialog('记录思考', form);
  saveDraft = () => { draft = Object.fromEntries(new FormData(form)); };
  form.elements.question.focus();
}
function renderSparkline() {
  const svg = $('#sparkline'); svg.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  if (!series.length) {
    const label = document.createElementNS(ns, 'text'); label.setAttribute('x', '0'); label.setAttribute('y', '30'); label.setAttribute('fill', '#646a60'); label.setAttribute('font-size', '13'); label.textContent = '还没有记录'; svg.append(label);
    svg.setAttribute('aria-label', '还没有情绪记录'); return;
  }
  svg.setAttribute('aria-label', `近7天情绪记录参考，共${series.length}条示例；打开趋势查看数值。`);
  const points = series.map((value, index) => [10 + index * 250 / Math.max(1, series.length - 1), 48 - (value - 1) * 10]);
  if (points.length > 1) {
    const path = document.createElementNS(ns, 'polyline'); path.setAttribute('points', points.map(p => p.join(',')).join(' ')); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.3'); svg.append(path);
  }
  for (const [x, y] of points) { const dot = document.createElementNS(ns, 'circle'); dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '2.2'); dot.setAttribute('fill', 'currentColor'); svg.append(dot); }
}
function openState() {
  const form = node('form', 'dialog-form');
  const field = node('label', '', '此刻情绪'); const select = node('select'); select.name = 'mood'; select.required = true;
  [['', '请选择，不预设你的感受'], ['1', '1 · 很低落'], ['2', '2 · 有些低落'], ['3', '3 · 平静'], ['4', '4 · 比较愉快'], ['5', '5 · 很愉快']].forEach(([value, label]) => { const option = node('option', '', label); option.value = value; select.append(option); });
  field.append(select); form.append(field);
  form.append(node('p', 'fine-print', '这里只描述当下，没有达标线。原型仅演示情绪一项；正式接入保留既有四项状态及可选备注。本次记录刷新后清空。'));
  const submit = node('button', 'solid-action', '保存记录'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', event => {
    event.preventDefault(); const value = Number(select.value); if (!select.value) return;
    todayValues.push(value);
    const mean = Math.round(todayValues.reduce((sum, item) => sum + item, 0) / todayValues.length * 100) / 100;
    if (series.length) series[series.length - 1] = mean; else series.push(mean);
    renderSparkline(); closeDialog(); notify('已记下这一次感受（原型演示）。');
  });
  openDialog('记录状态', form);
}
function openTrend() {
  const content = node('div'); content.append(node('p', 'fine-print', '近7天 · 示例数据。详细数值只在主动查看时显示，不设目标或好坏评价。'));
  if (!series.length) content.append(node('p', 'detail-body', '还没有状态记录。'));
  else {
    const table = node('table', 'trend-table');
    const head = node('thead'); const headings = node('tr'); headings.append(node('th', '', '日期'), node('th', '', '情绪（1–5）')); head.append(headings); table.append(head);
    const tbody = node('tbody');
    series.forEach((value, i) => { const day = new Date(today); day.setDate(today.getDate() - series.length + 1 + i); const row = node('tr'); row.append(node('td', '', shortDate(day)), node('td', '', String(value))); tbody.append(row); });
    table.append(tbody); content.append(table);
  }
  content.append(arrowButton('记录状态', openState)); openDialog('查看趋势', content);
}
const routeGroups = { seen: ['所见', [['念起', 'captures'], ['书间', 'books'], ['拾句', 'quotes'], ['小物', 'keepsakes']]], thought: ['所思', [['思绪', 'thoughts'], ['日记', 'journals'], ['回顾', 'review']]], mine: ['我的', [['账户', 'account'], ['设置', 'settings']]] };
const routeNames = { together: '共参', daily: '每日', captures: '念起', books: '书间', quotes: '拾句', thoughts: '思绪', journals: '日记', review: '回顾', account: '账户', settings: '设置' };
function openRoute(route) {
  if (route === 'today') { window.scrollTo({ top: 0 }); return; }
  if (route === 'review') { openTrend(); return; }
  if (route === 'keepsakes') {
    const content = node('div'); const ticket = $('.ticket').cloneNode(true); ticket.disabled = true; ticket.removeAttribute('data-route');
    content.append(ticket, node('p', 'detail-body', '山间一花\n散步时带回的一张纸，留下那天的片刻。'), node('p', 'fine-print', '原型示例 · 实装接入「所见 → 小物」现有瀑布流和原图详情。'));
    openDialog('小物', content); return;
  }
  const group = routeGroups[route];
  if (group) {
    const list = node('div', 'route-list');
    group[1].forEach(([label, target]) => { const button = node('button', '', `${label} →`); button.addEventListener('click', () => openRoute(target)); list.append(button); });
    openDialog(group[0], list); return;
  }
  const content = node('div'); content.append(node('p', 'detail-body', `此入口接入现有「${routeNames[route] || route}」页面。`), node('p', 'fine-print', '本原型演示首页路由关系，此二级页面沿用项目现有功能，不在这里复制。'));
  openDialog(routeNames[route] || route, content);
}
document.querySelectorAll('[data-route]').forEach(button => button.addEventListener('click', () => openRoute(button.dataset.route)));
$('#new-thought').addEventListener('click', openThought);
$('#shuffle').addEventListener('click', shuffleItems);
$('#record-state').addEventListener('click', openState);
$('#view-trend').addEventListener('click', openTrend);
displayItems(emptyMode ? [] : samples.slice(0, 3));
renderSparkline();
