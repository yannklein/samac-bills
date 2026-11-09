// Parse a meter reading typed by a person ("12345", "12.345", "12,345", "12345.6", "reading 12345 kWh").
// Groups of exactly 3 digits after "." or "," are thousands separators (readings are big integers);
// otherwise a single "." or "," is the decimal separator. Pure: also served to the browser.
export function parseReading(text) {
  const m = String(text ?? '').match(/(-?)(\d[\d.,]*)/);
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  let s = m[2].replace(/[.,]$/, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Number(s);
}
