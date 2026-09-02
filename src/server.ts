import dotenv from "dotenv";
dotenv.config();

import cors from "cors";
import express from "express";
import http from "http";
import { Duplex } from "stream";
import { URL } from "url";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { addClient, clientCount, removeClient } from "./broadcaster";
import * as drivers from "./drivers";
import assetsGet from "./handlers/assets/get";
import { startBroadcastLoop } from "./handlers/broadcaster";
import driverDelete from "./handlers/driver/delete";
import driverJoinPost from "./handlers/driver/join/post";
import driverPost from "./handlers/driver/post";
import driverWssMessage from "./handlers/driverWebsocket/message";
import driversGet from "./handlers/drivers/get";
import healthGet from "./handlers/health/get";
import overlayCarTelemetryPost from "./handlers/overlay/car-telemetry/post";
import overlayDriverShowcasePost from "./handlers/overlay/driver-showcase/post";
import overlayDriverTelemetryPost from "./handlers/overlay/driver-telemetry/post";
import overlayGet from "./handlers/overlay/get";
import overlaySectorPost from "./handlers/overlay/sector/post";
import overlayStandingsPost from "./handlers/overlay/standings/post";
import recorderGet from "./handlers/recorder/get";
import sessionDelete from "./handlers/session/delete";
import sessionGet from "./handlers/session/get";
import sessionModePost from "./handlers/session/mode/post";
import sessionPost from "./handlers/session/post";
import sessionTrackPost from "./handlers/session/track/post";
import tracksGet from "./handlers/tracks/get";
import { startMockSimulation } from "./mock";
import * as session from "./session";
import { loadTrack } from "./track";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BROADCAST_HZ = Math.min(
  60,
  Math.max(1, parseInt(process.env.BROADCAST_HZ ?? "60", 10)),
);
const TRACK_ID = process.env.TRACK_ID;
const MOCK = process.env.MOCK === "true";

// ── REST ──────────────────────────────────────────────────────────────────────

const app = express();

const corsOptions: cors.CorsOptions = {
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // handle preflight for every route

app.use(express.json());

app.get("/health", healthGet);

app.post("/session", sessionPost);
app.post("/session/mode", sessionModePost);
app.post("/session/track", sessionTrackPost);
app.get("/session", sessionGet);
app.delete("/session", sessionDelete);

app.post("/driver", driverPost);
app.delete("/driver", driverDelete);
app.post("/driver/join", driverJoinPost);

// ── Overlay state ─────────────────────────────────────────────────────────────

app.get("/overlay", overlayGet);
app.post("/overlay/standings", overlayStandingsPost);
app.post("/overlay/sector", overlaySectorPost);
app.post("/overlay/car-telemetry", overlayCarTelemetryPost);
app.post("/overlay/driver-showcase", overlayDriverShowcasePost);
app.post("/overlay/driver-telemetry", overlayDriverTelemetryPost);

app.get("/recorder", recorderGet);

app.get("/drivers", driversGet);

app.get("/tracks", tracksGet);

app.get("/assets/*", assetsGet);

// ── WebSocket ─────────────────────────────────────────────────────────────────

const httpServer = http.createServer(app);
const driverWss = new WebSocketServer({ noServer: true });
const overlayWss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket: Duplex, head: Buffer) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);

  if (url.pathname === "/driver") {
    driverWss.handleUpgrade(request, socket, head, (ws) => {
      driverWss.emit("connection", ws, request);
    });
  } else if (url.pathname === "/overlay") {
    overlayWss.handleUpgrade(request, socket, head, (ws) => {
      overlayWss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

driverWss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    ws.close(4001, "token required");
    return;
  }

  const state = drivers.resolveToken(token);
  if (!state) {
    ws.close(4002, "invalid token");
    return;
  }

  if (!session.getSession()) {
    ws.close(4003, "no active session");
    return;
  }

  drivers.connectDriver(state, ws);
  console.log(`[driver] connected  id=${state.id}`);

  ws.on("message", (data) => driverWssMessage(ws, state, data));

  ws.on("close", () => {
    drivers.disconnectDriver(state);
    console.log(`[driver] disconnected id=${state.id}`);
  });

  ws.on("error", (err) => {
    console.error(`[driver] error id=${state.id}:`, err.message);
  });
});

overlayWss.on("connection", (ws: WebSocket) => {
  addClient(ws);
  console.log(`[overlay] client connected  (total: ${clientCount()})`);

  // Push current session state immediately so the overlay doesn't wait
  const s = session.getSession();
  if (s) {
    ws.send(JSON.stringify({ type: "roster", session: s, roster: s.roster }));
  }

  ws.on("close", () => {
    removeClient(ws);
    console.log(`[overlay] client disconnected (total: ${clientCount()})`);
  });

  ws.on("error", (err) => {
    console.error("[overlay] error:", err.message);
  });
});

// ── Broadcast loop ────────────────────────────────────────────────────────────

startBroadcastLoop(BROADCAST_HZ);

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`gt7-telemetry-server running on port ${PORT}`);
  console.log(`  broadcast rate : ${BROADCAST_HZ} Hz`);
  console.log("");
  console.log("  WebSocket");
  console.log(
    `    WS   /driver            driver telemetry input  (?token=<token>)`,
  );
  console.log(`    WS   /overlay           overlay frontend output`);
  console.log("");
  console.log("  Session");
  console.log(
    `    POST /session           create session with trackId, roster (+ optional mode)`,
  );
  console.log(
    `    GET  /session           get active session (includes roster)`,
  );
  console.log(`    DEL  /session           end active session`);
  console.log(
    `    POST /session/mode      switch mode: race | qualifying | practice`,
  );
  console.log(`    POST /session/track     switch active track mid-session`);
  console.log(`    POST /driver           add driver to active session`);
  console.log(`    DEL  /driver           remove driver from active session`);
  console.log(`    POST /driver/join       get driver connection token`);
  console.log(`    GET  /drivers           list all drivers with status`);
  console.log("");
  console.log("  Overlay state");
  console.log(`    GET  /overlay           current overlay visibility state`);
  console.log(`    POST /overlay/standings toggle standings overlay`);
  console.log(
    `    POST /overlay/sector    toggle sector overlay  (+ driverIds)`,
  );
  console.log(
    `    POST /overlay/car-telemetry  toggle car-telemetry overlay  (+ driverIds)`,
  );
  console.log(
    `    POST /overlay/driver-showcase  toggle driver showcase  (+ driverId)`,
  );
  console.log(
    `    POST /overlay/driver-telemetry toggle driver telemetry overlay  (+ driverId)`,
  );
  console.log("");
  console.log("  Utilities");
  console.log(`    GET  /recorder          recording session setup page`);
  console.log(`    GET  /health            server status`);
  console.log(`    GET  /tracks            list of available tracks`);
  console.log(`    GET  /assets/*          static files (track images, etc.)`);

  if (MOCK) {
    if (TRACK_ID) {
      try {
        loadTrack(TRACK_ID);
      } catch (err) {
        console.warn(
          `[track] could not load TRACK_ID="${TRACK_ID}": ${(err as Error).message}`,
        );
      }
    }
    startMockSimulation(BROADCAST_HZ);
  }
});
