import { meadowcap, generateEd25519Keypair, pathFromString, pathToString } from "./meadowcap.js";

const mc = meadowcap();

export type IssuedCap = {
  capBytes: Uint8Array;
  capBase64: string;
  recipientPub: Uint8Array;
  recipientSecret: Uint8Array;
};

/**
 * Create a delegated Meadowcap capability for a path-prefix area inside a drive's owned namespace.
 *
 * The recipient is an EPHEMERAL Ed25519 key generated here (since visitor wallets are secp256k1).
 * The caller is responsible for handing both `capBase64` and `recipientSecret` back to the user
 * (e.g., in an httponly cookie). When the user later wants to prove access, they sign a challenge
 * with `recipientSecret` and present the cap; the server verifies with mc.isValidCap.
 */
export async function issueShareCap(opts: {
  namespacePub: Uint8Array;
  namespaceSecret: Uint8Array;
  pathPrefix: string;
  accessMode?: "read" | "write";
  ttlMs?: number;
}): Promise<IssuedCap> {
  const access = opts.accessMode ?? "read";
  const ownerUser = await generateEd25519Keypair(); // owner's user-keypair for this issuance
  const root = await mc.createCapOwned({
    accessMode: access,
    namespace: opts.namespacePub,
    namespaceSecret: opts.namespaceSecret,
    user: ownerUser.publicKey,
  });
  const recipient = await generateEd25519Keypair();
  const ttlMs = opts.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
  const delegated = await mc.delegateCapOwned({
    cap: root,
    user: recipient.publicKey,
    area: {
      pathPrefix: pathFromString(opts.pathPrefix),
      includedSubspaceId: ownerUser.publicKey,
      timeRange: { start: 0n, end: BigInt(Date.now() + ttlMs) },
    },
    secret: ownerUser.secretKey,
  });
  const capBytes = mc.encodeCap(delegated);
  return {
    capBytes,
    capBase64: Buffer.from(capBytes).toString("base64url"),
    recipientPub: recipient.publicKey,
    recipientSecret: recipient.secretKey,
  };
}

export type DecodedCap = {
  /** Owned namespace this cap is rooted at (= drive's namespace pubkey). */
  namespacePub: Uint8Array;
  receiverPub: Uint8Array;
  pathPrefix: string;
  timeStart: bigint;
  timeEnd: bigint | null;
  valid: boolean;
};

export async function decodeAndDescribeCap(capBase64: string): Promise<DecodedCap | null> {
  try {
    const bytes = Buffer.from(capBase64, "base64url");
    const cap = mc.decodeCap(new Uint8Array(bytes));
    const valid = await mc.isValidCap(cap);
    const area = mc.getCapGrantedArea(cap);
    const receiverPub = mc.getCapReceiver(cap);
    // Meadowcap caps have namespaceKey as a direct field (no class getter
    // exposed for it). Cast through any to satisfy TS without dragging in
    // the full McCapability generic chain.
    const namespacePub = (cap as unknown as { namespaceKey: Uint8Array }).namespaceKey;
    return {
      namespacePub,
      receiverPub,
      pathPrefix: pathToString(area.pathPrefix),
      timeStart: area.timeRange.start,
      timeEnd: typeof area.timeRange.end === "bigint" ? area.timeRange.end : null,
      valid,
    };
  } catch {
    return null;
  }
}
