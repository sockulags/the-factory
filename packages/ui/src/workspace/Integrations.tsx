import type { PluginConfigDto, PluginDto } from "@factory/protocol";
import { useEffect, useState } from "react";
import { errorMessage, useResource } from "../hooks.js";
import type { WorkspaceContext } from "./Workspace.js";

/** Per-product plugin settings. Secrets are env var names on the server, never values. */
export function Integrations({ ctx, productId }: { ctx: WorkspaceContext; productId: string }) {
  const plugins = useResource(() => ctx.api.plugins(), "plugins");
  const configs = useResource(() => ctx.api.pluginConfigs(productId), productId);
  if (!plugins.data || !configs.data)
    return <p className="muted">{plugins.error ?? configs.error ?? "Loading…"}</p>;
  return (
    <div className="integrations">
      {plugins.data.map((p) => (
        <PluginCard
          key={p.id}
          ctx={ctx}
          productId={productId}
          plugin={p}
          current={configs.data?.find((c) => c.plugin === p.id) ?? null}
          onSaved={() => void configs.reload()}
        />
      ))}
    </div>
  );
}

function PluginCard({
  ctx,
  productId,
  plugin,
  current,
  onSaved,
}: {
  ctx: WorkspaceContext;
  productId: string;
  plugin: PluginDto;
  current: PluginConfigDto | null;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [text, setText] = useState(
    JSON.stringify(current?.config ?? plugin.exampleConfig, null, 2),
  );
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    setEnabled(current?.enabled ?? false);
    if (current) setText(JSON.stringify(current.config, null, 2));
  }, [current]);

  const save = async () => {
    try {
      const config = JSON.parse(text) as Record<string, unknown>;
      await ctx.api.configurePlugin(productId, plugin.id, enabled, config);
      setStatus({ ok: true, message: "Saved" });
      onSaved();
    } catch (err) {
      setStatus({
        ok: false,
        message: err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : errorMessage(err),
      });
    }
  };

  return (
    <article className="plugin" aria-label={plugin.name}>
      <header className="row">
        <label className="row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <strong>{plugin.name}</strong>
        </label>
        {current && <span className="muted small">{current.enabled ? "enabled" : "disabled"}</span>}
      </header>
      <p className="muted small">{plugin.description}</p>
      <textarea
        aria-label={`${plugin.name} configuration`}
        rows={Math.min(12, text.split("\n").length + 1)}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        className="mono"
      />
      <div className="row-end">
        {status && <span className={status.ok ? "small ok" : "small error"}>{status.message}</span>}
        <button type="button" onClick={() => void save()}>
          Save
        </button>
      </div>
    </article>
  );
}
