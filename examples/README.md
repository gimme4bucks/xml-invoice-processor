# Examples and quick start

## Quick start

Needs Docker (with Compose v2), Node 22 and pnpm (Corepack).

```bash
pnpm install
docker compose --profile full up -d --build --wait   # Postgres, RabbitMQ, migrations, API, worker, mock IdP, HTTPS edge
pnpm demo                                            # the scenarios below, against the running stack
pnpm e2e                                             # end-to-end tests, including RabbitMQ and Postgres outages
docker compose --profile full down --volumes         # stop and remove the data
```

- The API is reachable on <https://localhost:3443> (OpenAPI and Swagger UI at
  <https://localhost:3443/docs>) and the mock IdP on <https://localhost:4443>, both through the
  HTTPS edge (Caddy, [ADR 0013](../docs/adr/0013-tls-at-the-edge.md)). Plain HTTP is refused.
- `pnpm demo` and `pnpm e2e` trust the edge's root certificate by themselves; `pnpm tls:ca`
  exports it to `.tls/edge-root-ca.crt` for other clients, such as curl below.
- Compose reads an optional `.env` in the repository root (copy `.env.example`) for its settings.
- `pnpm e2e` stops RabbitMQ (`docker kill`) and freezes Postgres (`docker pause`) for a moment and
  brings them back itself.

## The demo stack

The compose defaults are tuned so that the interesting paths show up in a few seconds:

| Setting                             | Value            | Effect                                                                                                                    |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `VIES_UNAVAILABLE_TIMES_PER_NUMBER` | `2`              | The fake VIES fails the first two checks of every VAT number it has not seen, so each new counterparty shows two retries. |
| `VIES_INVALID_VAT_NUMBERS`          | `NL999999999B99` | VIES reports this number as non-existent: the document fails for good.                                                    |
| `RETRY_DELAYS_MS`                   | `1000,2000,5000` | TTLs of the retry delay queues (production default: 5 s, 30 s, 2 min).                                                    |
| `RATE_LIMIT_PER_MINUTE`             | `600`            | Per organisation; room for the demo and the tests to poll.                                                                |

Two demo clients exist in the mock IdP, both with the secret `change-me`:

| Client            | `org_id`       | `peppol_id`     | On the example invoices                                         |
| ----------------- | -------------- | --------------- | --------------------------------------------------------------- |
| `supplier-client` | `org-supplier` | `0106:11111111` | supplier of `valid-sales.xml`, customer of `valid-purchase.xml` |
| `customer-client` | `org-customer` | `0106:22222222` | customer of `valid-sales.xml`                                   |

## Example invoices

All written for this project (Peppol BIS Billing 3.0, UBL 2.1). Outcomes when `supplier-client`
submits them:

| File                              | Outcome                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `invoices/valid-sales.xml`        | 202, then `Completed` (direction `sales`)                                       |
| `invoices/valid-purchase.xml`     | 202, then `Completed` (direction `purchase`)                                    |
| `invoices/bad-totals.xml`         | 202, then `Failed`: `BUSINESS_RULES_VIOLATED` with BR-CO-10, BR-CO-13, BR-CO-16 |
| `invoices/missing-issue-date.xml` | 422 `DOCUMENT_REJECTED`, reason `schema-invalid` (UBL 2.1 XSD)                  |
| `invoices/credit-note.xml`        | 422 `DOCUMENT_REJECTED`, reason `unsupported-document-type`                     |
| `invoices/doctype-xxe.xml`        | 422 `DOCUMENT_REJECTED`, reason `doctype-forbidden` (never resolved)            |

A file can be accepted once per organisation: sending the same bytes again under a new
`Idempotency-Key` is a 409 `DUPLICATE_DOCUMENT`. Change the invoice number (the first `cbc:ID`)
to submit it again. `pnpm demo` does that for you on every run.

## By hand with curl

From the repository root, with the stack running. `--cacert` makes curl verify the edge's
certificate against its exported root; never use `-k`, which turns verification off.

```bash
CA=$(pnpm -s tls:ca)   # .tls/edge-root-ca.crt, exported from the running edge

TOKEN=$(curl -s --cacert "$CA" -u supplier-client:change-me -d grant_type=client_credentials \
  https://localhost:4443/token | jq -r .access_token)

curl -i --cacert "$CA" https://localhost:3443/documents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/xml' \
  --data-binary @examples/invoices/valid-sales.xml
# 202 Accepted, Location: /documents/<id>

ID=<id from the response>
curl -s --cacert "$CA" https://localhost:3443/documents/$ID -H "Authorization: Bearer $TOKEN" | jq          # status
curl -s --cacert "$CA" https://localhost:3443/documents/$ID/history -H "Authorization: Bearer $TOKEN" | jq  # events
curl -s --cacert "$CA" https://localhost:3443/documents/$ID/result -H "Authorization: Bearer $TOKEN" | jq   # result
curl -s --cacert "$CA" 'https://localhost:3443/documents?status=Failed' -H "Authorization: Bearer $TOKEN" | jq
```

Errors are RFC 9457 Problem Details (`application/problem+json`) with a stable `code`; the
catalogue is in the OpenAPI description.
