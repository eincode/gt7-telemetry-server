import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { Duplex } from 'stream';
import express, { Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { URL } from 'url';
import * as session from './session';
import * as drivers from './drivers';
import * as sectorTracker from './sector-tracker';
import { buildDriverBroadcasts, buildRaceState } from './processor';
import { addClient, removeClient, clientCount, broadcast } from './broadcaster';
import { loadTrack, getTrack } from './track';
import type { DriverPacket, RosterEntry } from './types';

const PORT         = parseInt(process.env.PORT         ?? '3000', 10);
const BROADCAST_HZ = Math.min(60, Math.max(1, parseInt(process.env.BROADCAST_HZ ?? '60', 10)));
const MAX_DRIVERS  = 16;
const TRACK_ID     = process.env.TRACK_ID;

// ── REST ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  const all = drivers.getAllDrivers();
  res.json({
    ok: true,
    session: session.getSession() !== null,
    drivers: { total: all.length, connected: all.filter((d) => d.connected).length },
    overlayClients: clientCount(),
  });
});

app.post('/session', (req: Request, res: Response) => {
  const { roster } = req.body as { roster?: RosterEntry[] };

  if (!Array.isArray(roster) || roster.length === 0) {
    res.status(400).json({ error: 'roster array required' });
    return;
  }
  if (roster.length > MAX_DRIVERS) {
    res.status(400).json({ error: `max ${MAX_DRIVERS} drivers per session` });
    return;
  }
  for (const entry of roster) {
    if (typeof entry.id !== 'number' || typeof entry.name !== 'string') {
      res.status(400).json({ error: 'each roster entry must have id (number) and name (string)' });
      return;
    }
  }

  drivers.clearDrivers();
  sectorTracker.clearAll();
  const s = session.createSession(roster);
  broadcast({ type: 'roster', session: s, roster });
  res.status(201).json({ session: s });
});

app.get('/session', (_req: Request, res: Response) => {
  const s = session.getSession();
  if (!s) { res.status(404).json({ error: 'no active session' }); return; }
  res.json({ session: s });
});

app.delete('/session', (_req: Request, res: Response) => {
  drivers.clearDrivers();
  sectorTracker.clearAll();
  session.endSession();
  res.json({ ok: true });
});

app.post('/driver/join', (req: Request, res: Response) => {
  const s = session.getSession();
  if (!s) { res.status(400).json({ error: 'no active session' }); return; }

  const { driverId } = req.body as { driverId?: unknown };
  if (typeof driverId !== 'number') {
    res.status(400).json({ error: 'driverId (number) required' });
    return;
  }

  const entry = s.roster.find((r) => r.id === driverId);
  if (!entry) { res.status(404).json({ error: 'driver not in roster' }); return; }

  const token = drivers.registerDriver(driverId, entry.carCode);
  res.json({ token, driverId, name: entry.name });
});

app.get('/drivers', (_req: Request, res: Response) => {
  const s = session.getSession();
  const all = drivers.getAllDrivers();
  res.json({
    drivers: all.map((d) => {
      const entry = s?.roster.find((r) => r.id === d.id);
      return {
        id: d.id,
        name: entry?.name ?? 'unknown',
        carCode: d.carCode,
        connected: d.connected,
        lastSeen: d.lastSeen,
      };
    }),
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

const httpServer = http.createServer(app);
const driverWss = new WebSocketServer({ noServer: true });
const overlayWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket: Duplex, head: Buffer) => {
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);

  if (url.pathname === '/driver') {
    driverWss.handleUpgrade(request, socket, head, (ws) => {
      driverWss.emit('connection', ws, request);
    });
  } else if (url.pathname === '/overlay') {
    overlayWss.handleUpgrade(request, socket, head, (ws) => {
      overlayWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

driverWss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) { ws.close(4001, 'token required'); return; }

  const state = drivers.resolveToken(token);
  if (!state) { ws.close(4002, 'invalid token'); return; }

  if (!session.getSession()) { ws.close(4003, 'no active session'); return; }

  drivers.connectDriver(state, ws);
  console.log(`[driver] connected  id=${state.id} carCode=${state.carCode}`);

  ws.on('message', (data) => {
    let packet: DriverPacket;
    try {
      packet = JSON.parse(data.toString()) as DriverPacket;
    } catch {
      return;
    }
    if (typeof packet.magic !== 'number' || typeof packet.carCode !== 'number') return;
    drivers.updatePacket(state, packet);

    const track = getTrack();
    if (track) {
      sectorTracker.update(
        state.id,
        track,
        packet.position,
        packet.currentLap,
        packet.lapCount,
        packet.lastLaptime,
      );
    }
  });

  ws.on('close', () => {
    drivers.disconnectDriver(state);
    console.log(`[driver] disconnected id=${state.id}`);
  });

  ws.on('error', (err) => {
    console.error(`[driver] error id=${state.id}:`, err.message);
  });
});

overlayWss.on('connection', (ws: WebSocket) => {
  addClient(ws);
  console.log(`[overlay] client connected  (total: ${clientCount()})`);

  // Push current session state immediately so the overlay doesn't wait
  const s = session.getSession();
  if (s) {
    ws.send(JSON.stringify({ type: 'roster', session: s, roster: s.roster }));
  }

  ws.on('close', () => {
    removeClient(ws);
    console.log(`[overlay] client disconnected (total: ${clientCount()})`);
  });

  ws.on('error', (err) => {
    console.error('[overlay] error:', err.message);
  });
});

// ── Broadcast loop ────────────────────────────────────────────────────────────

setInterval(() => {
  if (clientCount() === 0) return;
  const all = drivers.getAllDrivers();
  if (all.length === 0) return;

  broadcast({
    type: 'state',
    drivers: buildDriverBroadcasts(all),
    raceState: buildRaceState(all),
  });
}, Math.round(1000 / BROADCAST_HZ));

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`gt7-telemetry-server running on port ${PORT}`);
  console.log(`  broadcast rate : ${BROADCAST_HZ} Hz`);
  console.log(`  WS /driver     : driver telemetry input  (?token=<token>)`);
  console.log(`  WS /overlay    : overlay frontend output`);
  console.log(`  POST /session  : create session with roster`);
  console.log(`  POST /driver/join : get driver connection token`);
  console.log(`  GET  /health   : server status`);

  if (TRACK_ID) {
    try {
      loadTrack(TRACK_ID);
    } catch (err) {
      console.warn(`[track] could not load TRACK_ID="${TRACK_ID}": ${(err as Error).message}`);
    }
  } else {
    console.log(`  (no TRACK_ID set — POST /track to load one at runtime)`);
  }
});
