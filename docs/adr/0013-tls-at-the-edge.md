# 0013. TLS at the edge: Caddy in front of the API and the mock IdP

Status: Accepted (2026-11-13)

## Context

Clients send client secrets to the IdP and bearer tokens and invoices to the API. Until now the full compose stack served both over plain HTTP on `localhost:3000` and `localhost:4000`. Anything that carries credentials has to travel over TLS, and the stack the reviewers run should show how that is done, not just mention it.

In production, TLS usually ends at a load balancer or ingress in front of the service. The service itself keeps speaking plain HTTP on a private network. We want the local stack to look like that, without making the reviewer path harder: `docker compose --profile full up -d --wait`, `pnpm demo` and `pnpm e2e` must keep working with no manual certificate steps.

## Decision

- **A reverse proxy terminates TLS.** A new compose service `edge` runs Caddy (`caddy:2.11.7-alpine`, pinned and at least two weeks old) in profile `full`.
  - `https://localhost:3443` goes to the API and `https://localhost:4443` to the mock IdP.
  - The `api` and `mock-idp` services publish no host ports any more. The edge is the only way in.
  - The Node processes keep listening on plain HTTP inside the compose network.
- **Certificates come from Caddy's local CA.**
  - Its root certificate and key live in the `edge-data` volume. They survive restarts, and `docker compose down --volumes` creates a new CA.
  - `scripts/tls/edge-ca.sh` (`pnpm tls:ca`) reads the root certificate from the running edge and writes it to `.tls/edge-root-ca.crt` (gitignored).
  - `pnpm demo` and `pnpm e2e` run through that script, which exports a fresh copy and trusts it with `NODE_EXTRA_CA_CERTS`. The curl examples use `--cacert`.
  - Nothing switches certificate verification off: no `-k`, no `NODE_TLS_REJECT_UNAUTHORIZED=0`, no `rejectUnauthorized: false`. The CA is added to the trusted roots, and only for that command. Caddy does not install it into any trust store (`skip_install_trust`).
- **No plain HTTP and no redirect.**
  - The edge has no listener on port 80 (`auto_https disable_redirects`).
  - A plain HTTP request to 3443 or 4443 gets `400 Client sent an HTTP request to an HTTPS server` from the edge, and the request never reaches the service.
  - A redirect to HTTPS would not help an API. By the time the client gets the redirect, it has already sent its client secret or bearer token in clear text. A browser follows the redirect and the user sees nothing wrong, but a machine client could just as easily keep using the wrong URL. A request that fails tells the integrator to fix the URL before any secret has been sent.
- **Tokens and issuer.**
  - `AUTH_ISSUER` is `https://localhost:4443`, the URL clients use to get tokens. The API only compares it as a string.
  - The API keeps fetching the signing keys inside the network (`http://mock-idp:4000/.well-known/jwks.json`).
  - In production, the JWKS comes from the real IdP over HTTPS. A JWKS fetched over plain HTTP outside a private network could be swapped, and then any token would pass.
- **Behind the proxy.**
  - The API trusts exactly one proxy hop (`TRUST_PROXY`, off by default and `true` in compose). Express then takes the client address and the scheme from the `X-Forwarded-For` and `X-Forwarded-Proto` entries that the edge added. A client cannot pick its own address by sending `X-Forwarded-For`; that would otherwise reset the rate limiter's per-IP fallback with every request.
  - Caddy does not trust incoming `X-Forwarded-*` headers either. It sets them from the connection it accepted.
  - HSTS comes from the API (helmet: `max-age=31536000; includeSubDomains`) and the e2e tests check it.
  - The edge limits request bodies to 1100 KiB, just above the API's own 1 MiB, as defence in depth. The API's limit stays the one clients normally hit, because it answers with Problem Details (`PAYLOAD_TOO_LARGE`).
- **The edge is hardened like the other services.**
  - Read-only root filesystem: only `/data` (the CA and certificates) is writable, and the Caddyfile is mounted read-only.
  - The admin API is off (`admin off`), so there is nothing to publish or protect. A configuration change means a restart.
  - Only HTTP/1.1 and HTTP/2 are enabled, because HTTP/3 would need UDP ports.
  - No access log. Caddy's error log redacts the `Authorization` header.
  - The healthcheck makes a verified HTTPS request to both ports with the edge's own root (`curl --cacert`), so `up --wait` only returns once the certificates are issued and verifiable.
- **Internal traffic stays plain inside the network.**
  - This covers Postgres, RabbitMQ, the JWKS fetch and the edge-to-service hop.
  - In production, all of them use TLS as well: `sslmode=verify-full` for Postgres, `amqps` for RabbitMQ, the IdP's HTTPS JWKS, and TLS or a service mesh between the load balancer and the service.
- **Local development stays plain HTTP on the loopback interface.** `pnpm infra:up` starts only Postgres and RabbitMQ, and the API (port 3000) and mock IdP (port 4000) run natively with Node, with `AUTH_ISSUER=http://localhost:4000` from `.env.example`. Adding a proxy and a CA there would slow down the edit-run loop and protect nothing.

## Alternatives considered

- **TLS in Node** (`https.createServer` with a certificate). This needs no extra container. But certificate loading, rotation and TLS settings would live in our code and in two processes, and production would end TLS at the load balancer anyway. With the proxy, the services stay the same in every environment.
- **Traefik or nginx as the proxy.** Both would work. Caddy has its own CA and issues certificates for `localhost` without any extra tool (no mkcert, no OpenSSL script), and its configuration fits in about 40 readable lines. nginx would need certificates generated beforehand. Traefik's strength is discovery through Docker labels, which a fixed stack of two routes does not need.
- **mTLS for B2B clients.** Client certificates give strong machine identity, and Peppol access points use them between each other. But clients would have to manage certificates, and it would replace or duplicate the OAuth2 client credentials from ADR 0008. It stays a follow-up: the edge is the place where it would be added.
- **A redirect from HTTP to HTTPS.** Rejected, see above. It suits browsers, not API clients that send credentials with their first request.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0` or `curl -k` in the demo.** Rejected. It is easy to copy, and it would test nothing: the e2e tests show that verification fails without the exported CA.

## Consequences

- The demo, the e2e tests and the curl examples use HTTPS with a verified certificate. The CA is exported automatically on every `pnpm demo` and `pnpm e2e` run, so the reviewer path has no manual steps.
- A client that does not use the exported CA gets a certificate error. That is the intent. Browsers show a warning for Swagger UI at `https://localhost:3443/docs` unless the root is trusted in the system or browser.
- Firefox, and Chrome since version 132, ignore HSTS for `localhost`. Other browsers may remember it for every port on `localhost`, including the RabbitMQ management UI on 15672, which is plain HTTP.
- An extra container uses about 20 MB of memory.
- The ports are fixed at 3443 and 4443 because the issuer contains the IdP's URL. Changing them means changing `AUTH_ISSUER` in compose too.
- The rate limiter's IP fallback sees the real client address behind the edge, instead of the edge's own address for every client.

## Evidence

- `apps/service/test/e2e/tls.e2e.spec.ts` covers four things:
  - both endpoints answer over HTTPS with a certificate issued by Caddy's local CA;
  - verification fails without that CA (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`);
  - plain HTTP gets a 400 without a `Location` header;
  - only the edge publishes ports, and responses carry `Strict-Transport-Security`.
- `apps/service/src/shared/http/http-app.spec.ts` checks that a spoofed `X-Forwarded-For` is ignored by default, and that with `TRUST_PROXY` only the address the proxy added counts.

## Follow-ups

- Production: TLS at the load balancer or ingress with a public certificate, and TLS to Postgres, RabbitMQ and the IdP.
- mTLS for B2B clients, if partners ask for it.
- Upgrade Caddy to 2.11.9 once it is two weeks old. Its security fixes are mostly for FastCGI, which we do not use.
