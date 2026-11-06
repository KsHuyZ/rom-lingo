import { createAuthClient } from "better-auth/react";
import { oneTapClient } from "better-auth/client/plugins";

/** Public OAuth client id (same value as the server's GOOGLE_CLIENT_ID; not a secret). */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

// Same origin as the app, so no baseURL needed.
export const authClient = createAuthClient({
  plugins: GOOGLE_CLIENT_ID ? [oneTapClient({ clientId: GOOGLE_CLIENT_ID })] : [],
});

type OneTap = (opts: Record<string, unknown>) => Promise<void>;
/** `oneTap` exists only when the plugin is registered (client id configured). */
export const oneTap = (authClient as unknown as { oneTap?: OneTap }).oneTap;
