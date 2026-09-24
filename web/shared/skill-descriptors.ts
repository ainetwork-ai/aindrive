/**
 * Skill catalog — names, descriptions and JSON-Schema inputs for every
 * aindrive skill. Pure data (no IO), so docs and clients can import it without
 * pulling in the DB/agent stack; the handlers live in ./agent-skills.ts.
 */
const SKILL_NAMES = [
  "list_drives",
  "list_files",
  "read_file",
  "write_file",
  "delete_path",
  "stat",
  "search",
] as const;

/** Skills that change the drive: editor role, and never under a read scope. */
export const MUTATING: readonly string[] = ["write_file", "delete_path"];

export type SkillName = (typeof SKILL_NAMES)[number];

export type SkillDescriptor = {
  name: SkillName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const SKILL_DESCRIPTORS: SkillDescriptor[] = [
  {
    name: "list_drives",
    description: "List the drives the authenticated user owns or is a member of.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "List entries at a path inside a drive. Empty path = root.",
    inputSchema: {
      type: "object",
      required: ["drive_id"],
      properties: {
        drive_id: { type: "string", description: "drive id" },
        path: { type: "string", description: "drive-relative path (default '')" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a file. utf8 returns text; base64 returns binary as base64.",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
    },
  },
  {
    name: "write_file",
    description: "Write/overwrite a file. Creates intermediate folders.",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path", "content"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
    },
  },
  {
    name: "delete_path",
    description: "Delete a file, or a folder with everything in it. The drive root cannot be deleted.",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "stat",
    description: "Metadata for a single path (name, isDir, size).",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "search",
    description: "Search filenames (case-insensitive substring).",
    inputSchema: {
      type: "object",
      required: ["drive_id", "query"],
      properties: {
        drive_id: { type: "string" },
        query: { type: "string" },
        path: { type: "string", default: "" },
        limit: { type: "number", default: 50 },
      },
    },
  },
];

/**
 * Descriptors for a drive-pinned surface: no list_drives, no drive_id
 * argument (the URL/token fixes the drive), and no mutating skill
 * (write_file, delete_path) under a read scope — clients should not be
 * offered a tool that always fails.
 */
export function driveScopedDescriptors(scope: "read" | "write"): SkillDescriptor[] {
  return SKILL_DESCRIPTORS
    .filter((d) => d.name !== "list_drives" && (scope === "write" || !MUTATING.includes(d.name)))
    .map((d) => {
      const schema = d.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const { drive_id: _omit, ...properties } = schema.properties ?? {};
      return {
        ...d,
        inputSchema: {
          ...schema,
          properties,
          ...(schema.required ? { required: schema.required.filter((r) => r !== "drive_id") } : {}),
        },
      };
    });
}

export function isSkillName(s: string): s is SkillName {
  return (SKILL_NAMES as readonly string[]).includes(s);
}
