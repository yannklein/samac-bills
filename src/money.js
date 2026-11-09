// Money is always handled as integer cents.

/** Spanish bill amounts "1.234,56" / "-1,01" -> cents (integer). Returns NaN if unparsable. */
export function parseEsAmount(str) {
  const clean = String(str).trim().replace(/\s|€/g, '').replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return NaN;
  return Math.round(Number(clean) * 100);
}

/** Spanish bill numbers "233,251" -> 233.251 (e.g. kWh). */
export function parseEsNumber(str) {
  const clean = String(str).trim().replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(clean) ? Number(clean) : NaN;
}

/**
 * Number typed in a form, either style: "10.72", "10,72", "1,234.56", "1.234,56", "233.251".
 * With both separators the last one is the decimal; with a single separator it is the decimal.
 */
export function parseDecimal(str) {
  let s = String(str ?? '').trim().replace(/\s|€|kwh/gi, '');
  if (!s) return NaN;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else {
    s = s.replace(',', '.');
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/** Amount typed in a form -> cents. */
export function parseAmount(str) {
  const n = parseDecimal(str);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Round a float amount of cents to an integer, half away from zero. */
export function roundCents(x) {
  return Math.sign(x) * Math.round(Math.abs(x) + Number.EPSILON);
}

/** 3228 -> "32.28" */
export function formatEurPlain(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${euros}.${String(abs % 100).padStart(2, '0')}`;
}

/** 3228 -> "€32.28", -101 -> "-€1.01" */
export function formatEur(cents) {
  const plain = formatEurPlain(cents);
  return plain.startsWith('-') ? `-€${plain.slice(1)}` : `€${plain}`;
}
