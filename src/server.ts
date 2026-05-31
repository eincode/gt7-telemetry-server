import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { Duplex } from 'stream';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { URL } from 'url';
import * as session from './session';
import * as drivers from './drivers';
import * as sectorTracker from './sector-tracker';
import { buildDriverBroadcasts, buildRaceState } from './processor';
import { addClient, removeClient, clientCount, broadcast } from './broadcaster';
import { loadTrack, getTrack, clearTrack } from './track';
import { startMockSimulation } from './mock';
import * as overlayState from './overlay-state';
import type { DriverPacket, RosterEntry, SessionMode } from './types';

const VALID_MODES: SessionMode[] = ['race', 'qualifying', 'practice'];

const PORT         = parseInt(process.env.PORT         ?? '3000', 10);
const BROADCAST_HZ = Math.min(60, Math.max(1, parseInt(process.env.BROADCAST_HZ ?? '60', 10)));
const MAX_DRIVERS  = 16;
const TRACK_ID     = process.env.TRACK_ID;
const MOCK         = process.env.MOCK === 'true';

// ── REST ──────────────────────────────────────────────────────────────────────

const app = express();

const corsOptions: cors.CorsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // handle preflight for every route

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
  const { roster, mode = 'practice', trackId, isRecording = false } = req.body as {
    roster?: RosterEntry[];
    mode?: unknown;
    trackId?: unknown;
    isRecording?: unknown;
  };

  if (typeof trackId !== 'string' || trackId.trim() === '') {
    res.status(400).json({ error: 'trackId (string) required' });
    return;
  }
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
  if (!VALID_MODES.includes(mode as SessionMode)) {
    res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
    return;
  }

  // Only load track when this is not a recording session — the track may not exist yet
  if (!isRecording) {
    try {
      loadTrack(trackId.trim());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

  drivers.clearDrivers();
  sectorTracker.clearAll();
  const s = session.createSession(roster, mode as SessionMode, trackId.trim(), isRecording === true);
  broadcast({ type: 'roster', session: s, roster });
  res.status(201).json({ session: s });
});

app.post('/session/mode', (req: Request, res: Response) => {
  const s = session.getSession();
  if (!s) { res.status(400).json({ error: 'no active session' }); return; }

  const { mode } = req.body as { mode?: unknown };
  if (!VALID_MODES.includes(mode as SessionMode)) {
    res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
    return;
  }

  session.setMode(mode as SessionMode);
  res.json({ ok: true, mode });
});

app.post('/session/track', (req: Request, res: Response) => {
  const s = session.getSession();
  if (!s) { res.status(400).json({ error: 'no active session' }); return; }

  const { trackId } = req.body as { trackId?: unknown };
  if (typeof trackId !== 'string' || trackId.trim() === '') {
    res.status(400).json({ error: 'trackId (string) required' });
    return;
  }

  if (!s.isRecording) {
    try {
      loadTrack(trackId.trim());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    sectorTracker.clearAll();
  }

  session.setTrackId(trackId.trim());
  res.json({ ok: true, trackId: trackId.trim() });
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
  clearTrack();
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

  const token = drivers.registerDriver(driverId);
  res.json({ token, driverId, name: entry.name });
});

// ── Overlay state ─────────────────────────────────────────────────────────────

app.get('/overlay', (_req: Request, res: Response) => {
  res.json(overlayState.getOverlayState());
});

app.post('/overlay/standings', (req: Request, res: Response) => {
  const { visible } = req.body as { visible?: unknown };
  if (visible !== undefined && typeof visible !== 'boolean') {
    res.status(400).json({ error: 'visible must be a boolean' }); return;
  }
  const patch: Parameters<typeof overlayState.setStandings>[0] = {};
  if (visible !== undefined) patch.visible = visible as boolean;
  res.json({ ok: true, overlayState: overlayState.setStandings(patch) });
});

app.post('/overlay/sector', (req: Request, res: Response) => {
  const { visible, driverIds } = req.body as { visible?: unknown; driverIds?: unknown };
  if (visible !== undefined && typeof visible !== 'boolean') {
    res.status(400).json({ error: 'visible must be a boolean' }); return;
  }
  if (driverIds !== undefined) {
    if (
      !Array.isArray(driverIds) || driverIds.length > 2 ||
      !(driverIds as unknown[]).every((id) => typeof id === 'number')
    ) {
      res.status(400).json({ error: 'driverIds must be an array of 0–2 numbers' }); return;
    }
  }
  const patch: Parameters<typeof overlayState.setSector>[0] = {};
  if (visible   !== undefined) patch.visible   = visible   as boolean;
  if (driverIds !== undefined) patch.driverIds = driverIds as number[];
  res.json({ ok: true, overlayState: overlayState.setSector(patch) });
});

app.post('/overlay/car-telemetry', (req: Request, res: Response) => {
  const { visible, driverIds } = req.body as { visible?: unknown; driverIds?: unknown };
  if (visible !== undefined && typeof visible !== 'boolean') {
    res.status(400).json({ error: 'visible must be a boolean' }); return;
  }
  if (driverIds !== undefined) {
    if (
      !Array.isArray(driverIds) || driverIds.length > 2 ||
      !(driverIds as unknown[]).every((id) => typeof id === 'number')
    ) {
      res.status(400).json({ error: 'driverIds must be an array of 0–2 numbers' }); return;
    }
  }
  const patch: Parameters<typeof overlayState.setCarTelemetry>[0] = {};
  if (visible   !== undefined) patch.visible   = visible   as boolean;
  if (driverIds !== undefined) patch.driverIds = driverIds as number[];
  res.json({ ok: true, overlayState: overlayState.setCarTelemetry(patch) });
});

app.post('/overlay/driver-showcase', (req: Request, res: Response) => {
  const { visible, driverId } = req.body as { visible?: unknown; driverId?: unknown };
  if (visible !== undefined && typeof visible !== 'boolean') {
    res.status(400).json({ error: 'visible must be a boolean' }); return;
  }
  if (driverId !== undefined && driverId !== null && typeof driverId !== 'number') {
    res.status(400).json({ error: 'driverId must be a number or null' }); return;
  }
  const patch: Parameters<typeof overlayState.setDriverShowcase>[0] = {};
  if (visible  !== undefined) patch.visible  = visible  as boolean;
  if (driverId !== undefined) patch.driverId = driverId as number | null;
  res.json({ ok: true, overlayState: overlayState.setDriverShowcase(patch) });
});

app.get('/recorder', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GT7 Recorder</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 2.5rem 3rem;
      max-width: 440px;
      width: 100%;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.375rem; }
    p.sub { font-size: 0.875rem; color: #888; margin-bottom: 1.75rem; }
    label { display: block; font-size: 0.8125rem; color: #aaa; margin-bottom: 0.375rem; }
    input[type="text"] {
      width: 100%;
      background: #111;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 0.6rem 0.75rem;
      font-size: 0.9375rem;
      color: #e0e0e0;
      outline: none;
      margin-bottom: 1rem;
    }
    input[type="text"]:focus { border-color: #555; }
    .row { display: flex; gap: 0.625rem; }
    button {
      background: #e8e8e8;
      color: #111;
      border: none;
      border-radius: 8px;
      padding: 0.7rem 1.25rem;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      flex: 1;
      transition: background 0.15s;
    }
    button.secondary {
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #3a3a3a;
    }
    button:hover:not(:disabled) { filter: brightness(1.12); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .divider { border: none; border-top: 1px solid #2a2a2a; margin: 1.5rem 0; }
    .status {
      margin-top: 1rem;
      font-size: 0.8125rem;
      min-height: 1.1rem;
      color: #888;
    }
    .status.ok  { color: #4ade80; }
    .status.err { color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    <h1>GT7 Track Recorder</h1>
    <p class="sub">Creates a single-driver session so the recorder client can connect.</p>

    <label for="trackId">Track ID</label>
    <input id="trackId" type="text" placeholder="e.g. tsukuba" autocomplete="off" spellcheck="false" />

    <button id="startBtn" onclick="startSession()">Start recording session</button>
    <div id="startStatus" class="status"></div>

    <hr class="divider" />

    <div class="row">
      <button class="secondary" onclick="updateTrack()">Update track</button>
    </div>
    <div id="trackStatus" class="status"></div>
  </div>

  <script>
    function trackIdValue() {
      return document.getElementById('trackId').value.trim();
    }

    function setStatus(id, type, msg) {
      const el = document.getElementById(id);
      el.className = 'status ' + type;
      el.textContent = msg;
    }

    async function startSession() {
      const trackId = trackIdValue();
      if (!trackId) { setStatus('startStatus', 'err', 'Enter a track ID first.'); return; }

      const btn = document.getElementById('startBtn');
      btn.disabled = true;
      setStatus('startStatus', '', 'Creating session…');

      try {
        const res = await fetch('/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trackId,
            isRecording: true,
            roster: [{ id: 1, name: 'Recorder', country: 'ID' }]
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setStatus('startStatus', 'ok', 'Session started — id: ' + data.session.id);
      } catch (err) {
        setStatus('startStatus', 'err', 'Error: ' + err.message);
        btn.disabled = false;
      }
    }

    async function updateTrack() {
      const trackId = trackIdValue();
      if (!trackId) { setStatus('trackStatus', 'err', 'Enter a track ID first.'); return; }

      setStatus('trackStatus', '', 'Updating track…');

      try {
        const res = await fetch('/session/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setStatus('trackStatus', 'ok', 'Track updated to "' + data.trackId + '"');
      } catch (err) {
        setStatus('trackStatus', 'err', 'Error: ' + err.message);
      }
    }
  </script>
</body>
</html>`);
});

app.get('/drivers', (_req: Request, res: Response) => {
  const s = session.getSession();
  if (!s) { res.json({ drivers: [] }); return; }

  const stateMap = new Map(drivers.getAllDrivers().map((d) => [d.id, d]));
  res.json({
    drivers: s.roster.map((entry) => {
      const d = stateMap.get(entry.id);
      return {
        id:        entry.id,
        name:      entry.name,
        country:   entry.country,
        carCode:   d?.telemetry?.carCode ?? 0,
        connected: d?.connected ?? false,
        lastSeen:  d?.lastSeen ?? 0,
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
  console.log(`[driver] connected  id=${state.id}`);

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
        session.getSession()?.mode,
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

  const mode = session.getSession()?.mode ?? 'practice';
  broadcast({
    type: 'state',
    drivers: buildDriverBroadcasts(all, mode),
    raceState: buildRaceState(all, mode),
    overlayState: overlayState.getOverlayState(),
  });
}, Math.round(1000 / BROADCAST_HZ));

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`gt7-telemetry-server running on port ${PORT}`);
  console.log(`  broadcast rate : ${BROADCAST_HZ} Hz`);
  console.log('');
  console.log('  WebSocket');
  console.log(`    WS   /driver            driver telemetry input  (?token=<token>)`);
  console.log(`    WS   /overlay           overlay frontend output`);
  console.log('');
  console.log('  Session');
  console.log(`    POST /session           create session with trackId, roster (+ optional mode)`);
  console.log(`    GET  /session           get active session (includes roster)`);
  console.log(`    DEL  /session           end active session`);
  console.log(`    POST /session/mode      switch mode: race | qualifying | practice`);
  console.log(`    POST /session/track     switch active track mid-session`);
  console.log(`    POST /driver/join       get driver connection token`);
  console.log(`    GET  /drivers           list all drivers with status`);
  console.log('');
  console.log('  Overlay state');
  console.log(`    GET  /overlay           current overlay visibility state`);
  console.log(`    POST /overlay/standings toggle standings overlay`);
  console.log(`    POST /overlay/sector    toggle sector overlay  (+ driverIds)`);
  console.log(`    POST /overlay/car-telemetry  toggle car-telemetry overlay  (+ driverIds)`);
  console.log(`    POST /overlay/driver-showcase  toggle driver showcase  (+ driverId)`);
  console.log('');
  console.log('  Utilities');
  console.log(`    GET  /recorder          recording session setup page`);
  console.log(`    GET  /health            server status`);

  if (MOCK) {
    if (TRACK_ID) {
      try {
        loadTrack(TRACK_ID);
      } catch (err) {
        console.warn(`[track] could not load TRACK_ID="${TRACK_ID}": ${(err as Error).message}`);
      }
    }
    startMockSimulation(BROADCAST_HZ);
  }
});
