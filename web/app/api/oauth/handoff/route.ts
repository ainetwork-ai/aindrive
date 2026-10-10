import { db } from '@/lib/db';
import { verifyIdentityHandoff } from '@/lib/oauth-handoff';
import { parseHandoffClients } from '@/lib/oauth-handoff-config';
import { resolveHandoffAccount, consumeHandoffNonce } from '@/lib/oauth-handoff-account';
import { parseTrustedOAuthClients } from '@/lib/oauth-trusted';
import { baseUrl, getClient, type AccountScope } from '@/lib/oauth';
import { issueAccountTokens } from '@/lib/account-tokens';
import { adapterConfig } from '@/lib/sso/config';
import { isAccountBlocked } from '@/lib/sso/store.js';
import { legacyLoginRefusal } from '@/lib/sso/policy';
import { tryConsume, clientKey } from '@/lib/rate-limit';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
const fail = (status = 401) => Response.json({ error: 'invalid_handoff' }, { status, headers });

/** Server-to-server only: no Drive cookie or browser consent is required. */
export async function POST(req: Request) {
  const limit = tryConsume({ name: 'oauth-handoff', key: clientKey(req, 'oauth-handoff'), limit: 30, windowMs: 60_000 });
  if (!limit.ok) return fail(429);
  // Bound even chunked requests before parsing a credential-bearing body.
  if (!req.body) return fail(400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 12_000) { await reader.cancel(); return fail(413); }
    chunks.push(value);
  }
  let input: { proof?: unknown };
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400); }
  if (!input || typeof input.proof !== 'string') return fail(400);
  const proof = verifyIdentityHandoff(input.proof, {
    clients: parseHandoffClients(process.env.AINDRIVE_IDENTITY_HANDOFF_CLIENTS), audience: baseUrl(),
  });
  if (!proof) return fail();
  const client = getClient(proof.clientId);
  const ceiling = parseTrustedOAuthClients(process.env.AINDRIVE_TRUSTED_OAUTH_CLIENTS).clients.get(proof.clientId);
  // Practice grants have a fixed ceiling; never accept scopes from the proof or body.
  const scopes: AccountScope[] = ['drives:read', 'drives:write'];
  if (!client || !ceiling || !scopes.every(scope => ceiling.includes(scope))) return fail();
  const pair = db.transaction(() => {
    const userId = resolveHandoffAccount(db, proof, {
      ssoIssuer: adapterConfig()?.issuer, accountBlocked: isAccountBlocked, legacyRefusal: legacyLoginRefusal,
    });
    if (!userId || !consumeHandoffNonce(db, proof)) return null;
    return issueAccountTokens({ userId, clientId: client.client_id, clientName: client.client_name, scopes });
  })();
  if (!pair) return fail();
  return Response.json({ ...pair, token_type: 'Bearer' }, { headers });
}
