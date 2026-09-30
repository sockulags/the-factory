import type { UsageRowDto } from "@factory/protocol";
import { useState } from "react";
import { useResource } from "../hooks.js";
import type { WorkspaceContext } from "./Workspace.js";

const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${(n / 1000).toFixed(0)}k`
      : fmt.format(n);
const hours = (ms: number) =>
  ms >= 3_600_000
    ? `${(ms / 3_600_000).toFixed(1)} h`
    : ms >= 60_000
      ? `${Math.round(ms / 60_000)} min`
      : `${Math.round(ms / 1000)} s`;

/** Agent usage from the thread logs: turns, tokens and cost where agents report them, time. */
export function UsageView({
  ctx,
  productId,
  productKey,
}: {
  ctx: WorkspaceContext;
  productId: string;
  productKey: string;
}) {
  const [days, setDays] = useState(30);
  const [scope, setScope] = useState<"product" | "all">("product");
  const report = useResource(
    () => ctx.api.usage(scope === "product" ? productId : null, days),
    `${scope}:${productId}:${days}`,
  );
  const r = report.data;

  return (
    <section className="usage pad" aria-label="Usage">
      <div className="row">
        <h2>Usage</h2>
        <span className="spacer" />
        <select
          aria-label="Scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as "product" | "all")}
        >
          <option value="product">{productKey}</option>
          <option value="all">All products</option>
        </select>
        <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {!r ? (
        <p className="muted">{report.error ?? "Loading…"}</p>
      ) : (
        <>
          <div className="tiles">
            <Tile label="Agent turns" value={fmt.format(r.total.turns)} />
            <Tile
              label="Tokens in / out"
              value={`${tokens(r.total.inputTokens)} / ${tokens(r.total.outputTokens)}`}
            />
            <Tile label="Agent time" value={hours(r.total.durationMs)} />
            <Tile
              label="Reported cost"
              value={r.total.cost ? `$${r.total.cost.toFixed(2)}` : "—"}
            />
          </div>
          <p className="muted small">
            Tokens and cost only count agents that report them. Subscription plans may not report
            cost at all; turns and time are always counted.
          </p>
          <h3>By agent</h3>
          <Table
            rows={r.byAgent.map((a) => ({
              key: a.agentId,
              label: ctx.agentNames[a.agentId] ?? a.agentId,
              ...a,
            }))}
          />
          <h3>By card</h3>
          <Table
            rows={r.byCard.map((c) => ({ ...c, key: c.cardId, label: `${c.key} · ${c.title}` }))}
          />
          <h3>By day</h3>
          <Table rows={r.byDay.map((d) => ({ key: d.day, label: d.day, ...d }))} />
        </>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Table({ rows }: { rows: (UsageRowDto & { key: string; label: string })[] }) {
  if (!rows.length) return <p className="muted small">Nothing in this period.</p>;
  return (
    <table className="data">
      <thead>
        <tr>
          <th />
          <th>Turns</th>
          <th>Tokens in</th>
          <th>Tokens out</th>
          <th>Time</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{row.label}</td>
            <td>{fmt.format(row.turns)}</td>
            <td>{tokens(row.inputTokens)}</td>
            <td>{tokens(row.outputTokens)}</td>
            <td>{hours(row.durationMs)}</td>
            <td>{row.cost ? `$${row.cost.toFixed(2)}` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
