// Parse a meter reading typed by a person ("12.345", "12345,6", "lectura 12345 kWh").
// Dots followed by exactly 3 digits are thousands separators; a comma (or a lone
// dot not followed by 3 digits) is the decimal separator.
export function parseReading(text) {
  const m = String(text ?? '').match(/(-?)(\d[\d.,]*)/);
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  let s = m[2].replace(/[.,]$/, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Number(s);
}
