import { createHash } from 'node:crypto';

/** Resolve a verified provider subject; never use an email, display name or a requested user id. */
export function resolveHandoffAccount(db, proof, { ssoIssuer, accountBlocked, legacyRefusal, createSsoAccount, createWalletAccount }) {
  if (typeof accountBlocked !== 'function' || typeof legacyRefusal !== 'function') return null;
  let row;
  if (proof.authType === 'google' && proof.principal.startsWith('google:')) {
    row = db.prepare('SELECT account_id AS id FROM account_google WHERE sub = ?').get(proof.principal.slice(7));
  } else if (proof.authType === 'wallet' && /^0x[0-9a-f]{40}$/.test(proof.principal)) {
    row = db.prepare('SELECT account_id AS id FROM account_wallets WHERE wallet_address = ? AND login_enabled = 1').get(proof.principal);
    // A payment-only link must never be upgraded into login permission by a handoff.
    if (!row && !db.prepare('SELECT account_id AS id FROM account_wallets WHERE wallet_address = ?').get(proof.principal)
      && typeof createWalletAccount === 'function') {
      const id = createWalletAccount(proof.principal);
      if (id) row = { id };
    }
  } else if (proof.authType === 'sso' && ssoIssuer && proof.ssoSubject) {
    row = db.prepare('SELECT user_id AS id FROM sso_identities WHERE issuer = ? AND subject = ?').get(ssoIssuer, proof.ssoSubject);
    if (!row && typeof createSsoAccount === 'function') {
      const id = createSsoAccount(ssoIssuer, proof.ssoSubject);
      if (id) row = { id };
    }
  }
  if (!row || !db.prepare('SELECT id FROM users WHERE id = ?').get(row.id) || accountBlocked(row.id)) return null;
  if (proof.authType !== 'sso' && legacyRefusal(row.id)) return null;
  return row.id;
}

/** Call inside the SAME transaction as grant issuance; a failed grant must roll this insert back. */
export function consumeHandoffNonce(db, proof, now = Math.floor(Date.now() / 1000)) {
  if (proof.expires <= now) return false;
  const id = createHash('sha256').update(JSON.stringify([proof.issuer, proof.clientId, proof.nonce])).digest('hex');
  db.prepare('DELETE FROM oauth_handoff_nonces WHERE expires_at <= ?').run(now);
  return Number(db.prepare('INSERT OR IGNORE INTO oauth_handoff_nonces (id, expires_at) VALUES (?, ?)').run(id, proof.expires).changes) === 1;
}
