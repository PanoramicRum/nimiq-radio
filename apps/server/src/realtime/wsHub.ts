import type { ClientWsMessage, RadioState, ServerWsMessage } from "@radio/shared";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { RadioEngine } from "../engine/RadioEngine";

const HEARTBEAT_MS = 25_000;

/**
 * Real-time hub (Phase 5). One subscription to the engine fans state out to every socket
 * (so client count never grows the engine's listener set). Clients also run an NTP-style
 * clock probe over this same duplex channel, and can request a full resync on reconnect.
 */
export function registerWsHub(app: FastifyInstance, engine: RadioEngine): void {
  const sockets = new Set<WebSocket>();

  const safeSend = (socket: WebSocket, data: string) => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(data);
    } catch {
      // socket closed/backpressured between the check and send — never let one bad
      // socket break the broadcast for the others.
    }
  };
  const send = (socket: WebSocket, msg: ServerWsMessage) => safeSend(socket, JSON.stringify(msg));
  const broadcast = (msg: ServerWsMessage) => {
    const data = JSON.stringify(msg);
    for (const socket of sockets) safeSend(socket, data);
  };

  // Single engine subscription -> broadcast to all connected clients.
  const unsubscribe = engine.onChange((state: RadioState) => broadcast({ type: "state", state }));

  // App-level heartbeat so clients (and proxies) can detect dead connections.
  const heartbeat = setInterval(() => broadcast({ type: "ping" }), HEARTBEAT_MS);

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    unsubscribe();
    for (const socket of sockets) socket.close();
  });

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    sockets.add(socket);
    engine.setListeners(sockets.size); // broadcasts the new live count to everyone
    // Immediate snapshot so a fresh client renders without waiting for the next transition.
    send(socket, { type: "state", state: engine.snapshot() });

    socket.on("message", (raw: Buffer) => {
      if (raw.length > 4096) return; // control messages are tiny; ignore anything large
      let msg: ClientWsMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientWsMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "clockProbe" && typeof msg.t0 === "number") {
        const t1 = Date.now(); // server receive
        send(socket, { type: "clockProbeReply", t0: msg.t0, t1, t2: Date.now() }); // t2 = server send
      } else if (msg.type === "resync") {
        send(socket, { type: "state", state: engine.snapshot() });
      }
    });

    const drop = () => {
      if (!sockets.delete(socket)) return; // close + error can both fire — count once
      socket.removeAllListeners();
      engine.setListeners(sockets.size); // broadcasts the new live count to everyone
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });
}
