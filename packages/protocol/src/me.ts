import { z } from "zod";

export const Me = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  roles: z.array(z.string()),
  /** Holds the admin role: may manage products, repos and integrations. */
  isAdmin: z.boolean().default(false),
});
export type Me = z.infer<typeof Me>;
