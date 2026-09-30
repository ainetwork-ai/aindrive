export declare const GENERATION_RE: RegExp;
export declare function peekGeneration(driveId: string, path: string): { generation: string; birth_ms: number | null } | null;
export declare function generationFor(driveId: string, path: string, entry?: { birthtimeMs?: number } | null): string;
export declare function observeEntry(driveId: string, path: string, entry: { birthtimeMs?: number } | null | undefined): void;
export declare function dropGenerations(driveId: string, path: string): void;
export declare function revisionWithGeneration(revision: string, generation: string): string;
export declare function generationOfRevision(revision: unknown): string | null;
