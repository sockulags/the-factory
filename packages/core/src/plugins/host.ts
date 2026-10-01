import type { McpServer } from "@agentclientprotocol/sdk";
import { type Db, schema } from "@factory/db";
import { and, eq } from "drizzle-orm";
import type { Card } from "../board.js";
import type { Hook } from "../workflow/engine.js";
import type { FactoryPlugin } from "./types.js";

const { pluginConfigs } = schema;

export interface PluginConfigView {
  plugin: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export class PluginError extends Error {}

/** Resolves which plugins a product has enabled and what they contribute. */
export class PluginHost {
  private readonly byId: Map<string, FactoryPlugin>;

  constructor(
    private readonly db: Db,
    plugins: FactoryPlugin[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.byId = new Map(plugins.map((p) => [p.id, p]));
  }

  list(): FactoryPlugin[] {
    return [...this.byId.values()];
  }

  async configs(productId: string): Promise<PluginConfigView[]> {
    const rows = await this.db
      .select()
      .from(pluginConfigs)
      .where(eq(pluginConfigs.productId, productId));
    return rows.map((r) => ({ plugin: r.plugin, enabled: r.enabled, config: r.config }));
  }

  /** Validates and stores a product's config for a plugin. */
  async configure(
    productId: string,
    pluginId: string,
    input: { enabled: boolean; config: unknown },
  ): Promise<PluginConfigView> {
    const plugin = this.byId.get(pluginId);
    if (!plugin) throw new PluginError(`unknown plugin "${pluginId}"`);
    const parsed = plugin.config.safeParse(input.config);
    if (!parsed.success) {
      throw new PluginError(
        `${plugin.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}`,
      );
    }
    const config = parsed.data as Record<string, unknown>;
    await this.db
      .insert(pluginConfigs)
      .values({ productId, plugin: pluginId, enabled: input.enabled, config })
      .onConflictDoUpdate({
        target: [pluginConfigs.productId, pluginConfigs.plugin],
        set: { enabled: input.enabled, config, updatedAt: new Date() },
      });
    return { plugin: pluginId, enabled: input.enabled, config };
  }

  /**
   * Finds the hook a workflow names for a card's product. `vcs.open_pr` resolves to the
   * first enabled plugin providing it; `github.open_pr` (plugin id prefix) picks one explicitly.
   */
  async resolveHook(card: Card, name: string): Promise<Hook | null> {
    for (const { plugin, config } of await this.enabled(card.productId)) {
      const hook =
        plugin.hooks?.[name] ??
        (name.startsWith(`${plugin.id}.`)
          ? plugin.hooks?.[name.slice(plugin.id.length + 1)]
          : undefined);
      if (hook) return (ctx) => hook({ ...ctx, config, env: this.env });
    }
    return null;
  }

  async mcpServersFor(productId: string): Promise<McpServer[]> {
    const servers: McpServer[] = [];
    for (const { plugin, config } of await this.enabled(productId)) {
      servers.push(...(plugin.mcpServers?.(config, this.env) ?? []));
    }
    return servers;
  }

  async instructionsFor(productId: string): Promise<string> {
    const parts: string[] = [];
    for (const { plugin, config } of await this.enabled(productId)) {
      const text = plugin.instructions?.(config);
      if (text?.trim()) parts.push(text.trim());
    }
    return parts.join("\n\n");
  }

  private async enabled(productId: string) {
    const rows = await this.db
      .select()
      .from(pluginConfigs)
      .where(and(eq(pluginConfigs.productId, productId), eq(pluginConfigs.enabled, true)));
    const out: { plugin: FactoryPlugin; config: Record<string, unknown> }[] = [];
    for (const row of rows) {
      const plugin = this.byId.get(row.plugin);
      if (plugin) out.push({ plugin, config: row.config });
    }
    return out;
  }
}
