import { createAuthClient } from "better-auth/react";

// Same origin as the app, so no baseURL needed.
export const authClient = createAuthClient();
