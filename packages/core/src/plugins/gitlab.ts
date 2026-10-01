import { z } from "zod";
import { pullRequestBody } from "./pr-body.js";
import { type FactoryPlugin, secret } from "./types.js";

const Config = z.object({
  /** e.g. https://gitlab.example.com */
  baseUrl: z.url().default("https://gitlab.com"),
  /** Project path, e.g. group/subgroup/web */
  project: z.string().min(1),
  tokenEnv: z.string().min(1).default("GITLAB_TOKEN"),
  remote: z.string().optional(),
  draft: z.boolean().default(false),
});
type Config = z.infer<typeof Config>;

export function gitlabPlugin(deps: { fetch?: typeof fetch } = {}): FactoryPlugin<Config> {
  const doFetch = deps.fetch ?? fetch;
  return {
    id: "gitlab",
    name: "GitLab",
    description: "Pushes the card branch and opens a merge request (hook: vcs.open_pr).",
    config: Config,
    exampleConfig: {
      baseUrl: "https://gitlab.example.com",
      project: "group/web",
      tokenEnv: "GITLAB_TOKEN",
    },
    hooks: {
      "vcs.open_pr": async ({ card, repo, board, runner, config, env }) => {
        if (!card.worktreePath || !card.branch || !repo)
          throw new Error("card has no branch to open an MR from");
        const token = secret(env, config.tokenEnv, "GitLab");
        const base = config.baseUrl.replace(/\/$/, "");
        const remote = config.remote ?? `${base}/${config.project}.git`;
        await runner.push(card.worktreePath, remote, card.branch, {
          username: "oauth2",
          password: token,
        });

        const api = `${base}/api/v4/projects/${encodeURIComponent(config.project)}/merge_requests`;
        const headers = { "private-token": token, "content-type": "application/json" };
        const title = `${config.draft ? "Draft: " : ""}${card.key}: ${card.title}`;
        let res = await doFetch(api, {
          method: "POST",
          headers,
          body: JSON.stringify({
            source_branch: card.branch,
            target_branch: repo.defaultBranch,
            title,
            description: await pullRequestBody(board, card),
          }),
        });
        let mr: { iid: number; web_url: string; title: string } | undefined;
        if (res.status === 409) {
          res = await doFetch(
            `${api}?source_branch=${encodeURIComponent(card.branch)}&state=opened`,
            { headers },
          );
          mr = ((await res.json()) as (typeof mr)[])[0];
        } else if (res.ok) {
          mr = (await res.json()) as typeof mr;
        }
        if (!mr) throw new Error(`GitLab: could not open a merge request (HTTP ${res.status})`);
        await board.addLink({
          cardId: card.id,
          plugin: "gitlab",
          kind: "merge_request",
          ref: String(mr.iid),
          url: mr.web_url,
          title: mr.title,
        });
        return { mergeRequest: mr.iid, url: mr.web_url };
      },
    },
  };
}
