/**
 * TypeScript face of the native AindriveAgent plugin.
 *
 * The agent itself — the outbound WebSocket to the aindrive server, HMAC
 * verification of every RPC frame, and the actual filesystem reads/writes —
 * runs NATIVELY (Kotlin foreground service on Android, Swift on iOS), not in
 * this WebView. That is deliberate:
 *
 *  - the WebView is suspended whenever the app is backgrounded, which would
 *    kill the drive; a foreground service survives,
 *  - a WebView cannot reach the phone's real user storage. The native side
 *    holds a SAF tree URI (Android) / security-scoped bookmark (iOS) for a
 *    folder the user picked, so the drive serves REAL device files, not an
 *    app-private sandbox copy.
 *
 * Protocol mirrored from cli/src/agent.js + cli/src/rpc.js + cli/src/sig.js.
 */
import { registerPlugin } from "@capacitor/core";

export interface PickedFolder {
  /** Opaque native handle: SAF tree URI (Android) / bookmark id (iOS). */
  uri: string;
  /** Human-readable folder name for the UI. */
  label: string;
}

export interface AgentConfig {
  serverUrl: string;
  driveId: string;
  agentToken: string;
  driveSecret: string;
  folderUri: string;
}

export interface AgentStatus {
  running: boolean;
  connected: boolean;
  driveId: string | null;
  folderLabel: string | null;
  rpcCount: number;
  lastError: string | null;
}

export interface AindriveAgentPlugin {
  /** Opens the system folder picker and takes a persistable read/write grant. */
  pickFolder(): Promise<PickedFolder>;
  /** Starts the foreground agent service and connects to the server. */
  start(config: AgentConfig): Promise<AgentStatus>;
  /** Stops the agent and takes the drive offline. */
  stop(): Promise<AgentStatus>;
  status(): Promise<AgentStatus>;
  addListener(
    event: "statusChanged",
    cb: (s: AgentStatus) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const AindriveAgent = registerPlugin<AindriveAgentPlugin>("AindriveAgent");
