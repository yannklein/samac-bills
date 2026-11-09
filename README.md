# Samac bills

Splits the shared Endesa electricity bill between our apartment and the neighbor's, and between
Marcela (1/3) and Yann & Adriana (2/3). Everyone pays Yann (the bill is debited from his account).

```
Endesa email ──► n8n (IMAP) ──► app: download PDF (NIE) + parse ──► WhatsApp template to neighbor
neighbor photo ──► n8n (WhatsApp Trigger + Claude reads meter) ──► app ──► "I read 12445 kWh, correct?" [Yes] [No]
[Yes] ──► app computes split ──► WhatsApp template to all 4 ──► samac-bills.yannklein.dev (breakdown + evidence)
```

- **App** (this repo): Node 24 + Express + SQLite. Source of truth for bills, readings, evidence (PDF + meter
  photos), the split, the web UI, and all WhatsApp conversation logic. It returns an *outbox* of Graph API
  payloads; n8n only sends them.
- **n8n** (folder *Samac bills* on n8n.yannklein.dev): `Samac · Luz · New bill`, `Samac · WhatsApp inbound`,
  `Samac · Send split (manual)`.

## How the split works

| Bill line | Split |
|---|---|
| Power (Potencia), social bonus financing (Bono social), meter rental (Alquiler contador) | 50/50 |
| Energy (Energía), discount (Descuento) | by kWh: neighbor kWh = this meter reading − previous reading |
| Electricity tax (Impuesto electricidad), VAT (IVA) | by the ratio of each side's pre-tax subtotal |

Neighbor total is rounded to the cent; **home = invoice total − neighbor**, so it always reconciles.
Marcela = home / 3, Yann & Adriana = the rest. Every column of the breakdown adds up exactly.

Example (Oct 2026, €70.48, neighbor 100 of 233.251 kWh): neighbor €32.28 · Marcela €12.73 · Yann & Adriana €25.47.

Unknown bill lines (a new service, a rectified bill) or line items not adding up to the total stop the
automation and notify Yann; create it by hand at `/bills/new` (upload PDF → fix/classify lines → reading → save).

## WhatsApp conversation

| Who | Sends | Reply |
|---|---|---|
| Neighbor | photo (or photo as document) | "I read on the meter: N kWh … Is this correct?" [Yes, correct] [No] |
| Neighbor | [Yes, correct] | split template to all 4 |
| Neighbor | [No] / unreadable photo | "Please type the meter reading" → typed number → split |
| Neighbor | implausible reading | "Yann will check the reading" + notice to Yann |
| Yann | `reading 12345` / `kwh 100` | override (any state, also after sending) → split to all 4 |
| Yann | `status` | status of the latest bill |
| Yann | forwarded meter photo | same as the neighbor's photo, buttons go to Yann |
| Anyone | `delete my data` | acknowledgement + notice to Yann (privacy policy promise) |

Stale or double button taps are rejected. Delivery failures notify Yann (except failures to Yann himself).

## Development

```sh
npm install
npm test                                   # parser, split, API, conversation tests
DATA_DIR=./data node scripts/seed.js people.example.json
PORT=3077 API_TOKEN=dev npm run dev        # http://localhost:3077 as admin; ?as=marcela@example.com to view as someone else
node scripts/extract-text.js some.pdf      # see the text the parser gets
```

Real bills/emails go in `fixtures/` (gitignored, they contain NIE/IBAN); the tests that need them are skipped
when they're absent. `test/fixtures/` only holds the sanitized detail lines.

## Setup (once)

1. **Meta / WhatsApp** (developers.facebook.com):
   1. Create a new app *Samac bills* (type Business) → add **WhatsApp**. Note the **test phone number ID**.
   2. Add the 4 phone numbers to the test number's recipient list (each confirms a code).
   3. Business Settings → System users → create one, assign the app + the test WhatsApp account with
      `whatsapp_business_messaging` + `whatsapp_business_management` → generate a **permanent token**.
      (If the test WABA can't be assigned, only 24 h tokens exist: stop and rethink.)
   4. WhatsApp Manager → Message templates → create the 3 templates below (category **Utility**, language
      **Spanish (es)**) with sample values. Wait for approval.
   5. Each of the 4 people sends "hola" to the test number once and saves the contact.
2. **App on Coolify**: new resource from this repo (Dockerfile), persistent volume on `/data`, env from
   `.env.example`, domain `samac-bills.yannklein.dev`. Then seed people (names, WhatsApp numbers with country code,
   emails) and the last known neighbor reading:
   `docker exec -i <container> node scripts/seed.js /dev/stdin < people.json`
3. **Cloudflare**: tunnel public hostname `samac-bills.yannklein.dev` → the app. Zero Trust → Access → Applications:
   - `samac-bills.yannklein.dev` — policy *Allow* emails of the 4 people (one-time PIN). Copy the **AUD** tag into
     `CF_ACCESS_AUD`.
   - `samac-bills.yannklein.dev/api` — policy *Bypass* Everyone (the API has its own bearer token).
   - Check WAF / Bot Fight Mode doesn't challenge `n8n.yannklein.dev/webhook/*` (Meta must reach it).
4. **iCloud**: appleid.apple.com → app-specific password for n8n.
5. **n8n credentials** (then open each workflow and select them):
   - *iCloud IMAP*: `imap.mail.me.com`, port 993, SSL, user `yann.klein@me.com`, the app-specific password.
   - *Samac bills API token* (custom auth template): header `Authorization: Bearer <API_TOKEN>`.
   - *Samac WhatsApp Cloud API token* (custom auth template): header `Authorization: Bearer <System User token>`.
   - *Samac Meta app (WhatsApp Trigger)*: App ID + App Secret of the Samac app.
   - *Samac webhook token*: header auth, name `X-Samac-Token`, value = `N8N_WEBHOOK_TOKEN`.
   - *Read meter with Claude* already uses the existing *Anthropic account*.
6. Activate the 3 workflows (activating the WhatsApp Trigger registers the webhook with Meta).

### Templates

Create them in WhatsApp Manager → Message templates: category **Utility**, language **English** (code `en`,
not "English (US)"; or set `WA_TEMPLATE_LANG` to the code you picked), variable type **Number**,
no header/footer/buttons. Names must match exactly.

`samac_request_reading` (samples: Pepe · 07/10/2026 · 01/11/2026)
> Hi {{1}}, the electricity bill for {{2}} to {{3}} has arrived. Could you send me a photo of your electricity meter here? Thanks!

`samac_split` (samples: P26CON046489044 · 07/10/2026 · 01/11/2026 · 70.48 · 100 · 32.28 · 12.73 · 25.47 · https://samac-bills.yannklein.dev/bills/1)
> Electricity bill {{1}}, from {{2}} to {{3}}, total €{{4}}. The neighbor used {{5}} kWh and pays €{{6}} to Yann. Marcela pays €{{7}} to Yann (1/3 of home). Yann and Adriana pay €{{8}} (2/3 of home). Breakdown and evidence: {{9}} . Thanks!

`samac_notice` (sample: New electricity bill received)
> Samac bills notice: {{1}}. Check the app if needed.

## First live run checklist

- Before activating, replay the bill download once by hand to confirm Endesa needs no cookies (this stores
  the bill in the app; the email workflow will then treat that email as a duplicate):
  `curl -s -X POST -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' -d '{"link":"<DESCARGAR FACTURA href from a fresh email>"}' https://samac-bills.yannklein.dev/api/endesa/fetch`
- While testing, put **Yann's number as the neighbor** in `people.json`, re-seed, and play the neighbor.
