// The agent's own identity documents. client_id is the URL of the client metadata document; jwks_uri sits on the same host.
export function clientMetadata({ baseUrl, redirectUri, name = 'Poppy Agent Tester' }) {
  return {
    client_id: `${baseUrl}/client.json`,
    client_name: name,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    jwks_uri: `${baseUrl}/jwks.json`,
  };
}

export const jwksDocument = (publicJwk, kid) => ({ keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }] });
