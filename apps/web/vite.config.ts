import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/projects": "http://localhost:8787",
      "/workspaces": "http://localhost:8787",
    },
  },
});
