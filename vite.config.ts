import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Camera access requires HTTPS on phones; basic-ssl provides a self-signed cert for `npm run dev`.
export default defineConfig({
  base: "./",
  plugins: [basicSsl()],
  server: { host: true },
  preview: { host: true },
  worker: { format: "es" },
  // public/cimbar/cimbar-worker.js is not content-hashed: its URL carries the build id to bypass stale caches.
  define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(Date.now().toString(36)) },
  build: { target: "es2022" },
});
