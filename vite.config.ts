import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Read PORT from .env so the proxy targets the same port as the API server.
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.PORT || "8787";

  return {
    root: "src/client",
    plugins: [
      {
        // The comments in index.html are notes for developers. Keep them out of the built page.
        name: "strip-html-comments",
        apply: "build",
        transformIndexHtml: (html) => html.replace(/<!--[\s\S]*?-->/g, ""),
      },
    ],
    build: {
      outDir: "../../dist/client",
      emptyOutDir: true,
    },
    server: {
      port: 5188,
      strictPort: true,
      proxy: {
        // Trailing slash matters: "/api" would also proxy the client module /api.ts.
        // 127.0.0.1, not localhost: the API listens on IPv4 only, and localhost can resolve to ::1.
        "/api/": `http://127.0.0.1:${apiPort}`,
      },
    },
  };
});
