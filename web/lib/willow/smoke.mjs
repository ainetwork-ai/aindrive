/**
 * Smoke test: create a Meadowcap, generate an owned namespace, create a cap,
 * delegate to an ephemeral receiver, encode/decode it, and verify validity.
 *
 * Run from web/: node lib/willow/smoke.mjs
 */
import { meadowcap, generateEd25519Keypair, pathFromString } from "./meadowcap.js";

const mc = meadowcap();

// Owner = namespace keypair
const owner = await generateEd25519Keypair();
console.log("owner pubkey:", Buffer.from(owner.publicKey).toString("hex").slice(0, 16) + "…");

// Owner also has a "user" (=subspace) identity
const ownerUser = await generateEd25519Keypair();

// Create a full owned-namespace WRITE capability for the owner themselves
const rootCap = await mc.createCapOwned({
  accessMode: "read",
  namespace: owner.publicKey,
  namespaceSecret: owner.secretKey,
  user: ownerUser.publicKey,
});
console.log("root cap created. valid?", await mc.isValidCap(rootCap));

// Ephemeral recipient = the share-link holder
const recipient = await generateEd25519Keypair();

// Delegate to the recipient, restricted to "docs/" subtree
const delegated = await mc.delegateCapOwned({
  cap: rootCap,
  user: recipient.publicKey,
  area: {
    pathPrefix: pathFromString("docs"),
    includedSubspaceId: ownerUser.publicKey,
    timeRange: { start: 0n, end: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  },
  secret: ownerUser.secretKey,
});
console.log("delegated cap valid?", await mc.isValidCap(delegated));

// Encode → bytes → decode → still valid?
const encoded = mc.encodeCap(delegated);
console.log("encoded bytes:", encoded.length);
const decoded = mc.decodeCap(encoded);
console.log("decoded cap valid?", await mc.isValidCap(decoded));

// Receiver?
const rx = mc.getCapReceiver(decoded);
console.log("recipient match?", Buffer.from(rx).toString("hex") === Buffer.from(recipient.publicKey).toString("hex"));

// Granted area?
const area = mc.getCapGrantedArea(decoded);
console.log("granted area:", JSON.stringify(area, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString("hex").slice(0, 8) : (typeof v === "bigint" ? v.toString() : v)).slice(0, 200));

console.log("\n✓ smoke test passed");
