export const KNOWN_OAUTH_SCOPES: readonly string[];
export const CONSENT_ALWAYS_SCOPES: readonly string[];
export function parseTrustedOAuthClients(raw: string | null | undefined): {
  clients: Map<string, string[]>;
  bad: string[];
};
export function trustedOAuthConfigErrors(env: Record<string, string | undefined>): string[];
