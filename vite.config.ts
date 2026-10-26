import { execSync } from "node:child_process";
import { defineConfig, loadEnv } from "vite";

/** Short git commit of the build, or "unknown" outside a git checkout. */
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig(({ mode }) => {
  // Read PORT from .env so the proxy targets the same port as the API server.
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.PORT || "8787";
  const commit = gitCommit();

  return {
    root: "src/client",
    // Commit and build time, shown in the ?debug event log, to see which version a phone runs.
    define: {
      __BUILD_COMMIT__: JSON.stringify(commit),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")),
      // OAuth client for the Google Drive backup. Empty turns the backup off.
      __GOOGLE_CLIENT_ID__: JSON.stringify(env.GOOGLE_CLIENT_ID ?? ""),
    },
    plugins: [
      {
        // The footer shows the build commit, with a link to it on GitHub.
        name: "build-commit-html",
        transformIndexHtml: (html) => html.replaceAll("{{BUILD_COMMIT}}", commit),
      },
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
