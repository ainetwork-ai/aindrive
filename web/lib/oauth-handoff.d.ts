export type IdentityHandoffKey = { kty: 'OKP'; crv: 'Ed25519'; x: string };
export type VerifiedIdentityHandoff = {
  clientId: string;
  issuer: string;
  principal: string;
  authType: 'google' | 'wallet' | 'sso';
  ssoSubject: string | null;
  nonce: string;
  expires: number;
};
export function verifyIdentityHandoff(token: string, options: {
  clients: Record<string, { issuer: string; keys: IdentityHandoffKey[] }>;
  audience: string;
  now?: number;
}): VerifiedIdentityHandoff | null;
