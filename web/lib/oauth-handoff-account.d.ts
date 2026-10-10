import type { VerifiedIdentityHandoff } from './oauth-handoff';

type HandoffDatabase = {
  prepare(sql: string): {
    get(...values: unknown[]): { id: string } | undefined;
    run(...values: unknown[]): { changes: number | bigint };
  };
};

export function resolveHandoffAccount(db: HandoffDatabase, proof: VerifiedIdentityHandoff, policy: {
  ssoIssuer?: string | null;
  accountBlocked: (userId: string) => boolean;
  legacyRefusal: (userId: string) => unknown;
  createSsoAccount?: (issuer: string, subject: string) => string | null;
  createWalletAccount?: (address: string) => string | null;
}): string | null;

export function consumeHandoffNonce(db: HandoffDatabase, proof: VerifiedIdentityHandoff, now?: number): boolean;
