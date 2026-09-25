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
  /** Build the photo index right after connecting (first run can take minutes). */
  indexOnStart?: boolean;
  /** Roots of the other drives; any that sit inside this folder are hidden from it. */
  excludeUris?: string[];
  /**
   * An agent SOURCE, not a shared drive: the folder is indexed for the agent's
   * tasks (call recordings, the camera roll) but never served to the web.
   * driveId is "src-calls" or "src-photos"; no credentials needed.
   */
  source?: boolean;
}

/** Photo-index state for one drive; drives `Index photos` progress in the UI. */
export interface IndexStatus {
  indexed: number;
  running: boolean;
  done: number;
  total: number;
  failed: number;
  /** "scanning" | "indexing" | "recognising" | "done" | "cancelled" | "idle" | "error: …" */
  phase: string;
  lastRunMs: number;
  /** Recognition pass (photos → CLIP vectors, recordings → transcripts). */
  recognised: number;
  toRecognise: number;
  recognisedTotal: number;
}

/** On-device recognition models (photos + speech): present, or being fetched. */
export interface ModelInfo { id: "image" | "speech" | "llm"; role: string; name: string; license: string; engine: string; bytes: number; ready: boolean }

export interface ModelsStatus {
  /** Every model the agent runs on this phone, with what it is for. */
  list?: ModelInfo[];
  llm?: boolean;
  photos: boolean;
  speech: boolean;
  ready: boolean;
  downloading: boolean;
  done: number;
  total: number;
  error: string | null;
}

/** Same shape the desktop agent-ask returns, so the web UI needs no change. */
/** One row of an in-app folder listing; same shape the drive shows on the web. */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  mime: string;
}

export interface AskResult {
  answer: string;
  /** The effective filters of this turn — pass back as `context` on the next ask. */
  context?: Record<string, unknown> | null;
  /** Filters were inherited from the previous turn. */
  followUp?: boolean;
  sources: { path: string; snippet: string; driveId?: string; matchedBy?: "filter" | "name" | "speech" | "photo"; remoteName?: string;
    /** Call recordings: who it was with, when (ms), and a one-line summary of what was said. */
    caller?: string; callAt?: number; summary?: string }[];
  /** Present when the question was a task ("…모아서 폴더로 만들어줘"). */
  action?: {
    type: "collect" | "move" | "count" | "delete";
    driveId?: string;
    /** Drive-relative path of the folder that was created. */
    folder?: string;
    /** Native handle of that folder (Android: document URI in the tree) — the shell turns it into a drive of its own. */
    folderUri?: string;
    /** Display name once the folder is its own drive (`folder` is then ""). */
    label?: string;
    /** "calls": the call-history report; `people` is the ranking. */
    report?: "calls";
    people?: { name: string; calls: number; seconds: number; recordings: number; topics: string[]; gist: string }[];
    /** The report had no call log because READ_CALL_LOG is not granted — offer the permission. */
    needsCallLog?: boolean;
    copied?: number;
    failed?: number;
    /** The user also asked to share it — the shell mints the link (it holds the session). */
    share?: boolean;
    skipped?: boolean;
    reason?: string;
  };
}

export interface DriveStatus {
  driveId: string;
  /** True for an agent source (see AgentConfig.source). */
  source?: boolean;
  folderLabel: string | null;
  running: boolean;
  connected: boolean;
  rpcCount: number;
  lastError: string | null;
  index?: IndexStatus;
}

export interface AgentStatus {
  /** True while at least one drive is being served. */
  running: boolean;
  /** True while at least one drive's socket is up. */
  connected: boolean;
  drives: DriveStatus[];
  models?: ModelsStatus;
}

export const IDLE_STATUS: AgentStatus = { running: false, connected: false, drives: [] };

export interface AindriveAgentPlugin {
  /** Opens the system folder picker (at `initial`, e.g. "Call" or "DCIM", when given) and takes a persistable read/write grant. */
  pickFolder(opts?: { initial?: string }): Promise<PickedFolder>;
  /** Asks for READ_CALL_LOG (the call-history report ranks people by it). */
  requestCallLog(): Promise<{ granted: boolean }>;
  /**
   * Opens the system file picker (multi-select) and copies the chosen files
   * into the folder — the phone's stand-in for dragging files into a share.
   */
  addFiles(opts: { folderUri: string; path?: string }): Promise<{ added: string[]; failed: string[] }>;
  mkdir(opts: { folderUri: string; path: string }): Promise<void>;
  rename(opts: { folderUri: string; from: string; to: string }): Promise<void>;
  /** Save text (UTF-8), replacing the file — the in-app editor. */
  writeText(opts: { folderUri: string; path: string; text: string }): Promise<void>;
  /** Recursive, idempotent — like `rm -rf`. */
  delete(opts: { folderUri: string; path: string }): Promise<void>;
  /** List a directory inside a shared folder, read locally (no network). `path` "" = root. */
  listFolder(opts: { folderUri: string; path?: string }): Promise<{ entries: FileEntry[] }>;
  /** Open a file with the phone's own viewer (Android: ACTION_VIEW chooser; iOS: Quick Look). */
  openFile(opts: { folderUri: string; path: string }): Promise<void>;
  /** File bytes for the in-app viewer; images come back downscaled to `maxPx` (default 1600) as JPEG. */
  readFile(opts: { folderUri: string; path: string; maxPx?: number }): Promise<{ mime: string; name: string; base64: string }>;
  /**
   * Adds a drive to the running agent (starting the foreground service on
   * Android if needed) and connects it. Calling again with the same driveId
   * replaces that drive's connection.
   */
  start(config: AgentConfig): Promise<AgentStatus>;
  /** Takes one drive offline, or every drive when no driveId is given. */
  stop(opts?: { driveId?: string }): Promise<AgentStatus>;
  status(): Promise<AgentStatus>;
  /** (Re)build the photo index for one drive, or all running drives. Progress via statusChanged. */
  reindex(opts?: { driveId?: string }): Promise<AgentStatus>;
  /** Download the recognition models (≈230 MB, checksum-verified) and recognise indexed files. Progress via statusChanged. */
  ensureModels(): Promise<AgentStatus>;
  /** Ask the on-device agent — fully offline (gazetteer + local index). `context` is the previous answer's `context` so follow-ups ("…and share them") apply to the same files. */
  ask(opts: { query: string; context?: Record<string, unknown> }): Promise<AskResult>;
  addListener(
    event: "statusChanged",
    cb: (s: AgentStatus) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const AindriveAgent = registerPlugin<AindriveAgentPlugin>("AindriveAgent");
