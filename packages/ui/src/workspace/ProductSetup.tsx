import type { ProductDto } from "@factory/protocol";
import { type FormEvent, useId, useState } from "react";
import { errorMessage, useResource } from "../hooks.js";
import { Integrations } from "./Integrations.js";
import type { WorkspaceContext } from "./Workspace.js";

/** Create products and register their repos (paths as seen by the runner). */
export function ProductSetup({
  ctx,
  products,
  onDone,
  onCancel,
}: {
  ctx: WorkspaceContext;
  products: ProductDto[];
  onDone: (productId: string) => void;
  onCancel?: () => void;
}) {
  const [productId, setProductId] = useState<string>(products[0]?.id ?? "");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [repo, setRepo] = useState({ name: "", path: "", defaultBranch: "", checks: "" });
  const [error, setError] = useState<string | null>(null);
  const repos = useResource(productId ? () => ctx.api.repos(productId) : null, productId);
  const ids = {
    key: useId(),
    name: useId(),
    rname: useId(),
    rpath: useId(),
    rbranch: useId(),
    rchecks: useId(),
  };

  const createProduct = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await ctx.api.createProduct(key, name);
      setProductId(p.id);
      setKey("");
      setName("");
      setError(null);
      onDone(p.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const addRepo = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await ctx.api.addRepo(productId, {
        name:
          repo.name ||
          repo.path.replace(/["']/g, "").split(/[\\/]/).filter(Boolean).pop() ||
          "repo",
        path: repo.path,
        defaultBranch: repo.defaultBranch.trim() || undefined,
        checks: repo.checks
          .split("\n")
          .map((c) => c.trim())
          .filter(Boolean),
      });
      setRepo({ name: "", path: "", defaultBranch: "", checks: "" });
      setError(null);
      await repos.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="setup">
      <h2>Products & repos</h2>
      {error && <p className="error">{error}</p>}
      <section>
        <h3>New product</h3>
        <form onSubmit={createProduct} className="form-row">
          <label htmlFor={ids.key}>Key</label>
          <input
            id={ids.key}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="WEB"
            maxLength={10}
          />
          <label htmlFor={ids.name}>Name</label>
          <input
            id={ids.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Web app"
          />
          <button type="submit" disabled={!key || !name}>
            Create product
          </button>
        </form>
      </section>
      {products.length > 0 && (
        <section>
          <h3>Repos</h3>
          <select
            aria-label="Product for repos"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </select>
          <ul className="plain">
            {repos.data?.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong> <span className="muted">{r.path}</span> · base{" "}
                {r.defaultBranch} · checks: {r.checks.join(" && ") || "none"}
              </li>
            ))}
            {repos.data?.length === 0 && (
              <li className="muted">No repos yet. Cards need one to get a worktree.</li>
            )}
          </ul>
          <form onSubmit={addRepo} className="form-grid">
            <label htmlFor={ids.rpath}>Path on the server</label>
            <input
              id={ids.rpath}
              value={repo.path}
              onChange={(e) => setRepo({ ...repo, path: e.target.value })}
              placeholder="/srv/repos/web"
            />
            <label htmlFor={ids.rname}>Name</label>
            <input
              id={ids.rname}
              value={repo.name}
              onChange={(e) => setRepo({ ...repo, name: e.target.value })}
              placeholder="web"
            />
            <label htmlFor={ids.rbranch}>Base branch</label>
            <input
              id={ids.rbranch}
              value={repo.defaultBranch}
              onChange={(e) => setRepo({ ...repo, defaultBranch: e.target.value })}
              placeholder="detected from the repo"
            />
            <label htmlFor={ids.rchecks}>Checks (one per line)</label>
            <textarea
              id={ids.rchecks}
              rows={3}
              value={repo.checks}
              onChange={(e) => setRepo({ ...repo, checks: e.target.value })}
              placeholder={"pnpm lint\npnpm test"}
            />
            <span />
            <button type="submit" disabled={!repo.path || !productId}>
              Add repo
            </button>
          </form>
        </section>
      )}
      {productId && (
        <section>
          <h3>Integrations</h3>
          <p className="muted small">
            Tokens are never stored here: configs name server environment variables (e.g.{" "}
            <code>GITHUB_TOKEN</code>).
          </p>
          <Integrations ctx={ctx} productId={productId} />
        </section>
      )}
      {onCancel && (
        <button type="button" className="ghost" onClick={onCancel}>
          Back to the board
        </button>
      )}
    </div>
  );
}
