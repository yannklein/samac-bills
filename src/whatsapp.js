// Builders for WhatsApp Cloud API (Graph) message payloads.
// The app returns an "outbox" of { url, body } items; n8n POSTs each one with the bearer token.

export function makeWhatsApp({ phoneNumberId, graphVersion = 'v27.0', lang = 'es' }) {
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId || 'WA_PHONE_NUMBER_ID'}/messages`;
  const wrap = (to, payload) => ({ url, body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to), ...payload } });

  return {
    /** Free-form text: only valid inside the 24h window (i.e. replying to someone who just wrote). */
    text: (to, body) => wrap(to, { type: 'text', text: { body: body.slice(0, 4096), preview_url: false } }),

    /** Reply buttons (max 3, title ≤ 20 chars, id ≤ 256 chars). Also 24h-window only. */
    buttons: (to, body, buttons) => wrap(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    }),

    /** Approved template: the only way to start a conversation (business-initiated). */
    template: (to, name, vars = []) => wrap(to, {
      type: 'template',
      template: {
        name,
        language: { code: lang },
        components: vars.length
          ? [{ type: 'body', parameters: vars.map((v) => ({ type: 'text', text: sanitizeVar(v) })) }]
          : [],
      },
    }),
  };
}

/** Template variables may not contain newlines, tabs or more than 4 consecutive spaces. */
export function sanitizeVar(v) {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  return s || '-';
}

export const TEMPLATES = {
  requestReading: 'samac_luz_pedir_lectura', // {{1}} name, {{2}} from, {{3}} to
  split: 'samac_luz_reparto', // 9 vars, see service.message().split_vars
  notice: 'samac_aviso', // {{1}} free text
};
