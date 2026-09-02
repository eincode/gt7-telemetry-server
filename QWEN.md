# QWEN.md

## Project overview

**gt7-telemetry-server** is a relay server for Gran Turismo 7. It receives real-time telemetry from multiple driver clients over WebSocket, computes race standings, sector data, and derived metrics server-side, then broadcasts everything to overlay frontends (streaming graphics, dashboards) at up to 60 Hz.

Two WebSocket routes exist:
- **`/driver?token=<token>`** — driver telemetry input (one connection per driver)
- **`/overlay`** — overlay frontend output (any number of clients)

A REST API manages sessions, drivers, and overlay visibility toggles.

## Tech stack

- **Runtime:** Node.js, ES2022 target, CommonJS modules
- **Language:** TypeScript 5.8 (strict mode, `resolveJsonModule`)
- **Package manager:** Yarn 4.12
- **Dependencies:** Express 4, ws 8, commander 14, uuid 11, cors, dotenv
- **Dev runner:** `tsx watch` (hot-reload)
- **Type check:** `npx tsc --noEmit` — no test suite exists yet

## Quick start

```bash
yarn dev                          # real drivers, no track loaded
TRACK_ID=tsukuba yarn dev         # real drivers + pre-calibrated track
yarn mock                         # 4 simulated drivers (no hardware)
TRACK_ID=tsukuba yarn mock        # simulated drivers on a real track
```

Environment variables: `PORT` (default 3000), `BROADCAST_HZ` (1–60, default 60), `TRACK_ID` (optional), `MOCK` (set `true` to simulate drivers).

---

## Directory structure

```
src/
├── server.ts            # Express + WebSocket entry point, all REST routes
├── session.ts           # Session state machine (create, switch mode/track, end)
├── drivers.ts           # Driver registry, connection lifecycle, telemetry parsing
├── broadcaster.ts       # WebSocket client set + broadcast primitives
├── processor.ts         # Rank, gap, Derived computation + StateBroadcast assembly
├── sector-tracker.ts    # Per-driver sector crossing detection + session bests
├── track.ts             # Load track.json from disk, expose active track
├── overlay-state.ts     # Mutable singleton for overlay visibility toggles
├── mock.ts              # 4-driver simulation with sinusoidal speed model
├── types.ts             # All shared TypeScript interfaces
└── recorder/
    ├── cli.ts            # Interactive menu (record, process, test, monitor, list)
    ├── recorder.ts       # Captures one lap of position samples via overlay feed
    ├── track-processor.ts # Computes track.json from 3 edge recordings + sector times
    ├── sector-tester.ts  # Live verification tool — compares tool vs game sector times
    ├── monitor.ts        # Live telemetry dashboard (formatted or raw JSON)
    ├── overlay-client.ts # Thin WebSocket wrapper that filters StateBroadcast messages
    └── types.ts          # Vec3, PositionSample, ComputedTrack, SectorBoundary
tracks/                  # Per-track directory with raw recordings + computed track.json
```

---

## Full data flow

```
GT7 game (UDP telemetry)
  → custom client app (converts UDP → JSON WebSocket frames)
    → POST /driver/join  (get token)
    → WS /driver?token=<token>  (send DriverPacket JSON)
      → drivers.ts updatePacket() → stores DriverTelemetry
      → sector-tracker.ts update() → arcFraction, sector crossings
        → (every 1000/BROADCAST_HZ ms)
          → processor.ts buildDriverBroadcasts() → rank, gaps, Derived
          → processor.ts buildRaceState() → lap, totalLaps, order
          → broadcast() → JSON StateBroadcast to all WS /overlay clients
```

### Startup sequence

1. `server.ts` creates Express HTTP server + two WebSocket servers
2. If `MOCK=true`, `startMockSimulation()` creates a session, registers 4 drivers, starts a setInterval that ticks each driver every broadcast interval
3. If `TRACK_ID` is set, `loadTrack()` reads `tracks/<id>/track.json` into `activeTrack`
4. A `setInterval` runs the broadcast loop: if overlay clients are connected, it calls `processor.buildDriverBroadcasts()` and `processor.buildRaceState()`, then broadcasts

---

## Telemetry packet (`DriverPacket`)

The GT7 UDP telemetry format is mirrored in `types.ts`. Fields are sent as JSON by driver clients. Key fields used by the server:

| Field | Usage |
|---|---|
| `position` `[x, y, z]` | Arc-fraction (nearest-index on ideal line), sector boundary crossings |
| `lapCount` | Current lap number (integer); used for race score, finish detection, sector reset |
| `totalLaps` | Total race distance in laps; used for finish detection (`lapCount >= totalLaps`) |
| `currentLap` | Milliseconds elapsed in the current lap; used for sector crossing interpolation |
| `lastLaptime` | Milliseconds of the last completed lap; used to finalize the last sector on lap change |
| `bestLaptime` | Fastest lap in ms; ranking criterion in qualifying/practice |
| `speed` | m/s; used in race-mode gap formula as `leaderSpeed` |
| `throttle, brake` | 0–255 raw values |
| `gears` | Low nibble = current gear, high nibble = suggested gear |
| `EngineRPM, minAlertRPM, maxAlertRPM` | RPM and shift-light thresholds |
| `fuelLevel, fuelCapacity` | Fuel in litres |
| `tyreTemp` | `[FL, FR, RL, RR]` in °C |
| `carCode, carCategory` | Car identification |
| `dayProgression` | 0.0–1.0 day/night cycle position |
| `RaceStartPosition` | Grid slot (1-indexed) |

The full packet includes many more fields (suspension, oil pressure, gear ratios, etc.) that are passed through but not actively processed by the server.

---

## Session management (`session.ts`)

A singleton `currentSession: Session | null` tracks the active session. Session fields:

| Field | Type | Purpose |
|---|---|---|
| `id` | `string` (UUID) | Unique session identifier |
| `roster` | `RosterEntry[]` | 1–16 drivers with `id`, `name`, `country` |
| `status` | `'waiting' \| 'racing' \| 'finished'` | Session state (set manually or by external controller) |
| `mode` | `'race' \| 'qualifying' \| 'practice'` | Determines ranking and gap logic |
| `trackId` | `string` | Folder name under `tracks/` |
| `isRecording` | `boolean` | If true, track is NOT loaded (may not exist yet — used during calibration) |
| `createdAt` | `number` | Unix ms timestamp |

Session lifecycle:
- `POST /session` creates a new session, loads the track (unless `isRecording`), clears all drivers and sector state, broadcasts a `roster` message to overlays
- `POST /session/mode` switches mode mid-session — ranking/gap logic changes on the next broadcast tick
- `POST /session/track` switches track mid-session — reloads track geometry, resets all sector tracking
- `DELETE /session` ends the session, disconnects all drivers, clears track

---

## Driver management (`drivers.ts`)

`DriverState` stores per-driver runtime state:

```ts
interface DriverState {
  id: number;
  carCode: number;
  token: string;              // UUID used for WebSocket auth
  ws: WebSocket | null;
  connected: boolean;
  lastSeen: number;           // Unix ms of last telemetry packet
  telemetry: DriverTelemetry | null;
  frozenScore: number | null;        // set on race finish (race mode)
  frozenGapToLeader: number | null;  // set on race finish (race mode)
  frozenGapToAhead: number | null;   // set on race finish (race mode)
}
```

Flow:
1. `POST /driver/join` — checks driver is in the session roster, calls `registerDriver()` which generates a token
2. Driver connects via WebSocket with `?token=<token>`, calls `connectDriver()` which sets `ws` and `connected: true`
3. On each message, `updatePacket()` extracts `DriverTelemetry` via `extractTelemetry()`:
   - `currentGear` decoded from `gears & 0x0f`
   - `suggestedGear` decoded from `(gears >> 4) & 0x0f`
   - `carCategory` defaults to `''` if not present
   - `currentLap` defaults to `0` if not present
4. On close, `disconnectDriver()` sets `ws: null` and `connected: false`
5. `clearDrivers()` closes all WebSocket connections and resets the registry

---

## Ranking and gap computation (`processor.ts`)

### Mode-dependent sorting

Drivers are sorted in `sortActive()` — only connected drivers with valid telemetry are included:

| Mode | Sort criterion | Direction |
|---|---|---|
| `race` | `lapCount + arcFraction` (the `raceScore`) | Descending (higher = P1) |
| `qualifying` / `practice` | `bestLaptime` | Ascending (lower = P1); drivers with `bestLaptime === 0` go to the end |

### Race score

```
raceScore = lapCount + arcFraction
```

- `lapCount` is the integer number of completed laps
- `arcFraction` is a 0.0–1.0 value representing the driver's position along the ideal racing line (computed in `sector-tracker.ts` as `nearestIndex(idealLine, carPos) / (idealLine.length - 1)`)
- A driver who has completed 2 full laps and is 65% through lap 3 has score `2.65`

### Gap calculation — race mode

Gaps are computed as time in seconds:

```
gapToLeader = max(0, (leaderScore - driverScore) × arcLengthM / leaderSpeed)
gapToAhead  = max(0, (aheadScore  - driverScore) × arcLengthM / leaderSpeed)
```

- `arcLengthM` — total length of the ideal racing line in meters (from `track.json`)
- `leaderSpeed` — the leader's current speed in m/s (clamped to ≥ 10 to avoid division by zero)
- The formula converts a score delta (laps + fraction) into a distance delta (by multiplying by arc length), then into time (by dividing by the leader's speed)

### Gap calculation — qualifying / practice mode

```
gapToLeader = max(0, (driverBestLap - leaderBestLap) / 1000)
gapToAhead  = max(0, (driverBestLap - aheadBestLap)  / 1000)
```

- Simple best-lap-time difference in seconds
- If either driver has `bestLaptime === 0` (no lap completed), gap is `0`

### Gap suppression before first lap (race mode)

In race mode, gaps are `0` for any driver whose `lapCount < 1`. This prevents misleading gap values during the formation lap or before crossing the start/finish line for the first time. The check is **per-driver**, not global — a driver who has crossed the start line gets gaps while one who hasn't gets `0`.

### Gap freeze on race finish (race mode)

When a driver finishes the race (`lapCount >= totalLaps` and `totalLaps > 0`), three values are frozen on the **first broadcast tick** after finishing:
- `frozenScore` (the `raceScore` at the moment of finish)
- `frozenGapToLeader`
- `frozenGapToAhead`

On all subsequent ticks:
- `raceScore()` returns `frozenScore` instead of computing live `lapCount + arcFraction`
- `raceGaps()` returns the frozen gap values directly
- This prevents the driver's ranking and gaps from drifting as `arcFraction` continues to update after crossing the finish line

The frozen fields live on `DriverState` and are initialized to `null` (unset). They are never cleared during a session — once frozen, they persist.

### Derived fields (per driver, sent in every `StateBroadcast`)

| Field | Description |
|---|---|
| `rank` | 1-indexed position; 0 if driver has no telemetry |
| `gapToLeader` | Seconds behind P1 |
| `gapToAhead` | Seconds behind the driver directly ahead |
| `sectors` | Per-sector ms times from the last completed lap; `0` = not yet completed |
| `sectorStatus` | `'purple'` / `'green'` / `'red'` / `'neutral'` per sector |
| `bestLapSectors` | Per-sector ms from the driver's fastest lap in the current mode |
| `currentSector` | 0-indexed sector the driver is currently in |
| `arcFraction` | 0.0–1.0 position along the ideal line |
| `pitted` | `true` when speed < 3 m/s (~10 km/h) |

### RaceState (sent in every `StateBroadcast`)

| Field | Source |
|---|---|
| `mode` | Active session mode |
| `trackId` | Active track ID (from `track.json`), or `null` |
| `sectorCount` | Number of sectors in the track |
| `lap` | Leader's `lapCount` |
| `totalLaps` | Leader's `totalLaps` |
| `dayProgression` | Leader's `dayProgression` (0.0–1.0) |
| `order` | Array of driver IDs sorted by rank (index 0 = P1) |

---

## Sector tracking (`sector-tracker.ts`)

### Per-driver state (`DriverSectorState`)

Each driver has persistent sector tracking state stored in a `Map<number, DriverSectorState>`:

| Field | Purpose |
|---|---|
| `currentSector` | 0-indexed sector the driver is currently in; resets to 0 on each lap |
| `sectorStartLapT` | `currentLap` value (ms) when the current sector began |
| `prevSign` | Signed distance from the next boundary on the previous tick; `null` when no boundary is pending |
| `prevLapT` | `currentLap` value at the previous tick; used for sub-packet interpolation |
| `prevLapCount` | `lapCount` on the previous tick; used to detect lap changes |
| `currentLapSectors` | Accumulated sector times for the current lap (ms) |
| `lastLapSectors` | Sector times from the most recently completed full lap |
| `personalBestSectors` | Per-sector personal bests across all laps (driver-level) |
| `arcFraction` | 0.0–1.0 position along the ideal line (always computed, even without track) |
| `bestLapSectorsByMode` | Per-sector times from the fastest lap, keyed by `SessionMode` |
| `bestLapTimeByMode` | Fastest lap time in ms, keyed by `SessionMode` |

### Arc-fraction

Always computed regardless of sector data availability:
```
arcFraction = nearestIndex(idealLine, carPosition) / (idealLine.length - 1)
```

`nearestIndex` finds the index of the closest point on the resampled (500-pt) ideal line.

### Sector crossing detection

Sector boundaries are planes defined by a position and a normal vector (the track-forward tangent direction). The signed distance of the car to a boundary is:

```
signedDist = dot(carPosition - boundaryPosition, boundaryNormal)
```

A sector crossing is detected when `signedDist` transitions from negative to positive (crossing the plane in the forward direction).

**Sub-packet interpolation:** Because telemetry packets arrive at discrete intervals, the exact crossing moment is interpolated linearly between the two packets:
```
crossingFraction = |prevSign| / (|prevSign| + currentSign)
crossingLapT = prevLapT + crossingFraction × (currentLapT - prevLapT)
sectorTime = crossingLapT - sectorStartLapT
```

After a crossing:
- The sector time is pushed to `currentLapSectors`
- `sectorStartLapT` is set to the interpolated crossing time
- `currentSector` is incremented
- `prevSign` and `prevLapT` are reset to `null`

### Lap change handling

When `lapCount` increases (detected by comparing with `prevLapCount`):
1. The final sector is computed using the game's `lastLaptime`: `lastLaptime - sectorStartLapT`
2. If the number of completed sectors equals `sectorCount`, the lap is considered complete:
   - `lastLapSectors` is updated
   - Personal best per sector is updated if the new time is faster
   - **Session best** per sector is updated (shared across all drivers)
   - If in a mode and `lastLaptime` is the driver's fastest in that mode, `bestLapSectorsByMode[mode]` is updated
3. All lap-local state is reset for the new lap

### Sector status

Per-sector status is computed from `lastLapSectors`:

| Status | Condition |
|---|---|
| `'purple'` | Time ≤ session best (fastest anyone has done this sector) |
| `'green'` | Time ≤ driver's personal best |
| `'red'` | Slower than personal best |
| `'neutral'` | Sector not yet completed in the current session |

Session bests are reset on `clearAll()` (called on session creation and track changes).

---

## Track system (`track.ts`)

Tracks are stored as JSON files at `tracks/<trackId>/track.json`. The `ComputedTrack` interface:

```ts
interface ComputedTrack {
  id: string;                    // matches the folder name
  sectorCount: number;           // number of sectors (≥ 2)
  centerline: Vec3[];            // 500 pts — average of left + right edges
  idealLine: Vec3[];             // 500 pts — resampled ideal racing line
  leftLine: Vec3[];              // 500 pts — resampled left track edge
  rightLine: Vec3[];             // 500 pts — resampled right track edge
  arcLengthM: number;            // total arc length of idealLine in meters
  sectorBoundaries: SectorBoundary[];  // one per non-final sector (sectorCount - 1)
  sectorTimesMs: number[];       // per-sector ms from the ideal-line recording lap
  computedAt: string;            // ISO 8601 timestamp
}

interface SectorBoundary {
  arcFraction: number;           // 0.0–1.0 position along idealLine
  position: Vec3;                // center point on idealLine
  normal: Vec3;                  // unit track-forward direction (for signed-distance test)
  leftEdge: Vec3;                // left edge intersection point
  rightEdge: Vec3;               // right edge intersection point
}
```

Tracks are loaded via `loadTrack(trackId)` and stored as `activeTrack` (singleton). If no track is loaded, sector tracking is skipped but arc-fraction is still computed from the ideal line.

### Track calibration pipeline

Three raw recordings are required per track, each captured during one lap:

| Recording | File | How to drive |
|---|---|---|
| Left edge | `left-edge.json` | Hug the left kerb/white line for one full lap |
| Right edge | `right-edge.json` | Hug the right kerb/white line for one full lap |
| Ideal line | `ideal-line.json` | Drive the normal racing line; note sector times shown by the game |

Each recording saves raw `PositionSample[]` (position + `lapT` timestamps).

The `track-processor.ts` `computeTrack()` function:
1. Loads all three recordings
2. Resamples each to 500 equally-spaced points using arc-length parameterization
3. Computes `centerline` as the pointwise average of left and right edges
4. Computes `arcLengthM` as the cumulative arc length of the ideal line
5. Places each sector boundary using `lapTLookup`: for cumulative sector times from the ideal-line lap recording, finds the exact 3D position where the car was at that `lapT` in the ideal-line samples
6. For each boundary, computes:
   - `arcFraction` from nearest-index on the ideal line
   - `normal` (track-forward tangent at that point)
   - `leftEdge` and `rightEdge` via perpendicular projection onto the edge lines
7. Writes `track.json`

The interactive CLI (`yarn record`) guides through this process with six menu actions: Record a line, Process track, Test sectors, Track info, List tracks, Monitor telemetry.

### Sector tester

The `sector-tester.ts` (menu option 3) connects to the overlay feed and performs its own independent sector crossing detection identical to `sector-tracker.ts`'s logic. This allows verifying that calibrated boundaries fire correctly without trusting the server's output. After each lap, the user can enter the game's displayed sector times for side-by-side comparison.

---

## Overlay visibility state (`overlay-state.ts`)

A singleton `OverlayState` controls which overlay modules are visible. Five independent toggles:

| Endpoint | Controls |
|---|---|
| `POST /overlay/standings` | Full-field standings table |
| `POST /overlay/sector` | Sector time comparison (0, 1, or 2 drivers) |
| `POST /overlay/car-telemetry` | Car telemetry gauges (0, 1, or 2 drivers) |
| `POST /overlay/driver-showcase` | Single driver highlight — name, photo, lap times (0 or 1 driver) |
| `POST /overlay/driver-telemetry` | Single driver telemetry HUD — throttle, brake, steering angle (0 or 1 driver) |

The `GET /overlay` endpoint returns the current state. All state is mutable via partial-patch POSTs (only the fields in the request body are updated).

---

## Mock simulation (`mock.ts`)

When `MOCK=true`, 4 simulated drivers race on a 5-lap event. If a real track is loaded, the simulation uses its geometry and sector timing; otherwise a synthetic 1000 m straight with 3 equal sectors is generated.

Each driver has a `PaceConfig` with:
- `pacePct` — lap-time multiplier vs reference (1.06 = 6% slower than the reference)
- `amplitude` — depth of sinusoidal speed variation (simulates braking zones)
- `startArcFrac` — initial position stagger on the grid

The speed model:
```
speed(t) = max(pace × (1 + amplitude × sin(2π × SIN_CYCLES × t/lapTime + phase)), pace × 0.10)
```

Three sinusoidal cycles per lap create braking/acceleration zones. Throttle and brake are derived from `cos(angle)`: positive → throttle, negative → brake. Gear is computed from speed bands (6 gears over 0–50 m/s). RPM is interpolated within the current gear band. Fuel decreases linearly per lap. Tyre temps scale with speed. Day progression advances proportionally to race completion.

The mock sends fully-formed `DriverPacket` objects to `drivers.updatePacket()` and `sectorTracker.update()`, so the entire processing pipeline runs identically to real hardware.

---

## Broadcaster (`broadcaster.ts`)

Maintains a `Set<WebSocket>` of connected overlay clients. The broadcast loop (in `server.ts`) runs at `BROADCAST_HZ`:

```
setInterval(() => {
  if (clientCount() === 0) return;
  broadcast({
    type: 'state',
    drivers: buildDriverBroadcasts(all, mode),
    raceState: buildRaceState(all, mode),
    overlayState: getOverlayState(),
  });
}, 1000 / BROADCAST_HZ);
```

When an overlay client connects, the server immediately sends the current session as a `roster` message so the overlay doesn't wait for the next broadcast tick.

---

## WebSocket protocol

### `/driver?token=<token>`

**Input:** Driver sends JSON frames matching `DriverPacket` structure (see types.ts). The server validates `magic` and `carCode` are numbers, then calls `drivers.updatePacket()` and conditionally `sectorTracker.update()` (only if a track is loaded).

**Close codes:**
- `4001` — token missing
- `4002` — invalid token
- `4003` — no active session

### `/overlay`

**Output:** Server sends two message types:

**`roster`** — sent on connect and when `POST /session` is called:
```json
{ "type": "roster", "session": { ... }, "roster": [...] }
```

**`state`** — sent at `BROADCAST_HZ`:
```json
{
  "type": "state",
  "drivers": { "<driverId>": DriverBroadcast, ... },
  "raceState": RaceState,
  "overlayState": OverlayState
}
```

---

## REST API summary

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Server status (ok, session, driver count, overlay client count) |
| `POST` | `/session` | Create session with `trackId`, `roster`, optional `mode` and `isRecording` |
| `GET` | `/session` | Get active session (404 if none) |
| `DELETE` | `/session` | End session, disconnect all drivers |
| `POST` | `/session/mode` | Switch mode (`race` / `qualifying` / `practice`) |
| `POST` | `/session/track` | Switch track mid-session |
| `POST` | `/driver/join` | Exchange `driverId` for WebSocket token |
| `GET` | `/drivers` | List all roster drivers with connection status and carCode |
| `GET` | `/overlay` | Current overlay visibility state |
| `POST` | `/overlay/standings` | Toggle standings visibility |
| `POST` | `/overlay/sector` | Toggle sector overlay + driverIds (0–2) |
| `POST` | `/overlay/car-telemetry` | Toggle car telemetry overlay + driverIds (0–2) |
| `POST` | `/overlay/driver-showcase` | Toggle driver showcase + driverId |
| `POST` | `/overlay/driver-telemetry` | Toggle driver telemetry overlay + driverId |
| `GET` | `/recorder` | HTML page to start a recording session |

---

## Style conventions

- No test suite — verification is `npx tsc --noEmit`
- Semicolons at end of statements
- Single quotes preferred
- 2-space indentation
- TypeScript strict mode
- All types defined in `types.ts` or co-located in module files
