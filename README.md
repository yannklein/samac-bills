# Samac bills

Splits the shared Endesa electricity bill between our apartment and the neighbor's, and between
Marcela (1/3) and Yann & Adriana (2/3). Everyone pays Yann (the bill is debited from his account).

```
Endesa email ──► n8n (IMAP) ──► app: download PDF (NIE) + parse ──► WhatsApp template to neighbor
neighbor photo ──► n8n (WhatsApp Trigger + Claude reads meter) ──► app ──► "Leo 12445 kWh, ¿correcto?" [Sí] [No]
[Sí] ──► app computes split ──► WhatsApp template to all 4 ──► bills.yannklein.dev (breakdown + evidence)
```

- **App** (this repo): Node 24 + Express + SQLite. Source of truth for bills, readings, evidence (PDF + meter
  photos), the split, the web UI, and all WhatsApp conversation logic. It returns an *outbox* of Graph API
  payloads; n8n only sends them.
- **n8n** (folder *Samac bills* on n8n.yannklein.dev): `Samac · Luz · New bill`, `Samac · WhatsApp inbound`,
  `Samac · Send split (manual)`.

## How the split works

| Bill line | Split |
|---|---|
| Potencia, Bono social, Alquiler contador | 50/50 |
| Energía, Descuento | by kWh: neighbor kWh = this meter reading − previous reading |
| Impuesto electricidad, IVA | by the ratio of each side's pre-tax subtotal |

Neighbor total is rounded to the cent; **home = invoice total − neighbor**, so it always reconciles.
Marcela = home / 3, Yann & Adriana = the rest. Every column of the breakdown adds up exactly.

Example (Oct 2026, 70,48 €, neighbor 100 of 233,251 kWh): neighbor 32,28 € · Marcela 12,73 € · Yann & Adriana 25,47 €.

Unknown bill lines (a new service, a rectified bill) or line items not adding up to the total stop the
automation and notify Yann; create it by hand at `/bills/new` (upload PDF → fix/classify lines → reading → save).

## WhatsApp conversation

| Who | Sends | Reply |
|---|---|---|
| Neighbor | photo (or photo as document) | "Leo N kWh … ¿Es correcto?" [Sí] [No] |
| Neighbor | [Sí] | split template to all 4 |
| Neighbor | [No] / unreadable photo | "Escríbeme la lectura" → typed number → split |
| Neighbor | implausible reading | "Yann revisará" + notice to Yann |
| Yann | `lectura 12345` / `kwh 100` | override (any state, also after sending) → split to all 4 |
| Yann | `estado` | status of the latest bill |
| Yann | forwarded meter photo | same as the neighbor's photo, buttons go to Yann |

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
   `.env.example`, domain `bills.yannklein.dev`. Then seed people (names, WhatsApp numbers with country code,
   emails) and the last known neighbor reading:
   `docker exec -i <container> node scripts/seed.js /dev/stdin < people.json`
3. **Cloudflare**: tunnel public hostname `bills.yannklein.dev` → the app. Zero Trust → Access → Applications:
   - `bills.yannklein.dev` — policy *Allow* emails of the 4 people (one-time PIN). Copy the **AUD** tag into
     `CF_ACCESS_AUD`.
   - `bills.yannklein.dev/api` — policy *Bypass* Everyone (the API has its own bearer token).
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

`samac_luz_pedir_lectura`
> Hola {{1}}, ha llegado la factura de luz del {{2}} al {{3}}. ¿Me envías una foto de tu contador de luz por aquí? ¡Gracias!

`samac_luz_reparto`
> Factura de luz {{1}}, del {{2}} al {{3}}, total {{4}} €. El vecino consumió {{5}} kWh y paga {{6}} € a Yann. Marcela paga {{7}} € a Yann (1/3 de casa). Yann y Adriana pagan {{8}} € (2/3 de casa). Detalle y justificantes en {{9}} . Gracias.

`samac_aviso`
> Aviso de Samac bills: {{1}}. Revisa la app si hace falta.

## First live run checklist

- Before activating, replay the bill download once by hand to confirm Endesa needs no cookies (this stores
  the bill in the app; the email workflow will then treat that email as a duplicate):
  `curl -s -X POST -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' -d '{"link":"<DESCARGAR FACTURA href from a fresh email>"}' https://bills.yannklein.dev/api/endesa/fetch`
- While testing, put **Yann's number as the neighbor** in `people.json`, re-seed, and play the neighbor.
