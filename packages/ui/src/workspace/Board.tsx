import type { CardDto, CardState, ProductDto } from "@factory/protocol";
import { type DragEvent, useEffect, useState } from "react";
import { errorMessage, useResource } from "../hooks.js";
import { STATE_LABEL, stepName, timeAgo } from "./format.js";
import type { WorkspaceContext } from "./Workspace.js";

interface Column {
  id: string;
  title: string;
  /** Step to move a dropped card into (typed boards only). */
  dropStep?: string;
  /** Drop from backlog = start. */
  startsCard?: boolean;
  cards: CardDto[];
}

const STATUS_COLUMNS: { id: string; title: string; states: CardState[] }[] = [
  { id: "backlog", title: "Backlog", states: ["backlog"] },
  { id: "running", title: "Running", states: ["running"] },
  { id: "needs-you", title: "Needs you", states: ["awaiting_gate", "blocked"] },
  { id: "done", title: "Done", states: ["done"] },
];

/**
 * Kanban board. "All" groups cards by what they need (running / needs you / …);
 * picking a card type shows that workflow's steps as columns, and cards can be dragged
 * between them.
 */
export function Board({
  ctx,
  product,
  changeTick,
  selected,
  onSelect,
}: {
  ctx: WorkspaceContext;
  product: ProductDto;
  changeTick: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const cards = useResource(() => ctx.api.cards(product.id), product.id);
  const [type, setType] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on every change notification
  useEffect(() => {
    if (changeTick) void cards.reload();
  }, [changeTick]);

  const visible = (cards.data ?? []).filter(
    (c) => c.state !== "closed" && (type === "all" || c.type === type),
  );
  const workflow = ctx.workflows.find((w) => w.type === type);

  const columns: Column[] = workflow
    ? [
        { id: "backlog", title: "Backlog", cards: visible.filter((c) => c.state === "backlog") },
        ...workflow.steps.map((s, i) => ({
          id: s.id,
          title: s.name,
          dropStep: s.id,
          startsCard: i === 0,
          cards: visible.filter(
            (c) => c.step === s.id && c.state !== "done" && c.state !== "backlog",
          ),
        })),
        { id: "done", title: "Done", cards: visible.filter((c) => c.state === "done") },
      ]
    : STATUS_COLUMNS.map((col) => ({
        id: col.id,
        title: col.title,
        startsCard: col.id === "running",
        cards: visible.filter((c) => col.states.includes(c.state)),
      }));

  const drop = async (column: Column, e: DragEvent) => {
    e.preventDefault();
    const card = cards.data?.find((c) => c.id === e.dataTransfer.getData("text/card-id"));
    setDragging(null);
    if (!card) return;
    try {
      if (card.state === "backlog" && column.startsCard) await ctx.api.start(card.id);
      else if (column.dropStep && column.dropStep !== card.step)
        await ctx.api.move(card.id, column.dropStep);
      else return;
      setError(null);
      await cards.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="board" aria-label="Board">
      <div className="board-toolbar">
        <div className="chips" role="tablist">
          {[{ type: "all", name: "All" }, ...ctx.workflows].map((w) => (
            <button
              type="button"
              role="tab"
              aria-selected={type === w.type}
              key={w.type}
              className={type === w.type ? "chip active" : "chip"}
              onClick={() => setType(w.type)}
            >
              {w.name}
            </button>
          ))}
        </div>
        {error && <span className="error small">{error}</span>}
        {cards.error && <span className="error small">{cards.error}</span>}
      </div>
      <div className="columns">
        {columns.map((col) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: drop target for mouse drag; the card panel offers the same actions
          <div
            key={col.id}
            className={dragging && (col.dropStep || col.startsCard) ? "column droppable" : "column"}
            onDragOver={(e) => {
              if (col.dropStep || col.startsCard) e.preventDefault();
            }}
            onDrop={(e) => void drop(col, e)}
            data-column={col.id}
          >
            <h3>
              {col.title} <span className="count">{col.cards.length}</span>
            </h3>
            {col.cards.map((card) => (
              <button
                type="button"
                key={card.id}
                className={card.id === selected ? "card selected" : "card"}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/card-id", card.id);
                  setDragging(card.id);
                }}
                onDragEnd={() => setDragging(null)}
                onClick={() => onSelect(card.id)}
              >
                <span className="card-top">
                  <span className="key">{card.key}</span>
                  <span className={`badge state-${card.state}`}>
                    {card.busy && card.state !== "running" ? "Working" : STATE_LABEL[card.state]}
                  </span>
                </span>
                <span className="title">{card.title}</span>
                <span className="card-meta muted small">
                  {type === "all" ? `${card.type} · ${stepName(ctx.workflows, card)} · ` : ""}
                  {timeAgo(card.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
