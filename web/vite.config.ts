import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    solid(),
    tailwindcss(),
    {
      name: "present-worker-csp",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = (request as { originalUrl?: string; url?: string }).originalUrl ??
            (request as { url?: string }).url ??
            "";
          if (url.includes("scriptWorker")) {
            response.setHeader(
              "Content-Security-Policy",
              "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'",
            );
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  build: {
    target: "esnext",
  },
});
