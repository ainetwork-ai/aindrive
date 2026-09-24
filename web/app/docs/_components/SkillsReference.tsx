import { SKILL_DESCRIPTORS, MUTATING } from "@/shared/skill-descriptors";

type Prop = { type?: string; description?: string; enum?: string[]; default?: unknown };

/** Skills reference generated from the live catalog — never drifts from the code. */
export function SkillsReference() {
  return (
    <>
      <h1>Skills reference</h1>
      <p>
        Every transport exposes the same skills. On MCP they are tools; on A2A a DataPart{" "}
        <code>{"{skill, ...args}"}</code>; on AG-UI <code>forwardedProps.skill</code> + <code>args</code>. With a
        drive-scoped endpoint or token, <code>drive_id</code> is implied and <code>list_drives</code> is unavailable.
        Paths are drive-relative (<code>docs/a.md</code>); <code>.aindrive/</code> is always refused, and paid
        folders you haven&apos;t bought stay locked.
      </p>
      {SKILL_DESCRIPTORS.map((s) => {
        const schema = s.inputSchema as { properties?: Record<string, Prop>; required?: string[] };
        const props = Object.entries(schema.properties ?? {});
        return (
          <section key={s.name}>
            <h2 id={s.name}>
              <code>{s.name}</code> {MUTATING.includes(s.name) && <span className="docs-badge">write</span>}
            </h2>
            <p>{s.description}</p>
            {props.length > 0 ? (
              <table>
                <thead><tr><th>Argument</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead>
                <tbody>
                  {props.map(([name, p]) => (
                    <tr key={name}>
                      <td><code>{name}</code></td>
                      <td>{p.enum ? p.enum.map((e) => `"${e}"`).join(" | ") : p.type ?? "any"}</td>
                      <td>{schema.required?.includes(name) ? "yes" : "no"}</td>
                      <td>{[p.description, p.default !== undefined ? `default ${JSON.stringify(p.default)}` : ""].filter(Boolean).join(" — ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p><em>No arguments.</em></p>}
          </section>
        );
      })}
    </>
  );
}
