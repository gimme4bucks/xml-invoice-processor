// Hexagonal architecture rules, enforced in CI (ADR 0010). A violation fails the build.
const SRC = '^apps/service/src';
const DOMAIN = `${SRC}/documents/domain`;
const APPLICATION = `${SRC}/documents/application`;
const ADAPTERS = `${SRC}/documents/adapters`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment: 'The domain depends on nothing but itself: no framework, no I/O, no other layer.',
      severity: 'error',
      from: { path: DOMAIN },
      to: { pathNot: [DOMAIN] },
    },
    {
      name: 'application-depends-on-domain-only',
      comment:
        'Application (use cases, ports) may use the domain, Node built-ins and the NestJS CQRS/DI decorators. Never adapters, the composition root or infrastructure libraries.',
      severity: 'error',
      from: { path: APPLICATION },
      to: {
        pathNot: [DOMAIN, APPLICATION, '^node:', 'node_modules/@nestjs/(common|cqrs)/'],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'adapters-do-not-know-the-composition-root',
      severity: 'error',
      from: { path: ADAPTERS },
      to: { path: `${SRC}/app/` },
    },
    {
      name: 'prisma-only-in-postgres-adapter',
      comment: 'Prisma types stay inside the Postgres adapter; everything else talks to ports.',
      severity: 'error',
      from: {
        path: SRC,
        pathNot: [`${ADAPTERS}/outbound/postgres/`, `${SRC}/app/`, `${SRC}/generated/`],
      },
      to: { path: ['node_modules/@prisma/', `${SRC}/generated/prisma`] },
    },
    {
      name: 'amqp-only-in-rabbitmq-adapters',
      severity: 'error',
      from: {
        path: SRC,
        pathNot: [
          `${ADAPTERS}/outbound/rabbitmq/`,
          `${ADAPTERS}/inbound/messaging/`,
          `${SRC}/app/`,
        ],
      },
      to: { path: 'node_modules/(amqplib|amqp-connection-manager)/' },
    },
    {
      name: 'aws-sdk-only-in-s3-adapter',
      comment: 'The bucket is reached only through the S3 adapter (ADR 0016).',
      severity: 'error',
      from: { path: SRC, pathNot: [`${ADAPTERS}/outbound/s3/`] },
      to: { path: 'node_modules/@aws-sdk/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: { path: SRC },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['\\.spec\\.ts$', `${SRC}/generated/`] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'apps/service/tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
