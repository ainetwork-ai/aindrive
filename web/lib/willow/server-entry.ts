// What server.js takes from the TypeScript side, bundled into peer.bundle.mjs by
// scripts/build-willow-peer.mjs: the Willow peer and the P2P media signalling.
export { onWillowSync, agentUser } from "./peer";
export { onRtcSignal } from "@/lib/media/rtc-signal";
