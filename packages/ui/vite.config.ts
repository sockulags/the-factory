import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build loads from file:// inside Electron.
  base: "./",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
