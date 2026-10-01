import { z } from "zod";
import { type FactoryPlugin, secret } from "./types.js";

const Config = z.object({
  /** Env var holding the incoming-webhook URL (Slack, Teams, …). */
  urlEnv: z.string().min(1),
  format: z.enum(["slack", "json"]).default("slack"),
});

/** Posts a message when a workflow runs the `notify.webhook` hook. */
export function webhookPlugin(
  deps: { fetch?: typeof fetch } = {},
): FactoryPlugin<z.infer<typeof Config>> {
  const doFetch = deps.fetch ?? fetch;
  return {
    id: "webhook",
    name: "Webhook notifications",
    description: "Posts card progress to a chat or HTTP endpoint (hook: notify.webhook).",
    config: Config,
    exampleConfig: { urlEnv: "SLACK_WEBHOOK_URL", format: "slack" },
    hooks: {
      "notify.webhook": async ({ card, step, board, config, env }) => {
        const url = secret(env, config.urlEnv, "Webhook");
        const links = await board.links(card.id);
        const text = `${card.key} "${card.title}" finished ${step.name}${links.length ? ` · ${links.map((l) => l.url).join(" ")}` : ""}`;
        const body =
          config.format === "slack"
            ? { text }
            : {
                card: { key: card.key, title: card.title, state: card.state },
                step: step.id,
                links,
                text,
              };
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Webhook: HTTP ${res.status}`);
        return { delivered: true };
      },
    },
  };
}
