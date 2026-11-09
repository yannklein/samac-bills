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

const esDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const HELP = 'Comandos: "lectura 12345" (lectura del contador del vecino), "kwh 100" (kWh del vecino directamente), "estado".';

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
      ? `${d.bill.invoice_no}: vecino ${s.neighbor_kwh} kWh → ${formatEur(s.neighbor_cents)}, Marcela ${formatEur(s.marcela_cents)}, Yann y Adriana ${formatEur(s.yann_adriana_cents)}.`
      : `${d.bill.invoice_no}: sin reparto todavía.`;
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
          wa.text(from, 'Gracias, Yann revisará la lectura antes de enviar el reparto.'),
          ...toYann(`Revisa la factura ${bill.invoice_no}: ${e.message} Responde "lectura N" o "kwh N" para forzar. ${publicUrl}/bills/${bill.id}`, role),
        ],
        action: 'needs_review',
      };
    }
    const outbox = splitOutbox(bill.id);
    if (role === 'yann' && opts.source === 'override') outbox.unshift(wa.text(from, `Recalculado. ${summary(bill.id)} Enviando a todos.`));
    return { outbox, mark_sent_bill_id: bill.id, action: 'split_sent' };
  }

  function handleWhatsApp(msg) {
    const from = String(msg.from ?? '').replace(/\D/g, '');
    const role = svc.roleByPhone(from);

    if (msg.type === 'status_failed') {
      const failedRole = svc.roleByPhone(msg.recipient);
      // Never notify Yann about a failed notification to Yann (would loop).
      if (failedRole === 'yann' || !people().yann) return { outbox: [], action: 'ignored' };
      return { outbox: toYann(`No se pudo entregar un WhatsApp a ${failedRole ?? msg.recipient}: ${msg.error ?? 'error desconocido'}`), action: 'failure_notice' };
    }
    if (role && role !== 'yann' && msg.type === 'text' && /borrar mis datos/i.test(msg.text ?? '')) {
      return {
        outbox: [
          wa.text(from, 'Recibido. Yann borrará tus datos en un plazo de 30 días.'),
          ...toYann(`${people()[role]?.name ?? role} pide borrar sus datos (política de privacidad).`, role),
        ],
        action: 'deletion_request',
      };
    }
    if (!role || role === 'adriana' || role === 'marcela') return { outbox: [], action: 'ignored' };

    // Meter photo (from the neighbor, or forwarded by Yann)
    if (msg.type === 'image') {
      const bill = svc.openBill();
      if (!bill) {
        if (role === 'yann') return { outbox: [wa.text(from, 'No hay ninguna factura esperando lectura.')], action: 'no_open_bill' };
        return {
          outbox: [
            wa.text(from, 'Gracias. Aún no ha llegado la factura de luz; te aviso cuando llegue.'),
            ...toYann('El vecino ha enviado una foto del contador pero no hay factura pendiente.', role),
          ],
          action: 'no_open_bill',
        };
      }
      const reading = Number.isFinite(msg.reading) ? msg.reading : null;
      const cand = svc.addCandidate(bill.id, {
        reading, photoBuffer: msg.photoBuffer, photoExt: msg.photoExt, confidence: msg.confidence, source: 'vision',
      });
      if (reading == null) {
        return { outbox: [wa.text(from, 'No he podido leer el contador en la foto. ¿Me escribes la lectura? (solo el número, p. ej. 12345)')], action: 'unreadable' };
      }
      const lines = [
        `Factura de luz ${esDate(bill.period_from)} – ${esDate(bill.period_to)}.`,
        `Leo en el contador: ${reading} kWh.`,
        cand.previous_reading != null ? `Anterior: ${cand.previous_reading} → consumo ${cand.neighbor_kwh} kWh.` : null,
        ...cand.warnings.filter((w) => !/No se pudo leer/.test(w)).map((w) => `⚠ ${w}`),
        '¿Es correcto?',
      ].filter(Boolean);
      return {
        outbox: [wa.buttons(from, lines.join('\n'), [
          { id: `ok|${bill.id}|${reading}`, title: 'Sí, correcto' },
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
        return { outbox: [wa.text(from, 'Vale. Escríbeme la lectura del contador (solo el número, p. ej. 12345).')], action: 'asked_typed' };
      }
      if (kind === 'ok') {
        return confirmAndSend(bill, { reading: Number(reading), expectReading: Number(reading), source: 'vision' }, { from, role });
      }
      return { outbox: [], action: 'ignored' };
    }

    if (msg.type === 'text') {
      const text = String(msg.text ?? '').trim();
      if (role === 'yann') {
        const cmd = text.match(/^(lectura|kwh)\s+(-?[\d.,]+)/i);
        if (cmd) {
          const bill = svc.openBill() ?? svc.latestBill();
          if (!bill) return { outbox: [wa.text(from, 'No hay facturas.')], action: 'no_bill' };
          const n = parseReading(cmd[2]);
          const opts = cmd[1].toLowerCase() === 'kwh'
            ? { neighborKwh: n, source: 'override' }
            : { reading: n, source: 'override' };
          return confirmAndSend(bill, opts, { from, role });
        }
        if (/^estado/i.test(text)) {
          const bill = svc.openBill() ?? svc.latestBill();
          const status = bill ? `${bill.invoice_no} (${esDate(bill.period_from)} – ${esDate(bill.period_to)}): ${bill.status}. ${summary(bill.id)}` : 'No hay facturas.';
          return { outbox: [wa.text(from, `${status} ${publicUrl}`)], action: 'status' };
        }
        return { outbox: [wa.text(from, HELP)], action: 'help' };
      }
      // Neighbor typing the reading (after "No", or instead of a photo)
      const n = parseReading(text);
      if (n == null) return { outbox: [], action: 'ignored' };
      const bill = svc.openBill();
      if (!bill) return { outbox: [wa.text(from, 'Gracias. No hay ninguna factura pendiente ahora mismo.')], action: 'no_open_bill' };
      return confirmAndSend(bill, { reading: n, source: 'typed' }, { from, role });
    }

    return { outbox: [], action: 'ignored' };
  }

  /** New Endesa email -> download + parse the bill -> ask the neighbor for the photo. */
  async function handleEndesaEmail({ html }) {
    if (!/factura de luz/i.test(html ?? '')) return { outbox: [], action: 'ignored_not_luz' };
    const link = extractDownloadLink(html);
    if (!link) return { outbox: toYann(`Email de Endesa sin enlace de descarga. Crea la factura a mano: ${publicUrl}/bills/new`), action: 'no_link' };
    try {
      const pdf = await downloadBillPdf(link, endesaNie, { fetchImpl });
      const parsed = parseEndesaBill(await pdfText(pdf));
      if (parsed.errors.length) {
        const pdfPath = svc.saveFile(pdf, 'pdf', 'factura-error');
        throw new HttpError(422, `${parsed.errors.join(' ')} (PDF guardado: ${pdfPath})`);
      }
      const { bill, superseded } = svc.createBill({ parsed, pdfBuffer: pdf, source: 'auto' });
      const m = svc.message(bill.id);
      const outbox = [];
      if (m.neighbor?.wa_phone) outbox.push(wa.template(m.neighbor.wa_phone, TEMPLATES.requestReading, m.request_vars));
      const extra = superseded.length ? ` La factura ${superseded.map((b) => b.invoice_no).join(', ')} quedó sin lectura y se ha sustituido.` : '';
      outbox.push(...toYann(`Nueva factura de luz ${bill.invoice_no} (${formatEur(bill.total_cents)}), pedida la foto al vecino.${extra} ${m.url}`));
      return { outbox, bill_id: bill.id, action: 'bill_created' };
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) return { outbox: [], action: 'duplicate' };
      if (!(e instanceof HttpError || e instanceof EndesaError)) console.error(e);
      return { outbox: toYann(`No pude procesar la factura de Endesa: ${e.message} Créala a mano: ${publicUrl}/bills/new`), action: 'error' };
    }
  }

  return { handleWhatsApp, handleEndesaEmail, splitOutbox };
}
