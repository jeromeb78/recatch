import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  // In development, mirror the production rewrites so the Claude connector URL works at localhost too.
  const mcp = env.VITE_SUPABASE_URL ? `${env.VITE_SUPABASE_URL}/functions/v1/mcp` : undefined;
  const to = (path: string) => ({ target: mcp, changeOrigin: true, rewrite: () => new URL(mcp! + path).pathname });
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: mcp
        ? {
          "^/mcp$": to(""),
          "/.well-known/oauth-protected-resource": to("/.well-known/oauth-protected-resource"),
          "/.well-known/oauth-authorization-server": to("/.well-known/oauth-authorization-server"),
          "/oauth/register": to("/oauth/register"),
          "/oauth/token": to("/oauth/token"),
        }
        : undefined,
    },
  };
});
