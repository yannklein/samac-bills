// Parse the text of an Endesa electricity bill PDF ("DETALLE DE LA FACTURA").
// Pure function: text in, structured bill out. Never throws; problems go to `errors`.
import { parseEsAmount, parseEsNumber, formatEur } from './money.js';

// Split kinds:
//   fixed    -> shared 50/50
//   variable -> shared by kWh consumed
//   tax      -> shared by the ratio of each side's pre-tax subtotal
//   unknown  -> must be classified by hand before splitting
const RULES = [
  { re: /^Pot\./i, key: 'power', kind: 'fixed' },
  { re: /^Facturaci[oó]n del Consumo/i, key: 'energy', kind: 'variable' },
  { re: /^Descuento/i, key: 'discount', kind: 'variable' },
  { re: /Bono Social/i, key: 'bono_social', kind: 'fixed' },
  { re: /^Alquiler del contador/i, key: 'meter_rental', kind: 'fixed' },
  { re: /^Impuesto (de )?electricidad/i, key: 'electricity_tax', kind: 'tax' },
  { re: /^IVA/i, key: 'vat', kind: 'tax' },
];

export const KIND_LABELS = {
  fixed: 'Fijo (50/50)',
  variable: 'Variable (por kWh)',
  tax: 'Impuesto (por ratio)',
  unknown: 'Sin clasificar',
};

const toIso = (dmy) => {
  const [d, m, y] = dmy.split('/');
  return `${y}-${m}-${d}`;
};

export function parseEndesaBill(text) {
  const errors = [];
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());

  const find = (re) => {
    for (const l of lines) {
      const m = l.match(re);
      if (m) return m;
    }
    return null;
  };

  const invoiceNo = find(/^N[º°o]\s*factura:\s*(\S+)/i)?.[1] ?? null;
  const period = find(/del (\d{2}\/\d{2}\/\d{4}) a (\d{2}\/\d{2}\/\d{4}) \((\d+) d[ií]as\)/i);
  const issued = find(/Fecha emisi[oó]n factura:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const totalM = find(/^TOTAL\s+(-?[\d.]+,\d{2})\s*€/);

  // Detail section: between "DETALLE DE LA FACTURA" and "TOTAL x €"
  const start = lines.findIndex((l) => /^DETALLE DE LA FACTURA/i.test(l));
  const end = lines.findIndex((l, i) => i > start && /^TOTAL\s+-?[\d.]+,\d{2}\s*€/.test(l));
  const items = [];
  if (start === -1 || end === -1) {
    errors.push('No se encontró la sección "DETALLE DE LA FACTURA" / TOTAL. ¿Es una factura de luz de Endesa?');
  } else {
    for (const line of lines.slice(start + 1, end)) {
      // Category headers look like "Potencia 21,44 €......" -> skip
      if (/^[^.]*?-?[\d.]+,\d{2}\s*€\.{3,}$/.test(line)) continue;
      // Detail lines look like "label ......... 10,72 €"
      const m = line.match(/^(.*?)\s*\.{3,}\s*(-?[\d.]+,\d{2})\s*€$/);
      if (!m) continue;
      const label = m[1].trim();
      const amountCents = parseEsAmount(m[2]);
      const rule = RULES.find((r) => r.re.test(label));
      const item = { key: rule?.key ?? 'other', label, kind: rule?.kind ?? 'unknown', amountCents };
      if (item.key === 'energy') {
        const kwh = label.match(/([\d.]+,\d+)\s*kWh/i);
        item.kwh = kwh ? parseEsNumber(kwh[1]) : null;
      }
      if (!rule) errors.push(`Línea desconocida, clasifícala a mano: "${label}" (${formatEur(amountCents)})`);
      items.push(item);
    }
  }

  const energyKwh = items.filter((i) => i.key === 'energy').reduce((s, i) => s + (i.kwh ?? 0), 0);
  const consumoTotal = find(/^Consumo Total\s+([\d.]+,\d+)\s*kWh/i);
  const kwhTotal = energyKwh > 0
    ? Math.round(energyKwh * 1000) / 1000
    : consumoTotal ? parseEsNumber(consumoTotal[1]) : null;

  const totalCents = totalM ? parseEsAmount(totalM[1]) : null;
  if (!invoiceNo) errors.push('No se encontró el número de factura.');
  if (!period) errors.push('No se encontró el periodo de facturación.');
  if (totalCents == null) errors.push('No se encontró el TOTAL.');
  if (!kwhTotal) errors.push('No se encontró el consumo total en kWh.');
  if (totalCents != null && items.length) {
    const sum = items.reduce((s, i) => s + i.amountCents, 0);
    if (Math.abs(sum - totalCents) > 1) {
      errors.push(`Las líneas no suman el total: ${formatEur(sum)} ≠ ${formatEur(totalCents)}.`);
    }
  }

  return {
    utility: 'luz',
    invoiceNo,
    periodFrom: period ? toIso(period[1]) : null,
    periodTo: period ? toIso(period[2]) : null,
    days: period ? Number(period[3]) : null,
    issuedAt: issued ? toIso(issued[1]) : null,
    totalCents,
    kwhTotal,
    items,
    errors,
  };
}
