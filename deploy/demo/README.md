# Runbook: the public demo

The full stack on one public server, behind real hostnames with Let's Encrypt certificates
([ADR 0019](../../docs/adr/0019-public-demo.md)):

| What                    | URL                                  |
| ----------------------- | ------------------------------------ |
| Support app             | `https://demo.huizeblok.nl`          |
| API with the Swagger UI | `https://api.demo.huizeblok.nl/docs` |
| Mock IdP (token, login) | `https://idp.demo.huizeblok.nl`      |

The hostnames are settings (`DEMO_WEB_HOST`, `DEMO_API_HOST`, `DEMO_IDP_HOST` in
`deploy/demo/.env`); the ones above are the defaults of `.env.example`. The server pulls the
published images of `TAG` and never builds. Only port 443 is open: the API, the IdP and the
support app all sit behind the edge, and Postgres, RabbitMQ and the S3 gateway have no host port.

Every command below runs on the server, as a user in the `docker` group, from a checkout of the
repository at the tag you deploy.

## 0. Before you start

- **DNS:** an A record (and AAAA, if the server has IPv6) for each of the three hostnames, pointing
  to the server. Check with `dig +short api.demo.huizeblok.nl` before starting the edge: Let's
  Encrypt validates each hostname as soon as the edge starts.
- **The image tag:** a release that contains the Swagger login and `MOCK_IDP_CORS_ORIGINS`
  (1.2.0 or later).

## 1. Install Docker (Ubuntu 24.04)

Docker's own apt repository ([docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/)):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"   # log out and in again
docker compose version             # v2.24 or later (`!reset` and `!override`)
```

## 2. Open the firewall: 443 only

The certificates come over the TLS-ALPN challenge on port 443, so port 80 stays closed.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 443/tcp
sudo ufw enable
```

Docker publishes ports with its own iptables rules, past ufw. That is why the compose override
removes every host port except the edge's 443, instead of relying on the firewall. In the Hetzner
Cloud firewall (if you use one), allow 22 and 443/tcp inbound and nothing else.

## 3. Check out the repository and generate the secrets

```bash
git clone https://github.com/gimme4bucks/xml-invoice-processor.git
cd xml-invoice-processor
git checkout v1.2.0                     # the release you deploy
TAG=1.2.0 ACME_EMAIL=you@example.com sh deploy/demo/generate-env.sh
```

`generate-env.sh` writes `deploy/demo/.env` (mode 600, gitignored) with a random value for every
password and client secret. It never overwrites an existing file. Edit the hostnames there if they
differ. The secrets stay on the server; read the ones the testers need with
`grep -E '^DEMO_(SUPPLIER|CUSTOMER)_SECRET|^DEMO_SUPPORT_PASSWORD' deploy/demo/.env` and hand them
over through a private channel.

Optional dry run without Let's Encrypt's rate limits: set
`ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory` first. Browsers do not trust the
staging certificates (and the edge stays unhealthy), so set it back and remove the volume
(`down --volumes`) before the real run.

## 4. Pull and start

```bash
demo() { docker compose --env-file deploy/demo/.env -f docker-compose.yml -f deploy/demo/compose.yml --profile full "$@"; }
demo config --quiet                     # fails with a message if a secret or hostname is missing
demo pull
demo up -d --no-build --wait            # returns once every service is healthy, the edge after its certificates
demo ps
demo logs edge | grep -i 'certificate obtained'
curl -fsS https://api.demo.huizeblok.nl/health
```

The edge's healthcheck makes a verified HTTPS request to each host, so `--wait` only returns once
the three certificates are issued (usually under a minute). If it times out, read
`demo logs edge`: a wrong DNS record or a closed port 443 shows up there as a failed challenge.

## 5. Seed and check with `pnpm demo`

From a laptop with a checkout of the same tag (Node 22, `pnpm install`), not from the server:

```bash
API_BASE_URL=https://api.demo.huizeblok.nl \
IDP_BASE_URL=https://idp.demo.huizeblok.nl \
DEMO_SUPPLIER_SECRET=… DEMO_CUSTOMER_SECRET=… \
pnpm demo
```

With a public `API_BASE_URL`, `pnpm demo` trusts the public CAs and needs no local stack. It
submits the demo documents (valid, invalid VAT, broken totals, duplicates, a credit note) and
exits non-zero when an outcome differs. Run it once before the demo, so that the support app and
the lists have something to show.

## 6. What the testers do

- **Swagger UI** at `https://api.demo.huizeblok.nl/docs`: **Authorize**, then under
  `client-credentials` the client id `supplier-client` (or `customer-client`) and its secret. Swagger
  UI fetches the token from the IdP, and **Try it out** on `POST /documents` submits an invoice
  (for example one from `examples/`).
- **Support app** at `https://demo.huizeblok.nl`: sign in as `support-agent` with
  `DEMO_SUPPORT_PASSWORD`.

## 7. Tear down

```bash
demo down --volumes                     # stops everything and deletes the data and the certificates
rm deploy/demo/.env
```

Then delete the server (and its DNS records) in the Hetzner console. Do not start and stop it
repeatedly with `--volumes` in between: every new start requests new certificates, and Let's
Encrypt allows five per set of hostnames per week.
