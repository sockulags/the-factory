import type { CardDetailDto, HandoverDto } from "@factory/protocol";
import { useEffect, useState } from "react";
import { errorMessage, useResource } from "../hooks.js";
import { STATE_LABEL, timeAgo } from "./format.js";
import { ThreadView } from "./ThreadView.js";
import type { WorkspaceContext } from "./Workspace.js";

type Tab =
  | { kind: "thread"; id: string }
  | { kind: "handovers" }
  | { kind: "history" }
  | { kind: "details" };

/** Everything about one card: gate actions, step progress, threads, handovers, history. */
export function CardPanel({
  ctx,
  cardId,
  changed,
  onClose,
}: {
  ctx: WorkspaceContext;
  cardId: string;
  changed: number;
  onClose: () => void;
}) {
  const detail = useResource(() => ctx.api.card(cardId), cardId);
  const [tab, setTab] = useState<Tab | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the card changes
  useEffect(() => {
    if (changed) void detail.reload();
  }, [changed]);

  const d = detail.data;
  // Default to the current step's thread; follow the card as it moves.
  const currentThread = d?.threads.find((t) => t.step === d.card.step) ?? d?.threads.at(-1);
  const activeTab: Tab =
    tab ?? (currentThread ? { kind: "thread", id: currentThread.id } : { kind: "details" });

  if (!d) {
    return (
      <aside className="panel">
        <div className="muted pad">{detail.error ?? "Loading…"}</div>
      </aside>
    );
  }
  const { card } = d;
  const workflow = ctx.workflows.find((w) => w.type === card.type);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      setComment("");
      await detail.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const lastError = [...d.events].reverse().find((e) => e.kind === "error" || e.kind === "blocked");

  return (
    <aside className="panel" aria-label={`Card ${card.key}`}>
      <header className="panel-head">
        <div>
          <span className="key">{card.key}</span>{" "}
          <span className="muted">· {workflow?.name ?? card.type}</span>
          <h2>{card.title}</h2>
        </div>
        <button type="button" className="ghost" aria-label="Close card" onClick={onClose}>
          ✕
        </button>
      </header>

      <ol className="steps" aria-label="Workflow steps">
        {workflow?.steps.map((s) => {
          const index = workflow.steps.findIndex((x) => x.id === card.step);
          const mine = workflow.steps.indexOf(s);
          const status =
            card.state === "done" || (card.step && mine < index)
              ? "past"
              : s.id === card.step
                ? `current state-${card.state}`
                : "future";
          return (
            <li key={s.id} className={status} title={`${s.agent} · ${s.mode} · gate: ${s.gate}`}>
              {s.name}
            </li>
          );
        })}
      </ol>

      <div className="actions">
        <span className={`badge state-${card.state}`}>
          {card.busy && card.state !== "running" ? "Working" : STATE_LABEL[card.state]}
        </span>
        {card.branch && <code className="small">{card.branch}</code>}
        {card.state === "backlog" && (
          <button type="button" onClick={() => void act(() => ctx.api.start(card.id))}>
            Start
          </button>
        )}
        {(card.state === "awaiting_gate" || card.state === "blocked") && (
          <div className="gate">
            {card.state === "blocked" && lastError && (
              <p className="error small">
                {String(
                  (lastError.payload as { message?: string; reason?: string }).message ??
                    (lastError.payload as { reason?: string }).reason ??
                    "Blocked",
                )}
              </p>
            )}
            <textarea
              aria-label="Comment"
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Comment (sent to the agent when you request changes)"
            />
            <div className="row-end">
              {card.state === "blocked" && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void act(() => ctx.api.retry(card.id))}
                >
                  Retry step
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={!comment.trim()}
                onClick={() =>
                  void act(() => ctx.api.decide(card.id, "changes_requested", comment))
                }
              >
                Request changes
              </button>
              <button
                type="button"
                onClick={() =>
                  void act(() => ctx.api.decide(card.id, "approved", comment || undefined))
                }
              >
                Approve
              </button>
            </div>
          </div>
        )}
        {(card.state === "done" || card.state === "awaiting_gate" || card.state === "blocked") && (
          <button
            type="button"
            className="ghost small"
            onClick={() => void act(() => ctx.api.close(card.id))}
          >
            Close card
          </button>
        )}
      </div>
      {error && <p className="error pad">{error}</p>}

      <div className="tabs" role="tablist">
        {d.threads.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.id}
            aria-selected={activeTab.kind === "thread" && activeTab.id === t.id}
            className={activeTab.kind === "thread" && activeTab.id === t.id ? "tab active" : "tab"}
            onClick={() => setTab({ kind: "thread", id: t.id })}
          >
            {workflow?.steps.find((s) => s.id === t.step)?.name ?? t.title}
          </button>
        ))}
        {(["handovers", "history", "details"] as const).map((k) => (
          <button
            type="button"
            role="tab"
            key={k}
            aria-selected={activeTab.kind === k}
            className={activeTab.kind === k ? "tab active" : "tab"}
            onClick={() => setTab({ kind: k })}
          >
            {k === "handovers"
              ? `Handovers (${d.handovers.length})`
              : k === "history"
                ? "History"
                : "Details"}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {activeTab.kind === "thread" && (
          <ThreadView key={activeTab.id} ctx={ctx} threadId={activeTab.id} card={card} />
        )}
        {activeTab.kind === "handovers" && <Handovers handovers={d.handovers} />}
        {activeTab.kind === "history" && <History detail={d} />}
        {activeTab.kind === "details" && (
          <div className="pad">
            <p className="prewrap">{card.body || <span className="muted">No description.</span>}</p>
            {card.worktreePath && <p className="muted small">Worktree: {card.worktreePath}</p>}
          </div>
        )}
      </div>
    </aside>
  );
}

function Handovers({ handovers }: { handovers: HandoverDto[] }) {
  if (!handovers.length)
    return <p className="muted pad">No handovers yet. Each step ends with one.</p>;
  return (
    <div className="pad handovers">
      {[...handovers].reverse().map((h) => (
        <article key={h.id} className="handover">
          <h4>
            {h.step} <span className="muted small">{timeAgo(h.createdAt)}</span>
          </h4>
          {h.content.format === "raw" ? (
            <>
              <p className="muted small">Unstructured ({h.content.error})</p>
              <p className="prewrap">{h.content.text}</p>
            </>
          ) : (
            <dl>
              <dt>Goal</dt>
              <dd>{h.content.handover.goal}</dd>
              <List
                title="Decisions"
                items={h.content.handover.decisions.map((d) => `${d.decision} — ${d.why}`)}
              />
              <List
                title="Rejected"
                items={h.content.handover.rejected.map((r) => `${r.option} — ${r.why}`)}
              />
              <List
                title="Files touched"
                items={h.content.handover.filesTouched.map((f) => `${f.path} — ${f.why}`)}
              />
              <List title="How to verify" items={h.content.handover.verify} />
              <List title="Open questions" items={h.content.handover.openQuestions} />
            </dl>
          )}
        </article>
      ))}
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <dt>{title}</dt>
      <dd>
        <ul>
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </dd>
    </>
  );
}

function History({ detail }: { detail: CardDetailDto }) {
  return (
    <ul className="pad plain history">
      {[...detail.events].reverse().map((e) => (
        <li key={e.id}>
          <span className="muted small">{timeAgo(e.createdAt)}</span>{" "}
          <strong>{e.kind.replace(/_/g, " ")}</strong>{" "}
          <span className="muted small">{summarize(e.payload)}</span>
        </li>
      ))}
    </ul>
  );
}

function summarize(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([, v]) => v != null && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}
