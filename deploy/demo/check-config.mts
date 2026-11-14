/**
 * The scripted check of the public demo deployment (ADR 0019). Let's Encrypt cannot be reached
 * from a laptop or CI, so this checks what can be checked without it, on the configuration that
 * `docker compose` renders from docker-compose.yml and deploy/demo/compose.yml:
 *
 * - it renders with the variables of deploy/demo/.env.example filled in;
 * - only the edge publishes a port, and only 443;
 * - no URL, issuer, CORS origin or redirect URI still names localhost: each names a public host;
 * - no secret has a default: without any one of them, rendering fails, and no demo default
 *   (`change-me`, `xip`, `xip-secret`) remains.
 *
 *   node --experimental-strip-types deploy/demo/check-config.mts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const SECRETS = [
  'POSTGRES_PASSWORD',
  'RABBITMQ_PASSWORD',
  'S3_SECRET_ACCESS_KEY',
  'DEMO_SUPPLIER_SECRET',
  'DEMO_CUSTOMER_SECRET',
  'DEMO_SUPPORT_PASSWORD',
];
const HOSTS = {
  DEMO_WEB_HOST: 'web.check.test',
  DEMO_API_HOST: 'api.check.test',
  DEMO_IDP_HOST: 'idp.check.test',
};
const web = `https://${HOSTS.DEMO_WEB_HOST}`;
const api = `https://${HOSTS.DEMO_API_HOST}`;
const idp = `https://${HOSTS.DEMO_IDP_HOST}`;

/** Every variable of the template, with a recognisable value for each secret. */
function variables(): Record<string, string> {
  const template = readFileSync(path.join(root, 'deploy/demo/.env.example'), 'utf8');
  const names = [...template.matchAll(/^([A-Z0-9_]+)=/gm)].map(([, name]) => name!);
  const values: Record<string, string> = {
    TAG: '0.0.0-check',
    ACME_EMAIL: 'ops@check.test',
    ...HOSTS,
    ...Object.fromEntries(SECRETS.map((name) => [name, `check-${name.toLowerCase()}`])),
  };
  for (const name of [...SECRETS, ...Object.keys(HOSTS)]) {
    if (!names.includes(name)) throw new Error(`deploy/demo/.env.example does not list ${name}`);
  }
  return Object.fromEntries(names.map((name) => [name, values[name] ?? '']));
}

interface Service {
  environment?: Record<string, string>;
  ports?: { published?: string; target: number }[];
  volumes?: { source?: string; target: string }[];
  healthcheck?: { test?: string[] };
}

const dir = mkdtempSync(path.join(tmpdir(), 'demo-check-'));

/** `docker compose config` with only the given variables: no shell environment, no root .env. */
function render(env: Record<string, string>): { services: Record<string, Service> } {
  const envFile = path.join(dir, '.env');
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
  );
  const output = execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '-f',
      'docker-compose.yml',
      '-f',
      'deploy/demo/compose.yml',
      '--profile',
      'full',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(
        ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT']
          .filter((name) => process.env[name] !== undefined)
          .map((name) => [name, process.env[name]]),
      ),
    },
  );
  return JSON.parse(output) as { services: Record<string, Service> };
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
}

try {
  const env = variables();
  const config = render(env);
  const { services } = config;
  check(true, 'renders with deploy/demo/.env.example filled in');

  const published = Object.entries(services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => `${name}:${port.published}->${port.target}`),
  );
  check(
    published.every((port) => port.startsWith('edge:')),
    `only the edge publishes ports (${published.join(', ') || 'none'})`,
  );
  check(
    published
      .filter((port) => port.startsWith('edge:'))
      .map((port) => port.split(/[:-]/)[1])
      .join() === '443',
    'the edge publishes 443 only',
  );

  const rendered = JSON.stringify(config);
  check(!/localhost/.test(rendered), 'no localhost anywhere in the rendered configuration');

  const environment = (service: string) => services[service]?.environment ?? {};
  const expected: [string, string, string][] = [
    ['api', 'AUTH_ISSUER', idp],
    ['api', 'AUTH_TOKEN_URL', `${idp}/token`],
    ['api', 'CORS_ORIGINS', web],
    ['worker', 'AUTH_ISSUER', idp],
    ['mock-idp', 'AUTH_ISSUER', idp],
    ['mock-idp', 'MOCK_IDP_CORS_ORIGINS', api],
    ['mock-idp', 'MOCK_IDP_SUPPORT_REDIRECT_URIS', `${web}/callback`],
    ['web', 'API_URL', api],
    ['web', 'IDP_ISSUER', idp],
  ];
  for (const [service, name, value] of expected) {
    check(environment(service)[name] === value, `${service} ${name} is ${value}`);
  }
  const edge = services.edge;
  check(
    edge?.volumes?.some(
      (volume) =>
        volume.target === '/etc/caddy/Caddyfile' &&
        volume.source === path.join(root, 'deploy/demo/Caddyfile'),
    ) ?? false,
    'the edge serves deploy/demo/Caddyfile',
  );
  for (const name of [...Object.keys(HOSTS), 'ACME_EMAIL']) {
    check(environment('edge')[name] === env[name], `the edge gets ${name}`);
  }

  // The demo defaults of docker-compose.yml: none may survive, wherever it would be used.
  for (const secret of ['change-me', 'xip-secret', ':xip@', '"password":"xip"']) {
    check(!rendered.includes(secret), `no demo default ${secret} remains`);
  }
  for (const name of SECRETS) {
    check(rendered.includes(`check-${name.toLowerCase()}`), `${name} reaches the configuration`);
    const { [name]: _omitted, ...without } = env;
    let refused = false;
    try {
      render(without);
    } catch {
      refused = true;
    }
    check(refused, `${name} has no default: compose refuses to render without it`);
  }
} catch (error) {
  const stderr = (error as { stderr?: string }).stderr;
  check(false, `renders: ${stderr?.trim() || (error as Error).message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nThe demo deployment configuration is sound.');
