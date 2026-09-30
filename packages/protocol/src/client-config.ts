import { z } from "zod";

export const OidcAuthConfig = z.object({
  mode: z.literal("oidc"),
  /** e.g. https://sso.example.com/realms/factory */
  issuer: z.url(),
  clientId: z.string().min(1),
  scopes: z.array(z.string()).default(["openid", "profile", "email", "offline_access"]),
});

export const DevAuthConfig = z.object({
  mode: z.literal("dev"),
});

export const AuthConfig = z.discriminatedUnion("mode", [OidcAuthConfig, DevAuthConfig]);
export type AuthConfig = z.infer<typeof AuthConfig>;

/**
 * Public, unauthenticated bootstrap config. The desktop app fetches this from the
 * server URL the user entered to learn how to sign in and where updates live.
 */
export const ClientConfig = z.object({
  serverVersion: z.string(),
  minClientVersion: z.string(),
  auth: AuthConfig,
  updates: z.object({
    /** Base URL of the update feed; the channel name is appended (…/updates/stable). */
    baseUrl: z.url(),
    channels: z.array(z.string()).min(1),
  }),
});
export type ClientConfig = z.infer<typeof ClientConfig>;
