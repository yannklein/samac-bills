// Split an electricity bill between the neighbor and our home.
// Pure and dependency-free: also served to the browser for the live preview.
//
//   fixed lines    -> 50/50
//   variable lines -> by kWh share
//   tax lines      -> by the ratio of each side's pre-tax subtotal
//   home           -> invoice total - neighbor (always reconciles to the cent)
//   home split     -> Marcela 1/3, Yann & Adriana 2/3

const round = (x) => Math.sign(x) * Math.round(Math.abs(x) + Number.EPSILON);

/** Round lines' neighborExact to integers that sum exactly to `target` (largest remainder). */
function apportion(lines, target) {
  const out = lines.map((l) => ({ ...l, neighborCents: Math.floor(l.neighborExact) }));
  let rest = target - out.reduce((s, l) => s + l.neighborCents, 0);
  const order = out
    .map((l, i) => ({ i, frac: l.neighborExact - Math.floor(l.neighborExact) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0 && order.length; k = (k + 1) % order.length, rest--) out[order[k].i].neighborCents++;
  for (let k = order.length - 1; rest < 0 && order.length; k = (k - 1 + order.length) % order.length, rest++) out[order[k].i].neighborCents--;
  return out;
}

export function splitLuz(items, { kwhTotal, neighborKwh, totalCents }) {
  if (!(kwhTotal > 0)) throw new Error('Total consumption (kWh) must be greater than 0.');
  if (!Number.isFinite(neighborKwh)) throw new Error('Missing the neighbor consumption (kWh).');
  if (neighborKwh < 0) throw new Error(`Negative neighbor consumption (${neighborKwh} kWh): check the reading.`);
  const unknown = items.filter((i) => !['fixed', 'variable', 'tax'].includes(i.kind));
  if (unknown.length) {
    throw new Error(`Some lines are unclassified: ${unknown.map((i) => i.label).join(', ')}`);
  }

  const warnings = [];
  if (neighborKwh > kwhTotal) {
    warnings.push(`The neighbor (${neighborKwh} kWh) exceeds the bill's total consumption (${kwhTotal} kWh).`);
  }

  const share = neighborKwh / kwhTotal;
  const lines = [];
  let pretaxN = 0;
  let pretaxAll = 0;
  for (const it of items.filter((i) => i.kind !== 'tax')) {
    const n = it.kind === 'fixed' ? it.amountCents / 2 : it.amountCents * share;
    pretaxN += n;
    pretaxAll += it.amountCents;
    lines.push({ ...it, neighborExact: n });
  }
  const ratio = pretaxAll === 0 ? 0.5 : pretaxN / pretaxAll;
  let taxN = 0;
  let taxAll = 0;
  for (const it of items.filter((i) => i.kind === 'tax')) {
    const n = it.amountCents * ratio;
    taxN += n;
    taxAll += it.amountCents;
    lines.push({ ...it, neighborExact: n });
  }

  // Round each line so the neighbor column sums exactly to its (rounded) group subtotal
  // (largest remainder), and the home cell is always "bill line - neighbor cell".
  const preLines = lines.filter((l) => l.kind !== 'tax');
  const taxLines = lines.filter((l) => l.kind === 'tax');
  const pretaxNCents = round(pretaxN);
  const taxNCents = round(taxN);
  const rounded = [...apportion(preLines, pretaxNCents), ...apportion(taxLines, taxNCents)];

  const total = totalCents ?? items.reduce((s, i) => s + i.amountCents, 0);
  const neighborCents = pretaxNCents + taxNCents;
  const homeCents = total - neighborCents;
  const marcelaCents = round(homeCents / 3);

  return {
    neighborKwh,
    homeKwh: Math.round((kwhTotal - neighborKwh) * 1000) / 1000,
    kwhShare: share,
    taxRatioNeighbor: ratio,
    lines: rounded.map(({ neighborExact, neighborCents: n, ...it }) => ({ ...it, neighborCents: n, homeCents: it.amountCents - n })),
    pretax: { neighbor: pretaxNCents, home: pretaxAll - pretaxNCents, total: pretaxAll },
    taxes: { neighbor: taxNCents, home: taxAll - taxNCents, total: taxAll },
    totalCents: total,
    neighborCents,
    homeCents,
    marcelaCents,
    yannAdrianaCents: homeCents - marcelaCents,
    warnings,
  };
}
