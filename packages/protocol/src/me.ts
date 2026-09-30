import { z } from "zod";

export const Me = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  roles: z.array(z.string()),
});
export type Me = z.infer<typeof Me>;
