import type { CardDto, ThreadEventDto, ThreadStreamEvent, TurnMode } from "@factory/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage, useResource, useStream } from "../hooks.js";
import { actorName } from "./format.js";
import type { WorkspaceContext } from "./Workspace.js";

/**
 * A live thread. Pick which agent gets your next message and whether it may change
 * files (drive) or only answer (consult): that's the model switch.
 */
export function ThreadView({
  ctx,
  threadId,
  card,
}: {
  ctx: WorkspaceContext;
  threadId: string;
  card: CardDto;
}) {
  const detail = useResource(() => ctx.api.thread(threadId), threadId);
  const [events, setEvents] = useState<ThreadEventDto[]>([]);
  const [live, setLive] = useState<{ agentId: string; text: string; tools: string[] } | null>(null);
  const [agentId, setAgentId] = useState(ctx.agents[0]?.id ?? "");
  const [mode, setMode] = useState<TurnMode>("consult");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showSent, setShowSent] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (detail.data) {
      setEvents(detail.data.events);
      if (detail.data.thread.driverAgentId) setAgentId(detail.data.thread.driverAgentId);
    }
  }, [detail.data]);

  useStream(ctx.bridge, `/threads/${threadId}/stream`, (data) => {
    const e = data as ThreadStreamEvent;
    if (e.type === "event") {
      setEvents((prev) => (prev.some((p) => p.seq === e.event.seq) ? prev : [...prev, e.event]));
      // A person we don't have a name for yet: refresh names.
      if (e.event.actor.startsWith("user:") && !detail.data?.names[e.event.actor])
        void detail.reload();
      if (e.event.kind === "agent_message") setLive(null);
    } else if (e.type === "turn") {
      setLive(e.state === "started" ? { agentId: e.agentId, text: "", tools: [] } : null);
    } else if (e.type === "chunk") {
      setLive((prev) => ({
        agentId: e.agentId,
        text: (prev?.text ?? "") + e.text,
        tools: prev?.tools ?? [],
      }));
    } else if (e.type === "tool") {
      setLive((prev) => ({
        agentId: e.agentId,
        text: prev?.text ?? "",
        tools: [...(prev?.tools ?? []), e.title],
      }));
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when content changes
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, live?.text.length]);

  const names = detail.data?.names ?? {};
  const running = live != null || (detail.data?.running ?? false);
  const workflowBusy = card.busy || card.state === "running";

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await ctx.api.send(threadId, agentId, text.trim(), mode);
      setText("");
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="thread">
      <div className="messages" aria-live="polite">
        {events.map((e) => (
          <Message
            key={e.id}
            event={e}
            who={actorName(e.actor, names, ctx.agentNames)}
            to={e.kind === "user_message" ? (ctx.agentNames[e.payload.to] ?? e.payload.to) : null}
            showSent={showSent === e.id}
            toggleSent={() => setShowSent(showSent === e.id ? null : e.id)}
          />
        ))}
        {live && (
          <div className="msg agent live">
            <div className="msg-head">
              <strong>{ctx.agentNames[live.agentId] ?? live.agentId}</strong>{" "}
              <span className="muted small">working…</span>
            </div>
            {live.tools.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              <div key={i} className="tool small">
                🔧 {t}
              </div>
            ))}
            <div className="prewrap">{live.text}</div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form className="composer" onSubmit={send}>
        {error && <p className="error small">{error}</p>}
        <textarea
          aria-label="Message"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e);
          }}
          placeholder={
            mode === "write"
              ? "Tell the agent what to do (it may change files)…"
              : "Ask a question (read-only)…"
          }
        />
        <div className="composer-bar">
          <select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {ctx.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <fieldset className="segmented" aria-label="Mode">
            <button
              type="button"
              aria-pressed={mode === "consult"}
              className={mode === "consult" ? "on" : ""}
              onClick={() => setMode("consult")}
            >
              Consult
            </button>
            <button
              type="button"
              aria-pressed={mode === "write"}
              className={mode === "write" ? "on" : ""}
              disabled={workflowBusy}
              title={
                workflowBusy ? "The workflow is running on this card" : "The agent may change files"
              }
              onClick={() => setMode("write")}
            >
              Drive
            </button>
          </fieldset>
          <span className="spacer" />
          {running && (
            <button type="button" className="ghost" onClick={() => void ctx.api.cancel(threadId)}>
              Stop
            </button>
          )}
          <button type="submit" disabled={!text.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function Message({
  event,
  who,
  to,
  showSent,
  toggleSent,
}: {
  event: ThreadEventDto;
  who: string;
  to: string | null;
  showSent: boolean;
  toggleSent: () => void;
}) {
  if (event.kind === "user_message" && event.actor === "workflow") {
    return <WorkflowMessage text={event.payload.text} to={to} mode={event.payload.mode} />;
  }
  if (event.kind === "user_message") {
    return (
      <div className="msg user">
        <div className="msg-head">
          <strong>{who}</strong>{" "}
          <span className="muted small">
            → {to} · {event.payload.mode === "consult" ? "consult" : "drive"}
          </span>
        </div>
        <div className="prewrap">{event.payload.text}</div>
      </div>
    );
  }
  if (event.kind === "error") {
    return <div className="msg error-msg small">⚠ {event.payload.message}</div>;
  }
  const p = event.payload;
  const tokens = p.usage ? ` · ${p.usage.inputTokens}→${p.usage.outputTokens} tok` : "";
  const cost = p.contextUsage?.cost
    ? ` · ${p.contextUsage.cost.amount.toFixed(3)} ${p.contextUsage.cost.currency}`
    : "";
  return (
    <div className="msg agent">
      <div className="msg-head">
        <strong>{who}</strong>{" "}
        <span className="muted small">
          {(p.durationMs / 1000).toFixed(1)}s · {p.sessionOrigin} session{tokens}
          {cost}
          {p.stopReason !== "end_turn" ? ` · ${p.stopReason}` : ""}
        </span>
        <button type="button" className="link small" onClick={toggleSent}>
          {showSent ? "hide context" : "what it saw"}
        </button>
      </div>
      {p.toolCalls.length > 0 && (
        <div className="tool small">🔧 {p.toolCalls.map((t) => t.title).join(" · ")}</div>
      )}
      <div className="prewrap">{p.text}</div>
      {p.changes.length > 0 && (
        <div className="changes small">
          Changed:{" "}
          {p.changes.map((c) => (
            <code key={c.path}>
              {c.path} <span className="added">+{c.added}</span>{" "}
              <span className="removed">−{c.removed}</span>
            </code>
          ))}
        </div>
      )}
      {showSent && <pre className="sent small">{p.sent}</pre>}
    </div>
  );
}

/** Prompts the workflow sent (step instructions, handover requests): collapsed by default. */
function WorkflowMessage({ text, to, mode }: { text: string; to: string | null; mode: TurnMode }) {
  const [open, setOpen] = useState(false);
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className="msg workflow">
      <button
        type="button"
        className="link small"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Workflow → {to} · {mode === "consult" ? "consult" : "drive"}
      </button>
      {open ? (
        <div className="prewrap small">{text}</div>
      ) : (
        <div className="muted small ellipsis">{firstLine}</div>
      )}
    </div>
  );
}
