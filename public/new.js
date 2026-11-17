// Manual bill entry: upload PDF -> parsed fields -> editable lines -> live split preview.
import { splitLuz } from '/js/splitLuz.js';
import { parseAmount, parseDecimal } from '/js/money.js';
import { parseReading } from '/js/parseReading.js';
import { makeT, formatMoney, formatNumber } from '/js/i18n.js';

const { lang, names } = window.SAMAC;
const t = makeT(lang);
const formatEur = (c) => formatMoney(c, lang);
const plain = (c) => formatNumber(c / 100, lang, 2);

const $ = (id) => document.getElementById(id);
const KINDS = Object.fromEntries(['fixed', 'variable', 'tax', 'unknown'].map((k) => [k, t(`kind.${k}`)]));
const num = (v) => { const n = parseDecimal(v); return Number.isFinite(n) ? n : null; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tbody = document.querySelector('#items tbody');

function addRow(item = { label: '', kind: 'fixed', amountCents: 0, key: 'other' }) {
  const tr = document.createElement('tr');
  tr.dataset.key = item.key || 'other';
  if (item.kwh != null) tr.dataset.kwh = item.kwh;
  tr.innerHTML = `
    <td><input class="label" required></td>
    <td><select class="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></td>
    <td class="num"><input class="amount" inputmode="decimal" required></td>
    <td><button type="button" class="link remove" title="${t('new.remove')}">✕</button></td>`;
  tr.querySelector('.label').value = item.label;
  tr.querySelector('.kind').value = item.kind;
  tr.querySelector('.amount').value = plain(item.amountCents);
  tr.querySelector('.remove').onclick = () => { tr.remove(); update(); };
  tbody.appendChild(tr);
}

function items() {
  return [...tbody.querySelectorAll('tr')].map((tr) => ({
    key: tr.dataset.key,
    label: tr.querySelector('.label').value,
    kind: tr.querySelector('.kind').value,
    amountCents: parseAmount(tr.querySelector('.amount').value),
    ...(tr.dataset.kwh ? { kwh: Number(tr.dataset.kwh) } : {}),
  }));
}

function update() {
  const its = items();
  $('items_json').value = JSON.stringify(its);
  const total = parseAmount($('total').value);
  const sum = its.reduce((s, i) => s + (Number.isFinite(i.amountCents) ? i.amountCents : 0), 0);
  const ok = Number.isFinite(total) && Math.abs(sum - total) <= 1;
  $('sum-check').textContent = `${t('form.sum', { sum: formatEur(sum) })} ${ok ? t('form.sumOk') : t('form.sumBad')}`;
  $('sum-check').className = 'small ' + (ok ? 'ok' : 'error');

  const kwhTotal = num($('kwh_total').value);
  let neighborKwh = num($('neighbor_kwh').value);
  const reading = parseReading($('reading').value);
  if (neighborKwh == null && reading != null && window.SAMAC.lastReading != null) {
    neighborKwh = Math.round((reading - window.SAMAC.lastReading) * 1000) / 1000;
  }
  const preview = $('preview');
  if (neighborKwh == null || !kwhTotal) {
    preview.className = 'muted';
    preview.textContent = t('new.previewEmpty');
    return;
  }
  try {
    const s = splitLuz(its, { kwhTotal, neighborKwh, totalCents: total });
    preview.className = '';
    preview.innerHTML = `
      <p>${esc(t('new.previewNeighbor', { name: names.neighbor, kwh: formatNumber(neighborKwh, lang), total: formatNumber(kwhTotal, lang), pct: formatNumber(s.taxRatioNeighbor * 100, lang, 1) }))}</p>
      <ul>
        <li>${esc(t('new.previewPays', { name: names.neighbor, yann: names.yann, amount: formatEur(s.neighborCents) }))}</li>
        <li>${esc(t('new.previewMarcela', { name: names.marcela, yann: names.yann, amount: formatEur(s.marcelaCents) }))}</li>
        <li>${esc(t('new.previewHome', { yann: names.yann, adriana: names.adriana, amount: formatEur(s.yannAdrianaCents) }))}</li>
      </ul>
      ${s.warnings.map((w) => `<p class="error">⚠ ${esc(w)}</p>`).join('')}`;
  } catch (e) {
    preview.className = 'error';
    preview.textContent = e.message;
  }
}

$('pdf').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  $('parse-status').textContent = t('new.reading');
  $('parse-errors').innerHTML = '';
  const fd = new FormData();
  fd.append('pdf', file);
  const res = await fetch('/bills/parse', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) { $('parse-status').textContent = data.error || 'Error'; return; }
  const p = data.parsed;
  $('pdf_path').value = data.pdf_path;
  $('invoice_no').value = p.invoiceNo ?? '';
  $('issued_at').value = p.issuedAt ?? '';
  $('period_from').value = p.periodFrom ?? '';
  $('period_to').value = p.periodTo ?? '';
  $('days').value = p.days ?? '';
  $('kwh_total').value = p.kwhTotal != null ? formatNumber(p.kwhTotal, lang) : '';
  $('total').value = p.totalCents != null ? plain(p.totalCents) : '';
  tbody.innerHTML = '';
  (p.items.length ? p.items : [{ label: '', kind: 'fixed', amountCents: 0 }]).forEach(addRow);
  $('parse-status').textContent = p.errors.length ? t('new.readWarn') : t('new.readOk');
  $('parse-errors').innerHTML = p.errors.map((e) => `<li>${esc(e)}</li>`).join('');
  $('bill-form').hidden = false;
  update();
});

$('add-item').onclick = () => { addRow(); update(); };
$('bill-form').addEventListener('input', update);
$('bill-form').addEventListener('submit', (ev) => {
  update();
  if (items().some((i) => i.kind === 'unknown')) {
    ev.preventDefault();
    alert(t('new.classifyAll'));
  }
});
