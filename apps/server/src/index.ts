import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import { env, loadFleetConfig } from "./config.js";
import { WeatherService } from "./services/weather.js";
import { AIService } from "./ai/distress.js";
import { SimulationEngine } from "./engine/simulation.js";
import type { AssistanceKind, DirectiveType, Position, RouteStrategy } from "./types.js";

const fastify = Fastify({ logger: true });
await fastify.register(cors, {
  origin: env.webOrigins,
  credentials: true,
});

const config = loadFleetConfig();
const weather = new WeatherService(config, env.weatherRefreshMs);
const ai = new AIService();
const engine = new SimulationEngine(config, weather, ai, env.tickMs, env.historyIntervalMs);

const io = new SocketIOServer(fastify.server, {
  cors: {
    origin: env.webOrigins,
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

type Ack = (payload: { ok: boolean; data?: unknown; error?: string }) => void;
const safeAck = (ack: Ack | undefined, fn: () => unknown | Promise<unknown>) => {
  Promise.resolve()
    .then(fn)
    .then((data) => ack?.({ ok: true, data }))
    .catch((error) => ack?.({ ok: false, error: (error as Error).message }));
};

function requireCommand(socket: any): void {
  if (socket.data.role !== "command") throw new Error("Command role required");
}

function requireCaptain(socket: any, shipId?: string): string {
  if (socket.data.role !== "captain" || !socket.data.shipId) throw new Error("Captain role required");
  if (shipId && socket.data.shipId !== shipId) throw new Error("Captain is scoped to a different ship");
  return socket.data.shipId;
}

io.on("connection", (socket: any) => {
  const role = socket.handshake.auth?.role === "captain" ? "captain" : "command";
  const requestedShipId = typeof socket.handshake.auth?.shipId === "string" ? socket.handshake.auth.shipId : undefined;
  const shipId = requestedShipId && engine.getShip(requestedShipId) ? requestedShipId : undefined;
  socket.data.role = role;
  socket.data.shipId = role === "captain" ? shipId : undefined;
  if (role === "captain" && !shipId) {
    socket.emit("session:error", { message: "Captain connection requires a valid shipId" });
    socket.disconnect(true);
    return;
  }
  if (shipId) socket.join(`ship:${shipId}`);

  socket.emit("bootstrap", engine.getBootstrap());

  socket.on("zone:create", (payload: { name?: string; points?: Position[] }, ack?: Ack) => {
    safeAck(ack, () => {
      requireCommand(socket);
      return engine.createZone(payload?.name ?? "", payload?.points ?? []);
    });
  });

  socket.on("zone:update", (payload: { id?: string; name?: string; points?: Position[] }, ack?: Ack) => {
    safeAck(ack, () => {
      requireCommand(socket);
      if (!payload?.id) throw new Error("Zone id required");
      return engine.updateZone(payload.id, payload.name, payload.points ?? []);
    });
  });

  socket.on("zone:delete", (payload: { id?: string }, ack?: Ack) => {
    safeAck(ack, () => {
      requireCommand(socket);
      if (!payload?.id) throw new Error("Zone id required");
      engine.deleteZone(payload.id);
      return { id: payload.id };
    });
  });

  socket.on(
    "directive:send",
    (payload: { shipId?: string; type?: DirectiveType; payload?: { portId?: string; waypoint?: Position; strategy?: RouteStrategy; note?: string } }, ack?: Ack) => {
      safeAck(ack, () => {
        requireCommand(socket);
        if (!payload?.shipId || !payload.type) throw new Error("shipId and directive type are required");
        return engine.sendDirective(payload.shipId, payload.type, payload.payload ?? {});
      });
    },
  );

  socket.on(
    "directive:respond",
    (payload: { directiveId?: string; response?: "ACCEPT" | "ESCALATE_DISTRESS"; message?: string }, ack?: Ack) => {
      safeAck(ack, async () => {
        const ownShip = requireCaptain(socket);
        if (!payload?.directiveId || !payload.response) throw new Error("directiveId and response are required");
        return engine.respondDirective(payload.directiveId, ownShip, payload.response, payload.message);
      });
    },
  );

  socket.on("distress:send", (payload: { message?: string }, ack?: Ack) => {
    safeAck(ack, async () => {
      const ownShip = requireCaptain(socket);
      return engine.raiseDistress(ownShip, payload?.message ?? "");
    });
  });

  socket.on("alert:ack", (payload: { id?: string }, ack?: Ack) => {
    safeAck(ack, () => {
      if (!payload?.id) throw new Error("Alert id required");
      if (socket.data.role === "captain") {
        const ownShip = requireCaptain(socket);
        const alert = engine.getAlerts().find((item) => item.id === payload.id);
        if (!alert?.shipIds.includes(ownShip)) throw new Error("Captain can only acknowledge alerts involving their ship");
      }
      return engine.acknowledgeAlert(payload.id);
    });
  });

  socket.on("assistance:request", (payload: { kind?: AssistanceKind; message?: string }, ack?: Ack) => {
    safeAck(ack, () => {
      const ownShip = requireCaptain(socket);
      const kind = payload?.kind;
      if (!kind || !["fuel", "medical", "escort", "cargo_offload"].includes(kind)) throw new Error("Invalid assistance kind");
      return engine.requestAssistance(ownShip, kind, payload?.message);
    });
  });

  socket.on("assistance:respond", (payload: { id?: string; response?: "ACCEPT" | "DECLINE" }, ack?: Ack) => {
    safeAck(ack, () => {
      const ownShip = requireCaptain(socket);
      if (!payload?.id || !payload.response) throw new Error("Assistance id and response are required");
      return engine.respondAssistance(payload.id, ownShip, payload.response);
    });
  });
});

engine.on("fleet:update", (ships) => io.emit("fleet:update", ships));
engine.on("alert:new", (alert) => io.emit("alert:new", alert));
engine.on("alert:update", (alert) => io.emit("alert:update", alert));
engine.on("zone:update", (zones) => io.emit("zone:update", zones));
engine.on("directive:new", (directive) => {
  io.emit("directive:new", directive);
  io.to(`ship:${directive.shipId}`).emit("directive:incoming", directive);
});
engine.on("directive:update", (directive) => io.emit("directive:update", directive));
engine.on("assistance:new", (request) => {
  io.emit("assistance:new", request);
  io.to(`ship:${request.toShipId}`).emit("assistance:incoming", request);
});
engine.on("assistance:update", (request) => io.emit("assistance:update", request));
engine.on("weather:update", (cells) => io.emit("weather:update", cells));
engine.on("history:update", (snapshot) => io.emit("history:update", snapshot));

fastify.get("/health", async () => ({
  ok: true,
  scenario: config.scenario.name,
  ships: engine.getShips().length,
  uptimeSeconds: process.uptime(),
  now: new Date().toISOString(),
}));

fastify.get("/api/bootstrap", async () => engine.getBootstrap());
fastify.get("/api/history", async () => engine.getHistory());
fastify.get("/api/advisor", async () => ({ suggestions: await engine.advisorSuggestions() }));

const routeOptionsQuery = z.object({
  shipId: z.string().min(1),
  destination: z.string().optional(),
});
fastify.get("/api/route-options", async (request: any, reply: any) => {
  const result = routeOptionsQuery.safeParse(request.query);
  if (!result.success) return reply.code(400).send({ error: result.error.flatten() });
  try {
    return { candidates: engine.routeCandidates(result.data.shipId, result.data.destination) };
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

fastify.get("/api/metrics", async () => {
  const activeAlerts = engine.getAlerts().filter((alert) => !alert.resolved);
  return {
    tickMs: env.tickMs,
    updateHz: 1000 / env.tickMs,
    activeShips: engine.getShips().length,
    activeAlerts: activeAlerts.length,
    zones: engine.getZones().length,
    weatherSource: engine.getWeather().some((cell) => cell.source === "open-meteo") ? "open-meteo" : "fallback",
  };
});

await engine.start();

const shutdown = async () => {
  engine.stop();
  io.close();
  await fastify.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await fastify.listen({ port: env.port, host: "0.0.0.0" });
