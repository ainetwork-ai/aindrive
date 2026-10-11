import type { IdentityHandoffKey } from './oauth-handoff';
export function parseHandoffClients(raw: string | null | undefined): Record<string, { issuer: string; keys: IdentityHandoffKey[] }>;
