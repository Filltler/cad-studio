import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["manifold-3d"] },
  server: { host: "0.0.0.0" }
});
