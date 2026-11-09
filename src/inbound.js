// Routing of incoming WhatsApp messages and Endesa emails -> state changes + an outbox
// of WhatsApp messages for n8n to send. All conversation logic lives here (tested),
// n8n only transports messages.
import { HttpError } from './service.js';
import { TEMPLATES } from './whatsapp.js';
import { parseReading } from './parseReading.js';
import { extractDownloadLink, downloadBillPdf, EndesaError } from './endesa.js';
import { parseEndesaBill } from './parseEndesaBill.js';
import { pdfText } from './pdf.js';
import { formatEur } from './money.js';

const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const HELP = 'Commands: "reading 12345" (neighbor meter reading), "kwh 100" (neighbor kWh directly), "status".';

export function makeInbound({ svc, wa, publicUrl, endesaNie, fetchImpl = fetch }) {
  const people = () => svc.people();

  /** Message to Yann: free text if he just wrote (24h window open), else the notice template. */
  function toYann(text, senderRole) {
    const yann = people().yann;
    if (!yann?.wa_phone) return [];
    return [senderRole === 'yann' ? wa.text(yann.wa_phone, text) : wa.template(yann.wa_phone, TEMPLATES.notice, [text])];
  }

  function splitOutbox(billId) {
    const m = svc.message(billId);
    return m.recipients.map((r) => wa.template(r.wa_phone, TEMPLATES.split, m.split_vars));
  }

  function summary(billId) {
    const d = svc.billDetail(billId);
    const s = d.split;
    return s
      ? `${d.bill.invoice_no}: neighbor ${s.neighbor_kwh} kWh → ${formatEur(s.neighbor_cents)}, Marcela ${formatEur(s.marcela_cents)}, Yann & Adriana ${formatEur(s.yann_adriana_cents)}.`
      : `${d.bill.invoice_no}: no split yet.`;
  }

  /** Confirm a reading and build the outbox, turning business errors into replies. */
  function confirmAndSend(bill, opts, { from, role }) {
    try {
      svc.confirm(bill.id, opts);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (e.status === 409) return { outbox: [wa.text(from, e.message)], action: 'stale' };
      if (role === 'yann') return { outbox: [wa.text(from, `${e.message} ${HELP}`)], action: 'rejected' };
      return {
        outbox: [
          wa.text(from, 'Thanks! Yann will check the reading before sending the split.'),
          ...toYann(`Check bill ${bill.invoice_no}: ${e.message} Reply "reading N" or "kwh N" to force it. ${publicUrl}/bills/${bill.id}`, role),
        ],
        action: 'needs_review',
      };
    }
    const outbox = splitOutbox(bill.id);
    if (role === 'yann' && opts.source === 'override') outbox.unshift(wa.text(from, `Recalculated. ${summary(bill.id)} Sending to everyone.`));
    return { outbox, mark_sent_bill_id: bill.id, action: 'split_sent' };
  }

  function handleWhatsApp(msg) {
    const from = String(msg.from ?? '').replace(/\D/g, '');
    const role = svc.roleByPhone(from);

    if (msg.type === 'status_failed') {
      const failedRole = svc.roleByPhone(msg.recipient);
      // Never notify Yann about a failed notification to Yann (would loop).
      if (failedRole === 'yann' || !people().yann) return { outbox: [], action: 'ignored' };
      return { outbox: toYann(`A WhatsApp message to ${failedRole ?? msg.recipient} could not be delivered: ${msg.error ?? 'unknown error'}`), action: 'failure_notice' };
    }
    if (role && role !== 'yann' && msg.type === 'text' && /(delete my data|borrar mis datos)/i.test(msg.text ?? '')) {
      return {
        outbox: [
          wa.text(from, 'Received. Yann will delete your data within 30 days.'),
          ...toYann(`${people()[role]?.name ?? role} asked to delete their data (privacy policy).`, role),
        ],
        action: 'deletion_request',
      };
    }
    if (!role || role === 'adriana' || role === 'marcela') return { outbox: [], action: 'ignored' };

    // Meter photo (from the neighbor, or forwarded by Yann)
    if (msg.type === 'image') {
      const bill = svc.openBill();
      if (!bill) {
        if (role === 'yann') return { outbox: [wa.text(from, 'No bill is waiting for a reading.')], action: 'no_open_bill' };
        return {
          outbox: [
            wa.text(from, 'Thanks! The electricity bill has not arrived yet; I will let you know when it does.'),
            ...toYann('The neighbor sent a meter photo but no bill is pending.', role),
          ],
          action: 'no_open_bill',
        };
      }
      const reading = Number.isFinite(msg.reading) ? msg.reading : null;
      const cand = svc.addCandidate(bill.id, {
        reading, photoBuffer: msg.photoBuffer, photoExt: msg.photoExt, confidence: msg.confidence, source: 'vision',
      });
      if (reading == null) {
        return { outbox: [wa.text(from, 'I could not read the meter in the photo. Could you type the reading? (just the number, e.g. 12345)')], action: 'unreadable' };
      }
      const lines = [
        `Electricity bill ${fmtDate(bill.period_from)} – ${fmtDate(bill.period_to)}.`,
        `I read on the meter: ${reading} kWh.`,
        cand.previous_reading != null ? `Previous: ${cand.previous_reading} → consumption ${cand.neighbor_kwh} kWh.` : null,
        ...cand.warnings.filter((w) => !/Could not read/.test(w)).map((w) => `⚠ ${w}`),
        'Is this correct?',
      ].filter(Boolean);
      return {
        outbox: [wa.buttons(from, lines.join('\n'), [
          { id: `ok|${bill.id}|${reading}`, title: 'Yes, correct' },
          { id: `no|${bill.id}`, title: 'No' },
        ])],
        action: 'candidate',
      };
    }

    if (msg.type === 'button') {
      const [kind, billId, reading] = String(msg.button_id ?? '').split('|');
      const bill = billId ? (() => { try { return svc.getBill(Number(billId)); } catch { return null; } })() : null;
      if (!bill) return { outbox: [], action: 'ignored' };
      if (kind === 'no') {
        return { outbox: [wa.text(from, 'OK. Please type the meter reading (just the number, e.g. 12345).')], action: 'asked_typed' };
      }
      if (kind === 'ok') {
        return confirmAndSend(bill, { reading: Number(reading), expectReading: Number(reading), source: 'vision' }, { from, role });
      }
      return { outbox: [], action: 'ignored' };
    }

    if (msg.type === 'text') {
      const text = String(msg.text ?? '').trim();
      if (role === 'yann') {
        const cmd = text.match(/^(reading|lectura|kwh)\s+(-?[\d.,]+)/i);
        if (cmd) {
          const bill = svc.openBill() ?? svc.latestBill();
          if (!bill) return { outbox: [wa.text(from, 'No bills yet.')], action: 'no_bill' };
          const n = parseReading(cmd[2]);
          const opts = cmd[1].toLowerCase() === 'kwh'
            ? { neighborKwh: n, source: 'override' }
            : { reading: n, source: 'override' };
          return confirmAndSend(bill, opts, { from, role });
        }
        if (/^(status|estado)/i.test(text)) {
          const bill = svc.openBill() ?? svc.latestBill();
          const status = bill ? `${bill.invoice_no} (${fmtDate(bill.period_from)} – ${fmtDate(bill.period_to)}): ${bill.status}. ${summary(bill.id)}` : 'No bills yet.';
          return { outbox: [wa.text(from, `${status} ${publicUrl}`)], action: 'status' };
        }
        // A bare number from Yann = the neighbor's meter reading (e.g. relayed from the neighbor)
        const typed = /^-?[\d.,]+$/.test(text) ? parseReading(text) : null;
        const open = typed != null ? svc.openBill() : null;
        if (open) return confirmAndSend(open, { reading: typed, source: 'typed' }, { from, role });
        return { outbox: [wa.text(from, HELP)], action: 'help' };
      }
      // Neighbor typing the reading (after "No", or instead of a photo)
      const n = parseReading(text);
      if (n == null) return { outbox: [], action: 'ignored' };
      const bill = svc.openBill();
      if (!bill) return { outbox: [wa.text(from, 'Thanks! There is no pending bill right now.')], action: 'no_open_bill' };
      return confirmAndSend(bill, { reading: n, source: 'typed' }, { from, role });
    }

    return { outbox: [], action: 'ignored' };
  }

  /** New Endesa email -> download + parse the bill -> ask the neighbor for the photo. */
  async function handleEndesaEmail({ html }) {
    if (!/factura de luz/i.test(html ?? '')) return { outbox: [], action: 'ignored_not_luz' };
    const link = extractDownloadLink(html);
    if (!link) return { outbox: toYann(`Endesa email without a download link. Create the bill by hand: ${publicUrl}/bills/new`), action: 'no_link' };
    try {
      const pdf = await downloadBillPdf(link, endesaNie, { fetchImpl });
      const parsed = parseEndesaBill(await pdfText(pdf));
      if (parsed.errors.length) {
        const pdfPath = svc.saveFile(pdf, 'pdf', 'bill-error');
        throw new HttpError(422, `${parsed.errors.join(' ')} (PDF saved: ${pdfPath})`);
      }
      const { bill, superseded } = svc.createBill({ parsed, pdfBuffer: pdf, source: 'auto' });
      const m = svc.message(bill.id);
      const outbox = [];
      if (m.neighbor?.wa_phone) outbox.push(wa.template(m.neighbor.wa_phone, TEMPLATES.requestReading, m.request_vars));
      const extra = superseded.length ? ` Bill ${superseded.map((b) => b.invoice_no).join(', ')} never got a reading and was replaced.` : '';
      outbox.push(...toYann(`New electricity bill ${bill.invoice_no} (${formatEur(bill.total_cents)}), asked the neighbor for the meter photo.${extra} ${m.url}`));
      return { outbox, bill_id: bill.id, action: 'bill_created' };
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) return { outbox: [], action: 'duplicate' };
      if (!(e instanceof HttpError || e instanceof EndesaError)) console.error(e);
      return { outbox: toYann(`Could not process the Endesa bill: ${e.message} Create it by hand: ${publicUrl}/bills/new`), action: 'error' };
    }
  }

  return { handleWhatsApp, handleEndesaEmail, splitOutbox };
}
