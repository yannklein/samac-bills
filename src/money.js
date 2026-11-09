// Money is always handled as integer cents.

/** "1.234,56" / "-1,01" -> cents (integer). Returns NaN if unparsable. */
export function parseEsAmount(str) {
  const clean = String(str).trim().replace(/\s|€/g, '').replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return NaN;
  return Math.round(Number(clean) * 100);
}

/** "233,251" -> 233.251 (plain decimal number, e.g. kWh). */
export function parseEsNumber(str) {
  const clean = String(str).trim().replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(clean) ? Number(clean) : NaN;
}

/** Round a float amount of cents to an integer, half away from zero. */
export function roundCents(x) {
  return Math.sign(x) * Math.round(Math.abs(x) + Number.EPSILON);
}

/** 3228 -> "32,28 €" */
export function formatEur(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${euros},${String(abs % 100).padStart(2, '0')} €`;
}

/** 3228 -> "32,28" (no currency sign, for WhatsApp template variables). */
export function formatEurPlain(cents) {
  return formatEur(cents).replace(' €', '');
}
