import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "../src") },
    dedupe: ["react", "react-dom"],
  },
  css: { postcss: { plugins: [tailwindcss()] } },
  server: { host: "127.0.0.1", port: 3103, strictPort: true },
});
