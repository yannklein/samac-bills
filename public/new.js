// Manual bill entry: upload PDF -> parsed fields -> editable lines -> live split preview.
import { splitLuz } from '/js/splitLuz.js';
import { parseEsAmount, formatEur } from '/js/money.js';
import { parseReading } from '/js/parseReading.js';

const $ = (id) => document.getElementById(id);
const KINDS = { fixed: 'Fijo (50/50)', variable: 'Variable (por kWh)', tax: 'Impuesto (por ratio)', unknown: 'Sin clasificar' };
const centsToEs = (c) => formatEur(c).replace(' €', '');
const es = (n) => String(n).replace('.', ',');
const tbody = document.querySelector('#items tbody');

function addRow(item = { label: '', kind: 'fixed', amountCents: 0, key: 'other' }) {
  const tr = document.createElement('tr');
  tr.dataset.key = item.key || 'other';
  if (item.kwh != null) tr.dataset.kwh = item.kwh;
  tr.innerHTML = `
    <td><input class="label" required></td>
    <td><select class="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></td>
    <td class="num"><input class="amount" inputmode="decimal" required></td>
    <td><button type="button" class="link remove" title="Quitar">✕</button></td>`;
  tr.querySelector('.label').value = item.label;
  tr.querySelector('.kind').value = item.kind;
  tr.querySelector('.amount').value = centsToEs(item.amountCents);
  tr.querySelector('.remove').onclick = () => { tr.remove(); update(); };
  tbody.appendChild(tr);
}

function items() {
  return [...tbody.querySelectorAll('tr')].map((tr) => ({
    key: tr.dataset.key,
    label: tr.querySelector('.label').value,
    kind: tr.querySelector('.kind').value,
    amountCents: parseEsAmount(tr.querySelector('.amount').value),
    ...(tr.dataset.kwh ? { kwh: Number(tr.dataset.kwh) } : {}),
  }));
}

function update() {
  const its = items();
  $('items_json').value = JSON.stringify(its);
  const total = parseEsAmount($('total').value);
  const sum = its.reduce((s, i) => s + (Number.isFinite(i.amountCents) ? i.amountCents : 0), 0);
  const ok = Number.isFinite(total) && Math.abs(sum - total) <= 1;
  $('sum-check').textContent = `Suma de líneas: ${formatEur(sum)} ${ok ? '✓ cuadra con el total' : '✗ no cuadra con el total'}`;
  $('sum-check').className = 'small ' + (ok ? 'ok' : 'error');

  const kwhTotal = parseReading($('kwh_total').value);
  let neighborKwh = parseReading($('neighbor_kwh').value);
  const reading = parseReading($('reading').value);
  if (neighborKwh == null && reading != null && window.SAMAC.lastReading != null) {
    neighborKwh = Math.round((reading - window.SAMAC.lastReading) * 1000) / 1000;
  }
  const preview = $('preview');
  if (neighborKwh == null || !kwhTotal) {
    preview.className = 'muted';
    preview.textContent = 'Rellena la lectura o los kWh para ver el reparto.';
    return;
  }
  try {
    const s = splitLuz(its, { kwhTotal, neighborKwh, totalCents: total });
    preview.className = '';
    preview.innerHTML = `
      <p>Vecino: <strong>${es(neighborKwh)} kWh</strong> de ${es(kwhTotal)} kWh · ratio impuestos ${es((s.taxRatioNeighbor * 100).toFixed(1))} %</p>
      <ul>
        <li>Vecino → Yann: <strong>${formatEur(s.neighborCents)}</strong></li>
        <li>Marcela → Yann (1/3 casa): <strong>${formatEur(s.marcelaCents)}</strong></li>
        <li>Yann y Adriana (2/3 casa): <strong>${formatEur(s.yannAdrianaCents)}</strong></li>
      </ul>
      ${s.warnings.map((w) => `<p class="error">⚠ ${w}</p>`).join('')}`;
  } catch (e) {
    preview.className = 'error';
    preview.textContent = e.message;
  }
}

$('pdf').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  $('parse-status').textContent = 'Leyendo PDF…';
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
  $('kwh_total').value = p.kwhTotal != null ? String(p.kwhTotal).replace('.', ',') : '';
  $('total').value = p.totalCents != null ? centsToEs(p.totalCents) : '';
  tbody.innerHTML = '';
  (p.items.length ? p.items : [{ label: '', kind: 'fixed', amountCents: 0 }]).forEach(addRow);
  $('parse-status').textContent = p.errors.length ? 'PDF leído con avisos: revisa los campos.' : 'PDF leído ✓ Revisa y completa la lectura.';
  $('parse-errors').innerHTML = p.errors.map((e) => `<li>${e.replace(/</g, '&lt;')}</li>`).join('');
  $('bill-form').hidden = false;
  update();
});

$('add-item').onclick = () => { addRow(); update(); };
$('bill-form').addEventListener('input', update);
$('bill-form').addEventListener('submit', (ev) => {
  update();
  if (items().some((i) => i.kind === 'unknown')) {
    ev.preventDefault();
    alert('Clasifica todas las líneas antes de guardar.');
  }
});
