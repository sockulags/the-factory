import type { ProductDto } from "@factory/protocol";
import { type FormEvent, useId, useState } from "react";
import { errorMessage } from "../hooks.js";
import type { WorkspaceContext } from "./Workspace.js";

export function NewCardDialog({
  ctx,
  product,
  onClose,
  onCreated,
}: {
  ctx: WorkspaceContext;
  product: ProductDto;
  onClose: () => void;
  onCreated: (cardId: string) => void;
}) {
  const [type, setType] = useState(ctx.workflows[0]?.type ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { type: useId(), title: useId(), body: useId() };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const card = await ctx.api.createCard(product.id, { type, title, body });
      onCreated(card.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <form className="dialog" onSubmit={submit} aria-label="New card">
        <h2>New card in {product.key}</h2>
        {error && <p className="error">{error}</p>}
        <label htmlFor={ids.type}>Type</label>
        <select id={ids.type} value={type} onChange={(e) => setType(e.target.value)}>
          {ctx.workflows.map((w) => (
            <option key={w.type} value={w.type}>
              {w.name}
            </option>
          ))}
        </select>
        <p className="muted small">{ctx.workflows.find((w) => w.type === type)?.description}</p>
        <label htmlFor={ids.title}>Title</label>
        <input
          id={ids.title}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
        <label htmlFor={ids.body}>Description</label>
        <textarea
          id={ids.body}
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What's wrong or what's needed, with any context an agent should know."
        />
        <div className="row-end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={!title.trim() || busy}>
            Create in backlog
          </button>
        </div>
      </form>
    </div>
  );
}
