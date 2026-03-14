import { serve } from "@hono/node-server";
import { config } from "./config.mjs";
import { app, shutdown } from "./server.mjs";

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(
      `open-brain-local listening on http://${info.address}:${info.port}`,
    );
  },
);

async function stop(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(async () => {
    await shutdown();
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  void stop("SIGINT");
});

process.on("SIGTERM", () => {
  void stop("SIGTERM");
});
