import type {
  AgentDto,
  BoardStreamEvent,
  DesktopBridge,
  DesktopState,
  ProductDto,
  WorkflowDto,
} from "@factory/protocol";
import { useMemo, useState } from "react";
import { createApi } from "../api.js";
import { useResource, useStream } from "../hooks.js";
import { Board } from "./Board.js";
import { CardPanel } from "./CardPanel.js";
import { NewCardDialog } from "./NewCardDialog.js";
import { ProductSetup } from "./ProductSetup.js";
import { UsageView } from "./UsageView.js";

export interface WorkspaceContext {
  bridge: DesktopBridge;
  api: ReturnType<typeof createApi>;
  agents: AgentDto[];
  agentNames: Record<string, string>;
  workflows: WorkflowDto[];
}

/** Signed-in app: product picker, board, card panel. */
export function Workspace({ bridge, state }: { bridge: DesktopBridge; state: DesktopState }) {
  const api = useMemo(() => createApi(bridge), [bridge]);
  const agents = useResource(() => api.agents(), "agents");
  const workflows = useResource(() => api.workflows(), "workflows");
  const products = useResource(() => api.products(), "products");
  const [productId, setProductId] = useState<string | null>(() =>
    localStorage.getItem("factory.product"),
  );
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [setup, setSetup] = useState(false);
  const [view, setView] = useState<"board" | "usage">("board");
  const [changeTick, setChangeTick] = useState(0);
  const [lastChanged, setLastChanged] = useState<string | null>(null);

  useStream(bridge, "/stream", (data) => {
    const event = data as BoardStreamEvent;
    if (event.type === "card") {
      setLastChanged(event.cardId);
      setChangeTick((t) => t + 1);
    }
  });

  const product: ProductDto | undefined =
    products.data?.find((p) => p.id === productId) ?? products.data?.[0] ?? undefined;
  const choose = (id: string) => {
    setProductId(id);
    setSelectedCard(null);
    try {
      localStorage.setItem("factory.product", id);
    } catch {
      // storage unavailable: fine
    }
  };

  if (!agents.data || !workflows.data || !products.data) {
    const error = agents.error ?? workflows.error ?? products.error;
    return (
      <div className="center-fill muted">{error ? `Could not load: ${error}` : "Loading…"}</div>
    );
  }

  const ctx: WorkspaceContext = {
    bridge,
    api,
    agents: agents.data,
    agentNames: Object.fromEntries(agents.data.map((a) => [a.id, a.name])),
    workflows: workflows.data,
  };

  const isAdmin = state.me?.isAdmin ?? false;
  const showSetup = !product || setup;

  return (
    <div className="workspace">
      <header className="topbar">
        <strong className="brand">The Factory</strong>
        {product && (
          <select aria-label="Product" value={product.id} onChange={(e) => choose(e.target.value)}>
            {products.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </select>
        )}
        {product && (
          <nav className="views" aria-label="Views">
            {(["board", "usage"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={view === v && !setup ? "ghost active" : "ghost"}
                aria-current={view === v && !setup ? "page" : undefined}
                onClick={() => {
                  setView(v);
                  setSetup(false);
                }}
              >
                {v === "board" ? "Board" : "Usage"}
              </button>
            ))}
          </nav>
        )}
        {isAdmin && (
          <button type="button" className="ghost" onClick={() => setSetup(true)}>
            Products & repos
          </button>
        )}
        <span className="spacer" />
        {product && !setup && (
          <button type="button" onClick={() => setCreating(true)}>
            New card
          </button>
        )}
        {(state.clientConfig?.updates.channels.length ?? 0) > 1 && (
          <select
            aria-label="Update channel"
            title="Update channel"
            value={state.channel}
            onChange={(e) => void bridge.setChannel(e.target.value)}
          >
            {state.clientConfig?.updates.channels.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        )}
        <span className="muted user" data-testid="connected-as">
          {state.me?.name ?? state.me?.username}
        </span>
        <button type="button" className="ghost" onClick={() => void bridge.signOut()}>
          Sign out
        </button>
      </header>
      {!product && !isAdmin ? (
        <div className="center-fill muted pad">
          No products yet. Ask someone with the admin role to create one under Products &amp; repos.
        </div>
      ) : showSetup || !product ? (
        <ProductSetup
          ctx={ctx}
          products={products.data}
          onDone={async (id) => {
            await products.reload();
            choose(id);
            setSetup(false);
          }}
          onCancel={product ? () => setSetup(false) : undefined}
        />
      ) : view === "usage" ? (
        <UsageView ctx={ctx} productId={product.id} productKey={product.key} />
      ) : (
        <div className={selectedCard ? "main with-panel" : "main"}>
          <Board
            ctx={ctx}
            product={product}
            changeTick={changeTick}
            selected={selectedCard}
            onSelect={setSelectedCard}
          />
          {selectedCard && (
            <CardPanel
              key={selectedCard}
              ctx={ctx}
              cardId={selectedCard}
              changed={lastChanged === selectedCard ? changeTick : 0}
              onClose={() => setSelectedCard(null)}
            />
          )}
        </div>
      )}
      {creating && product && (
        <NewCardDialog
          ctx={ctx}
          product={product}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelectedCard(id);
          }}
        />
      )}
    </div>
  );
}
