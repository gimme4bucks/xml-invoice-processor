import { createIdp, parseClients } from './idp';

// Mock IdP for dev, demo and e2e only. AUTH_ISSUER and AUTH_AUDIENCE match the API's settings.
async function main(): Promise<void> {
  const port = Number(process.env.MOCK_IDP_PORT ?? 4000);
  const issuer = process.env.AUTH_ISSUER ?? `http://localhost:${port}`;
  const audience = process.env.AUTH_AUDIENCE ?? 'xml-invoice-processor';
  const clients = parseClients(process.env.MOCK_IDP_CLIENTS);

  const server = await createIdp({ issuer, audience, clients });
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ msg: 'mock-idp listening', port, issuer, audience }));
  });
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
