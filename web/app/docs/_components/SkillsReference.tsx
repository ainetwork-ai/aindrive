import { SKILL_DESCRIPTORS, SALE_SKILL_DESCRIPTORS, MUTATING, type SkillDescriptor } from "@/shared/skill-descriptors";

type Prop = { type?: string | string[]; description?: string; enum?: string[]; default?: unknown };

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
      {SKILL_DESCRIPTORS.map((s) => <Skill key={s.name} s={s} badge={MUTATING.includes(s.name) ? "write" : undefined} />)}
      <h2 id="sale-tools">Sale tools</h2>
      <p>
        Selling from an agent: share links, payout wallets, the drive&apos;s payment-token policy and the receipts ledger.
        Available <strong>only on the drive MCP endpoint</strong> (<code>/mcp/d/&lt;id&gt;</code>) to an OAuth account grant
        with <code>drives:sell</code>, and only for the drive&apos;s <strong>creator</strong> (checked on every call). They
        apply the same validation as the web UI. Prices are in units of the sale&apos;s currency.
      </p>
      {SALE_SKILL_DESCRIPTORS.map((s) => <Skill key={s.name} s={s} badge="sell" level={3} />)}
    </>
  );
}

function Skill({ s, badge, level = 2 }: { s: SkillDescriptor; badge?: string; level?: 2 | 3 }) {
  const schema = s.inputSchema as { properties?: Record<string, Prop>; required?: string[] };
  const props = Object.entries(schema.properties ?? {});
  const H = level === 2 ? "h2" : "h3";
  return (
    <section>
      <H id={s.name}><code>{s.name}</code> {badge && <span className="docs-badge">{badge}</span>}</H>
      <p>{s.description}</p>
      {props.length > 0 ? (
        <table>
          <thead><tr><th>Argument</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead>
          <tbody>
            {props.map(([name, p]) => (
              <tr key={name}>
                <td><code>{name}</code></td>
                <td>{p.enum ? p.enum.map((e) => `"${e}"`).join(" | ") : Array.isArray(p.type) ? p.type.join(" | ") : p.type ?? "any"}</td>
                <td>{schema.required?.includes(name) ? "yes" : "no"}</td>
                <td>{[p.description, p.default !== undefined ? `default ${JSON.stringify(p.default)}` : ""].filter(Boolean).join(" — ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p><em>No arguments.</em></p>}
    </section>
  );
}
