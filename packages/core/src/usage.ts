import type { Db } from "@factory/db";
import { sql } from "drizzle-orm";

export interface UsageRow {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of reported costs (only agents that report cost contribute). */
  cost: number;
  durationMs: number;
}

export interface UsageReport {
  since: string;
  total: UsageRow;
  byAgent: (UsageRow & { agentId: string })[];
  byCard: (UsageRow & { cardId: string; key: string; title: string })[];
  byDay: (UsageRow & { day: string })[];
}

const METRICS = sql`
  count(*)::int as turns,
  coalesce(sum((e.payload->'usage'->>'inputTokens')::bigint), 0)::bigint as input_tokens,
  coalesce(sum((e.payload->'usage'->>'outputTokens')::bigint), 0)::bigint as output_tokens,
  coalesce(sum((e.payload->'contextUsage'->'cost'->>'amount')::float8), 0)::float8 as cost,
  coalesce(sum((e.payload->>'durationMs')::bigint), 0)::bigint as duration_ms`;

type RawRow = Record<string, unknown>;

const metrics = (r: RawRow): UsageRow => ({
  turns: Number(r.turns ?? 0),
  inputTokens: Number(r.input_tokens ?? 0),
  outputTokens: Number(r.output_tokens ?? 0),
  cost: Number(r.cost ?? 0),
  durationMs: Number(r.duration_ms ?? 0),
});

/**
 * Agent usage from the thread logs: every agent turn records tokens (when the agent
 * reports them), cost (when reported) and wall time. Scoped to a product when given.
 */
export async function usageReport(
  db: Db,
  opts: { productId?: string | null; days: number },
): Promise<UsageReport> {
  const since = new Date(Date.now() - opts.days * 86_400_000);
  const scope = opts.productId ? sql`and c.product_id = ${opts.productId}` : sql``;
  const from = sql`
    from thread_events e
    join threads t on t.id = e.thread_id
    left join cards c on c.id = t.card_id
    left join products p on p.id = c.product_id
    where e.kind = 'agent_message' and e.created_at >= ${since.toISOString()} ${scope}`;
  const rows = async (query: ReturnType<typeof sql>) => {
    const result = (await db.execute(query)) as unknown as { rows: RawRow[] };
    return result.rows;
  };

  const [total] = await rows(sql`select ${METRICS} ${from}`);
  const byAgent = await rows(
    sql`select substring(e.actor from 7) as agent_id, ${METRICS} ${from} group by e.actor order by turns desc`,
  );
  const byCard = await rows(sql`
    select c.id as card_id, p.key || '-' || c.number as key, c.title, ${METRICS} ${from}
      and c.id is not null
    group by c.id, p.key, c.number, c.title
    order by output_tokens desc, turns desc
    limit 50`);
  const byDay = await rows(
    sql`select to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD') as day, ${METRICS} ${from} group by 1 order by 1`,
  );

  return {
    since: since.toISOString(),
    total: metrics(total ?? {}),
    byAgent: byAgent.map((r) => ({ agentId: String(r.agent_id), ...metrics(r) })),
    byCard: byCard.map((r) => ({
      cardId: String(r.card_id),
      key: String(r.key),
      title: String(r.title),
      ...metrics(r),
    })),
    byDay: byDay.map((r) => ({ day: String(r.day), ...metrics(r) })),
  };
}
