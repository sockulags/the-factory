import { z } from "zod";
import { pullRequestBody } from "./pr-body.js";
import { type FactoryPlugin, secret } from "./types.js";

const Config = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** Name of the server env var holding a token with contents + pull request write access. */
  tokenEnv: z.string().min(1).default("GITHUB_TOKEN"),
  /** GitHub Enterprise: https://ghe.example.com/api/v3 */
  apiUrl: z.url().default("https://api.github.com"),
  /** Where to push; defaults to the https remote of owner/repo on the same host. */
  remote: z.string().optional(),
  draft: z.boolean().default(false),
});
type Config = z.infer<typeof Config>;

export function githubPlugin(deps: { fetch?: typeof fetch } = {}): FactoryPlugin<Config> {
  const doFetch = deps.fetch ?? fetch;
  return {
    id: "github",
    name: "GitHub",
    description: "Pushes the card branch and opens a pull request (hook: vcs.open_pr).",
    config: Config,
    exampleConfig: { owner: "acme", repo: "web", tokenEnv: "GITHUB_TOKEN", draft: false },
    hooks: {
      "vcs.open_pr": async ({ card, repo, board, runner, config, env }) => {
        if (!card.worktreePath || !card.branch || !repo)
          throw new Error("card has no branch to open a PR from");
        const token = secret(env, config.tokenEnv, "GitHub");
        const remote = config.remote ?? defaultRemote(config);
        await runner.push(card.worktreePath, remote, card.branch, {
          username: "x-access-token",
          password: token,
        });

        const api = `${config.apiUrl.replace(/\/$/, "")}/repos/${config.owner}/${config.repo}`;
        const headers = {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": "the-factory",
        };
        const title = `${card.key}: ${card.title}`;
        let res = await doFetch(`${api}/pulls`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title,
            head: card.branch,
            base: repo.defaultBranch,
            body: await pullRequestBody(board, card),
            draft: config.draft,
          }),
        });
        let pr: { number: number; html_url: string; title: string } | undefined;
        if (res.status === 422) {
          // Already open for this branch (e.g. after a re-run): reuse it.
          res = await doFetch(
            `${api}/pulls?head=${encodeURIComponent(`${config.owner}:${card.branch}`)}&state=open`,
            {
              headers,
            },
          );
          pr = ((await res.json()) as (typeof pr)[])[0];
        } else if (res.ok) {
          pr = (await res.json()) as typeof pr;
        }
        if (!pr)
          throw new Error(
            `GitHub: could not open a pull request (HTTP ${res.status}: ${await safeText(res)})`,
          );
        await board.addLink({
          cardId: card.id,
          plugin: "github",
          kind: "pull_request",
          ref: String(pr.number),
          url: pr.html_url,
          title: pr.title,
        });
        return { pullRequest: pr.number, url: pr.html_url };
      },
    },
  };
}

function defaultRemote(config: Config): string {
  const host =
    config.apiUrl === "https://api.github.com" ? "github.com" : new URL(config.apiUrl).host;
  return `https://${host}/${config.owner}/${config.repo}.git`;
}

async function safeText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}
