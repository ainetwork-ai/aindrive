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

/** One drive = one picked folder + its own credentials and socket. */
export interface AgentConfig {
  serverUrl: string;
  driveId: string;
  agentToken: string;
  driveSecret: string;
  folderUri: string;
  folderLabel?: string;
}

export interface DriveStatus {
  driveId: string;
  folderLabel: string | null;
  running: boolean;
  connected: boolean;
  rpcCount: number;
  lastError: string | null;
}

export interface AgentStatus {
  /** True while at least one drive is being served. */
  running: boolean;
  /** True while at least one drive's socket is up. */
  connected: boolean;
  drives: DriveStatus[];
}

export const IDLE_STATUS: AgentStatus = { running: false, connected: false, drives: [] };

export interface AindriveAgentPlugin {
  /** Opens the system folder picker and takes a persistable read/write grant. */
  pickFolder(): Promise<PickedFolder>;
  /**
   * Adds a drive to the running agent (starting the foreground service on
   * Android if needed) and connects it. Calling again with the same driveId
   * replaces that drive's connection.
   */
  start(config: AgentConfig): Promise<AgentStatus>;
  /** Takes one drive offline, or every drive when no driveId is given. */
  stop(opts?: { driveId?: string }): Promise<AgentStatus>;
  status(): Promise<AgentStatus>;
  addListener(
    event: "statusChanged",
    cb: (s: AgentStatus) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const AindriveAgent = registerPlugin<AindriveAgentPlugin>("AindriveAgent");
