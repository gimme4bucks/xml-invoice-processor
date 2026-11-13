import { createIdp, parseClients, parseSupportClient, SUPPORT_CLIENT_ID } from './idp';

// Mock IdP for dev, demo and e2e only. AUTH_ISSUER and AUTH_AUDIENCE match the API's settings.
async function main(): Promise<void> {
  const port = Number(process.env.MOCK_IDP_PORT ?? 4000);
  const issuer = process.env.AUTH_ISSUER ?? `http://localhost:${port}`;
  const audience = process.env.AUTH_AUDIENCE ?? 'xml-invoice-processor';
  const clients = parseClients(process.env.MOCK_IDP_CLIENTS);
  const support = parseSupportClient(
    process.env.MOCK_IDP_SUPPORT_REDIRECT_URIS,
    process.env.MOCK_IDP_SUPPORT_USERS,
  );

  const server = await createIdp({ issuer, audience, clients, support });
  server.listen(port, '0.0.0.0', () => {
    // Redirect URIs and user names only; never a password.
    const supportClient = support
      ? { clientId: SUPPORT_CLIENT_ID, redirectUris: support.redirectUris }
      : 'off';
    console.log(
      JSON.stringify({ msg: 'mock-idp listening', port, issuer, audience, supportClient }),
    );
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
