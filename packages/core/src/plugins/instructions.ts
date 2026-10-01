import { z } from "zod";
import type { FactoryPlugin } from "./types.js";

const Config = z.object({ text: z.string().max(10_000).default("") });

/** House rules for every step of every card in a product (conventions, links, do's and don'ts). */
export function instructionsPlugin(): FactoryPlugin<z.infer<typeof Config>> {
  return {
    id: "instructions",
    name: "Product instructions",
    description:
      "Text added to the first prompt of every step, e.g. conventions or where to find things.",
    config: Config,
    exampleConfig: {
      text: "Reference the Jira key (e.g. WEB-123) in commit messages. Never edit generated files in src/gen/.",
    },
    instructions: (config) => config.text,
  };
}
