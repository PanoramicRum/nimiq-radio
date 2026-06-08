import { buildApp } from "./app";
import { config } from "./config";

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    app.log.info(`Nimiq Radio server listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown so onClose hooks run (flush + close SQLite, stop cleanup), but never
  // hang the container past its stop grace period if a hook stalls.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      void Promise.race([app.close(), timeout])
        .catch((err) => app.log.error(err, "shutdown error"))
        .finally(() => process.exit(0));
    });
  }
}

void main();
