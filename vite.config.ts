import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Camera access requires HTTPS on phones; basic-ssl provides a self-signed cert for `npm run dev`.
export default defineConfig({
  base: "./",
  plugins: [basicSsl()],
  server: { host: true },
  preview: { host: true },
  worker: { format: "es" },
  build: { target: "es2022" },
});
