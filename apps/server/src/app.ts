import { mkdir } from "node:fs/promises";
import path from "node:path";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { initRpcClient } from "nimiq-rpc-client-ts/client";

import { config } from "./config";
import { openDb } from "./db";
import { RadioEngine } from "./engine/RadioEngine";
import { SqliteStore } from "./engine/SqliteStore";
import { InMemoryStore, type RadioStore } from "./engine/store";
import { startCleanup } from "./fs/cleanup";
import { isAudioFilename } from "./fs/trackStore";
import { MediaWorker } from "./media/worker";
import { BoostRegistry } from "./payments/BoostRegistry";
import { PaymentsStore } from "./payments/PaymentsStore";
import { PrepareRegistry } from "./payments/PrepareRegistry";
import { RpcVerifier } from "./payments/RpcVerifier";
import { registerWsHub } from "./realtime/wsHub";
import { registerBoostRoutes } from "./routes/boost";
import { registerConfigRoute } from "./routes/config";
import { registerHealthRoute } from "./routes/health";
import { registerMetricsRoute } from "./routes/metrics";
import { registerPrepareRoute } from "./routes/prepare";
import { registerStateRoute } from "./routes/state";
import { registerSubmitRoute } from "./routes/submit";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      transport:
        config.NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } },
    },
    bodyLimit: 64 * 1024, // tiny JSON bodies only
  });

  // Ensure the tracks dir + covers subdir exist before @fastify/static reads their roots.
  await mkdir(config.TRACKS_DIR, { recursive: true });
  await mkdir(path.join(config.TRACKS_DIR, "covers"), { recursive: true });

  // Security headers. CSP is left off (this backend serves JSON + audio, not HTML; the SPA
  // host sets its own CSP incl. frame-ancestors for Nimiq Pay). CORP is cross-origin so the
  // SPA (a different origin in prod) can load /static MP3s.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(",").map((s) => s.trim()),
  });

  // Not global: clients poll /api/state every ~2s, so reads must not be throttled.
  // Only the expensive endpoints (prepare-song, submit) opt in via per-route config.
  await app.register(rateLimit, {
    global: false,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
  });

  await app.register(websocket);

  await app.register(fastifyStatic, {
    root: path.resolve(config.TRACKS_DIR),
    prefix: "/static/tracks/",
    acceptRanges: true, // HTTP Range / 206 — required for <audio> seeking
    cacheControl: true,
    maxAge: "365d",
    immutable: true,
    index: false,
    list: false,
    // Only ever serve audio files — the SQLite DB (radio.db + -wal/-shm) lives in this same
    // dir and must never be downloadable.
    allowedPath: (pathName) => isAudioFilename(pathName),
  });

  // Album cover art. Separate static instance rooted at the covers subdir so radio.db
  // (a sibling of covers/, not inside it) can never be served. decorateReply:false is
  // required for a second @fastify/static registration.
  await app.register(fastifyStatic, {
    root: path.resolve(config.TRACKS_DIR, "covers"),
    prefix: "/static/covers/",
    decorateReply: false,
    cacheControl: true,
    maxAge: "365d",
    immutable: true,
    index: false,
    list: false,
    allowedPath: (pathName) => /\.(jpg|png|webp)$/i.test(pathName),
  });

  // Persistence: SQLite when DB_PATH is set (radio survives restart + durable replay guard),
  // otherwise pure in-memory.
  const db = config.dbPath ? openDb(config.dbPath) : undefined;
  const store: RadioStore = db ? new SqliteStore(db) : new InMemoryStore();
  app.log.info(db ? { dbPath: config.dbPath } : {}, db ? "persistence ENABLED (SQLite)" : "persistence DISABLED (in-memory)");

  const worker = new MediaWorker(config, app.log);
  const engine = new RadioEngine(store, app.log);
  const registry = new PrepareRegistry();
  const boostRegistry = new BoostRegistry();
  const payments = new PaymentsStore(db, app.log);

  // Temp-file cleanup, pinning now-playing/queued/staged-unpaid tracks.
  const stopCleanup = startCleanup(config, app.log, () => {
    const snap = engine.snapshot();
    const pinned = new Set<string>();
    if (snap.current) pinned.add(snap.current.id);
    for (const item of snap.queue) pinned.add(item.id);
    for (const id of registry.stagedTrackIds()) pinned.add(id);
    return pinned;
  });

  app.addHook("onClose", async () => {
    stopCleanup();
    db?.close();
  });

  if (config.paymentsEnabled) {
    initRpcClient({ url: config.rpcUrl });
    // Don't log the recipient address (operational/privacy hygiene).
    app.log.info({ network: config.NIMIQ_NETWORK, rpcUrl: config.rpcUrl, priceLuna: config.priceLuna }, "payments ENABLED");
  } else {
    app.log.info("payments DISABLED (set RECIPIENT_ADDRESS to enable) — songs are free");
  }

  const verifier = new RpcVerifier(
    {
      network: config.NIMIQ_NETWORK,
      recipientAddress: config.recipientAddress ?? "",
      minConfirmations: config.MIN_CONFIRMATIONS,
    },
    app.log,
  );

  registerHealthRoute(app);
  registerMetricsRoute(app);
  registerConfigRoute(app);
  registerStateRoute(app, engine);
  registerWsHub(app, engine);
  registerPrepareRoute(app, { worker, engine, registry });
  registerSubmitRoute(app, { engine, registry, verifier, payments, worker });
  registerBoostRoutes(app, { engine, registry: boostRegistry, verifier, payments });

  return app;
}
