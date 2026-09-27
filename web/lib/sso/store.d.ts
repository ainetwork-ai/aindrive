// Types for lib/sso/store.js (plain ESM so lib/dochub.js can use it under `node server.js`).

export declare const SSO_PLACEHOLDER_DOMAIN: string;
export declare function isReservedEmail(email: string | null | undefined): boolean;

export declare function audit(entry: {
  actor: string;
  action: string;
  issuer?: string | null;
  subject?: string | null;
  orgId?: string | null;
  userId?: string | null;
  details?: unknown;
}): void;

export type SsoAccountState = "unmanaged" | "active" | "blocked";
export declare function ssoAccountState(userId: string): SsoAccountState;
export declare function isAccountBlocked(userId: string): boolean;
export declare function isSsoLinked(userId: string): boolean;
export declare function identityFor(issuer: string, subject: string): { user_id: string; link_method: string } | undefined;
export declare function sessionEpoch(userId: string): number;
export declare function liveSessionUserId(payload: Record<string, unknown> | null | undefined): string | null;

export type SsoSessionRow = {
  id: string;
  user_id: string;
  issuer: string;
  subject: string;
  oidc_sid: string | null;
  org_id: string | null;
  org_ids: string;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
  end_reason: string | null;
};
export declare function createSsoSession(opts: {
  userId: string;
  issuer: string;
  subject: string;
  oidcSid: string | null;
  orgId: string | null;
  orgIds: string[];
}): string;
export declare function getSsoSession(id: string): SsoSessionRow | null;
export declare function endSsoSession(id: string, reason: string): number;
export declare function endSessionsBySid(issuer: string, oidcSid: string, reason?: string): { id: string; user_id: string }[];
export declare function endAllUserSessions(userId: string, reason: string): number;
export declare function disconnectUserSockets(match: { userId?: string; sessionIds?: string[] }): number;

export type LoginRequestRow = {
  id: string;
  state: string;
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  next_path: string;
  created_at: number;
  expires_at: number;
};
export declare function createLoginRequest(opts: {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  nextPath: string;
}): string;
export declare function takeLoginRequest(id: string | null | undefined): LoginRequestRow | null;

export type PendingLinkRow = {
  id: string;
  issuer: string;
  subject: string;
  name: string | null;
  email: string | null;
  email_verified: number;
  oidc_sid: string | null;
  org_id: string | null;
  org_ids: string;
  next_path: string;
  created_at: number;
  expires_at: number;
};
export declare function createPendingLink(opts: {
  issuer: string;
  subject: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  oidcSid: string | null;
  orgId: string | null;
  orgIds: string[];
  nextPath: string;
}): string;
export declare function getPendingLink(id: string | null | undefined): PendingLinkRow | null;
export declare function deletePendingLink(id: string): void;

export declare function resolveOrCreateUserForSubject(opts: {
  issuer: string;
  subject: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  method?: string;
  actor?: string;
}): { userId: string; created: boolean };

export type LinkResult =
  | { ok: true; userId: string }
  | { ok: false; error: "sub_already_linked" | "user_not_found" | "account_already_linked" | "account_suspended" };
export declare function linkExistingUser(opts: {
  issuer: string;
  subject: string;
  userId: string;
  method: string;
  proof?: unknown;
  actor: string;
}): LinkResult;

export declare function checkAndStoreJti(key: string, expiresAtMs: number): boolean;

export declare class AdapterError extends Error {
  constructor(code: string, status?: number, message?: string, retryable?: boolean);
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
}

export type AdapterStatus = "active" | "suspended" | "deprovisioned";
export type CurrentUserState = {
  exists: boolean;
  localUserId: string | null;
  appliedVersion: number | null;
  status: AdapterStatus | null;
  appRole: string | null;
  groups: string[];
};
export type ApplyResult = { appliedVersion: number; localUserId: string | null; status: AdapterStatus };
export type DesiredUserState = {
  schema: "ain-sso.adapter.v1";
  sub: string;
  org: { id: string; slug: string; name: string };
  version: number;
  status: AdapterStatus;
  profile: { name: string | null; email: string | null; workEmail: string | null };
  appRole: string | null;
  groups: { id: string; slug: string; name: string; kind: "team" | "department" | "access" | "mail" }[];
  legacyUserId: string | null;
  ownershipTransferTo: string | null;
  issuedAt: string;
};
export declare function getAppliedState(issuer: string, orgId: string, subject: string): CurrentUserState | null;
export declare function applyDesiredState(issuer: string, state: DesiredUserState): { result: ApplyResult; endedUserId: string | null };
