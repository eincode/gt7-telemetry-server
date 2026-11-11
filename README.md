# gt7-telemetry-server

A relay server that receives Gran Turismo 7 telemetry from one or more driver clients, computes real-time race standings and sector data, and broadcasts everything to overlay frontends over WebSocket.

---

## Quick start

```bash
yarn dev                          # real drivers, no track
TRACK_ID=tsukuba yarn dev         # real drivers + Tsukuba sector boundaries
yarn mock                         # 4 simulated drivers (no hardware needed)
TRACK_ID=tsukuba yarn mock        # simulated drivers on a real track layout
```

### Environment variables

| Variable       | Default | Description                                               |
| -------------- | ------- | --------------------------------------------------------- |
| `PORT`         | `3000`  | HTTP / WebSocket port                                     |
| `BROADCAST_HZ` | `20`    | Overlay broadcast rate (1–60 Hz)                          |
| `TRACK_ID`     | —       | Load a pre-calibrated track from `tracks/<id>/track.json` |
| `MOCK`         | `false` | Set `true` to simulate 4 drivers without hardware         |
| `SERIAL_PORT`  | auto    | Director Arduino serial port; on macOS auto-detects `/dev/cu.usbserial*` / `/dev/cu.wchusbserial*` |

---

## REST API

All endpoints accept and return `application/json` unless noted otherwise.

---

### `GET /health`

Server status check.

**Response `200`**

```json
{
  "ok": true,
  "session": true,
  "drivers": {
    "total": 4,
    "connected": 3
  },
  "overlayClients": 1,
  "serial": {
    "connected": true,
    "path": "/dev/cu.usbserial-1110"
  }
}
```

`serial.path` is the port last opened or attempted (`null` if no adapter has been found).

---

### `POST /director-command`

Tap one key on the PS5 (GT7 spectator camera control). Writes a single byte at 115200 8N1 to the USB-to-serial adapter; the Arduino Pro Micro presses and releases the key. If the adapter is unplugged or the port closes, the server retries every 2 s.

**Request body**

```json
{ "key": "z" }
```

`key` must be a single character from `1 2 3 4 5 6 7 8 9 0 q w e r t y g h j k l z x c v` (case-insensitive; sent lowercased).

**Response `200`**

```json
{ "ok": true, "key": "z" }
```

**Response `400`** — missing, multi-character, or disallowed key (nothing is sent)

**Response `503`** — `{ "ok": false, "error": "serial not connected" }`

---

### `POST /session`

Create a new session with a driver roster. Clears any existing session and resets sector tracking. Broadcasts a `roster` message to all connected overlay clients.

**Request body**

```json
{
  "trackId": "tsukuba",
  "roster": [
    { "id": 1, "name": "Alex Martin", "country": "GBR" },
    { "id": 2, "name": "Kenji Tanaka", "country": "JPN" }
  ],
  "mode": "practice"
}
```

| Field              | Type            | Notes                                                              |
| ------------------ | --------------- | ------------------------------------------------------------------ |
| `trackId`          | `string`        | Required. Must match a folder under `tracks/` with a `track.json`. |
| `roster`           | `RosterEntry[]` | Required. 1–16 entries.                                            |
| `roster[].id`      | `number`        | Unique driver ID within the session.                               |
| `roster[].name`    | `string`        | Display name.                                                      |
| `roster[].country` | `string`        | ISO 3166-1 alpha-3 country code (e.g. `"GBR"`).                   |
| `mode`             | `string`        | Optional. `"practice"` (default), `"qualifying"`, or `"race"`.     |

**Response `201`**

```json
{
  "session": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "waiting",
    "mode": "practice",
    "trackId": "tsukuba",
    "createdAt": 1716900000000,
    "roster": [
      { "id": 1, "name": "Alex Martin", "country": "GBR" },
      { "id": 2, "name": "Kenji Tanaka", "country": "JPN" }
    ]
  }
}
```

**Response `400`** — missing/invalid `trackId` (track not found), missing/invalid roster, roster exceeds 16 entries, or invalid `mode`.

---

### `GET /session`

Get the active session (includes the full roster).

**Response `200`**

```json
{
  "session": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "waiting",
    "mode": "qualifying",
    "trackId": "tsukuba",
    "createdAt": 1716900000000,
    "roster": [{ "id": 1, "name": "Alex Martin", "country": "GBR" }]
  }
}
```

**Response `404`** — no active session.

---

### `POST /session/track`

Change the active track without ending the session. Reloads track geometry and resets all sector tracking state for every driver (crossing history, sector times, arc-fractions).

**Request body**

```json
{ "trackId": "brands-hatch-indy" }
```

**Response `200`**

```json
{ "ok": true, "trackId": "brands-hatch-indy" }
```

**Response `400`** — no active session, missing `trackId`, or track file not found.

---

### `POST /session/mode`

Change the session mode without ending the session. Drivers stay connected; the ranking and gap logic switches immediately on the next broadcast tick.

**Request body**

```json
{ "mode": "qualifying" }
```

`mode` must be `"race"`, `"qualifying"`, or `"practice"`.

**Response `200`**

```json
{ "ok": true, "mode": "qualifying" }
```

**Response `400`** — no active session, or invalid `mode`.

---

### `DELETE /session`

End the active session and disconnect all drivers.

**Response `200`**

```json
{ "ok": true }
```

---

### `POST /driver/join`

Exchange a driver ID for a WebSocket connection token. A session must be active and the driver ID must be in the roster.

**Request body**

```json
{ "driverId": 1 }
```

**Response `200`**

```json
{
  "token": "3f4a1b2c-...",
  "driverId": 1,
  "name": "Alex Martin"
}
```

**Response `400`** — no active session, or missing/invalid `driverId`.  
**Response `404`** — driver ID not in roster.

---

### `GET /drivers`

List all registered drivers with their connection status.

**Response `200`**

```json
{
  "drivers": [
    {
      "id": 1,
      "name": "Alex Martin",
      "carCode": 1200,
      "connected": true,
      "lastSeen": 1716900123456
    }
  ]
}
```

| Field      | Description                                                              |
| ---------- | ------------------------------------------------------------------------ |
| `carCode`  | Car ID from the first telemetry packet received (0 if not yet received). |
| `lastSeen` | Unix timestamp (ms) of the last telemetry packet. 0 if never received.   |

---

### `GET /overlay`

Read the current overlay visibility state.

**Response `200`**

```json
{
  "standings": { "visible": false },
  "sector": { "visible": false, "driverIds": [] },
  "carTelemetry": { "visible": false, "driverIds": [] },
  "driverShowcase": { "visible": false, "driverId": null },
  "driverTelemetry": { "visible": false, "driverId": null },
  "trackMap": { "visible": false }
}
```

---

### `POST /overlay/standings`

Toggle the standings overlay. All fields are optional — only the fields included in the body are updated.

**Request body**

```json
{ "visible": true }
```

**Response `200`**

```json
{
  "ok": true,
  "overlayState": {
    "standings": { "visible": true },
    "sector": { "visible": false, "driverIds": [] },
    "carTelemetry": { "visible": false, "driverIds": [] },
    "driverShowcase": { "visible": false, "driverId": null },
    "driverTelemetry": { "visible": false, "driverId": null },
    "trackMap": { "visible": false }
  }
}
```

---

### `POST /overlay/sector`

Toggle the sector overlay and optionally set which drivers to display.

**Request body**

```json
{
  "visible": true,
  "driverIds": [1, 3]
}
```

| Field       | Type       | Notes                                                                                    |
| ----------- | ---------- | ---------------------------------------------------------------------------------------- |
| `visible`   | `boolean`  | Optional.                                                                                |
| `driverIds` | `number[]` | Optional. 0 entries = no focus; 1 = single driver view; 2 = side-by-side compare. Max 2. |

**Response `200`** — same shape as `POST /overlay/standings`.  
**Response `400`** — `driverIds` contains more than 2 entries or non-numeric values.

---

### `POST /overlay/car-telemetry`

Toggle the car telemetry overlay and optionally set which drivers to display.

**Request body**

```json
{
  "visible": true,
  "driverIds": [2]
}
```

Same field rules as `POST /overlay/sector`.

**Response `200`** — same shape as `POST /overlay/standings`.

---

### `POST /overlay/driver-showcase`

Toggle the driver showcase overlay and optionally set which driver to feature.

**Request body**

```json
{
  "visible": true,
  "driverId": 1
}
```

| Field      | Type             | Notes                                        |
| ---------- | ---------------- | -------------------------------------------- |
| `visible`  | `boolean`        | Optional.                                    |
| `driverId` | `number \| null` | Optional. `null` clears the selected driver. |

**Response `200`** — same shape as `POST /overlay/standings`.  
**Response `400`** — `driverId` is not a number or null.

---

### `POST /overlay/driver-telemetry`

Toggle the driver telemetry overlay and optionally set which driver to feature. Designed to show a single driver's telemetry data (throttle, brake, steering wheel angle).

**Request body**

```json
{
  "visible": true,
  "driverId": 1
}
```

| Field      | Type             | Notes                                        |
| ---------- | ---------------- | -------------------------------------------- |
| `visible`  | `boolean`        | Optional.                                    |
| `driverId` | `number \| null` | Optional. `null` clears the selected driver. |

**Response `200`** — same shape as `POST /overlay/standings`.
**Response `400`** — `driverId` is not a number or null.

---

### `POST /overlay/track-map`

Toggle the track map overlay, which draws the active track and every driver's live position with a short-name label.

**Request body**

```json
{ "visible": true }
```

**Response `200`** — same shape as `POST /overlay/standings`.
**Response `400`** — `visible` is not a boolean.

---

### `GET /tracks/:id/map`

Top-down geometry for one layout, projected to `[x, z]` world metres and rounded to 0.1 m. `id` is a layout id from `GET /tracks`.

**Response `200`**

```json
{
  "id": "suzuka",
  "centerline": [[543, -149.6], ...],
  "leftEdge": [[...], ...],
  "rightEdge": [[...], ...],
  "sectorBoundaries": [[409.3, 29.5], ...],
  "sectors": [{ "left": [403.9, 27.5], "right": [411.8, 30.4] }, ...]
}
```

**Response `400`** — invalid id. **Response `404`** — no `tracks/<id>/track.json`.

---

### `GET /recorder`

Returns an HTML page with a **Start recording session** button. Opens in any browser and creates a single-driver session (id `1`, name `Recorder`, country `ID`) used during track calibration. No JSON — this endpoint serves `text/html`.

---

## Run recording & replay

Record your own 5-lap time-trial runs (e.g. one per tyre compound), then replay them together as a race — one driver per run — so you can test overlays without other people driving live. Replayed packets go through the same pipeline as live WebSocket packets (driver state, gap engine, sector tracker).

**Workflow**

1. Create a session on the track and connect your client as usual (`POST /session`, `POST /driver/join`).
2. `POST /recordings/arm { "driverId": 1, "label": "RS" }`, then drive in GT7 Time Trial.
3. Recording starts at your first start-line crossing (the out-lap is dropped) and saves automatically when lap 5 is complete. Paused-game frames are skipped and removed from the timeline. Anything you drive afterwards is ignored.
4. Re-arm with the next label (`RM`, `RH`, …) and repeat. Re-using a label overwrites that run.
5. `POST /replay/start { "trackId": "tsukuba", "runs": ["RS", "RM", "RH"] }`.

Runs are saved as compact JSON at `recordings/<trackId>/<label>.json` (all raw packets plus ~2 s of pre-roll before the line, roughly 1–2 KB per packet at 60 Hz).

**Replay behaviour**

- Creates a fresh **race** session; roster ids are `1…N` in the order of `runs`, names are the labels. The first run starts on pole.
- Flying start: each driver crosses the line `staggerMs` after the one ahead (default `300`).
- Time-trial packets are rewritten into race packets: `lapCount` `0` before the line, `1…5` during the race, `6` once finished; `totalLaps` `5`; `lastLaptime`/`bestLaptime` recomputed from the run; `RaceStartPosition`/`preRaceNumCars` set from the replay's live order.
- Plays once at 1×. Finished drivers hold their final packet. Creating or ending a session stops the replay.
- Unavailable while `MOCK=true`. Arming a recording is refused while a replay is running.

### `POST /recordings/arm`

```json
{ "driverId": 1, "label": "RS" }
```

`label`: letters, digits, `-` and `_` only. The run is stored under the active session's `trackId`. Re-arming the same driver restarts it.

**Response `201`** — `{ "armed": ArmedStatus }`
**Response `400`** — no session / invalid label · **`404`** — driver not in roster · **`409`** — replay running

### `POST /recordings/cancel`

`{ "driverId": 1 }` cancels one driver's armed or in-progress run; an empty body cancels all.

**Response `200`** — `{ "ok": true, "cancelled": 1 }` · **`404`** — driver is not armed

### `GET /recordings`

Armed drivers and saved runs. Optional `?trackId=` filter.

```json
{
  "armed": [
    { "driverId": 1, "label": "RM", "trackId": "tsukuba", "phase": "recording", "lap": 3, "elapsedMs": 128400 }
  ],
  "runs": {
    "tsukuba": [
      { "label": "RS", "laps": 5, "driverId": 1, "recordedAt": "…", "durationMs": 301230, "lapTimesMs": [60120, 60050, 60310, 60400, 60350], "packetCount": 18074 }
    ]
  }
}
```

`phase` is `waiting` until the line crossing, then `recording`.

### `POST /replay/start`

```json
{ "trackId": "tsukuba", "runs": ["RS", "RM", "RH"], "staggerMs": 300 }
```

| Field       | Type       | Notes                                                    |
| ----------- | ---------- | -------------------------------------------------------- |
| `trackId`   | `string`   | Required. Must have a `track.json` and saved recordings. |
| `runs`      | `string[]` | Required. 1–16 distinct labels.                          |
| `staggerMs` | `number`   | Optional, `0`–`10000`. Default `300`.                    |

**Response `201`** — `{ "session": Session, "replay": ReplayStatus }`
**Response `400`** — invalid input, missing recording, or track not found · **`409`** — `MOCK=true`

### `GET /replay`

```json
{
  "state": "running",
  "trackId": "tsukuba",
  "staggerMs": 300,
  "elapsedMs": 42000,
  "drivers": [
    { "id": 1, "label": "RS", "lap": 3, "position": 1, "finished": false, "lapTimesMs": [60120, 60050, 60310, 60400, 60350] }
  ]
}
```

`state` is `idle`, `running`, or `finished`.

### `POST /replay/stop`

Stops playback and marks replay drivers disconnected. The session stays.

**Response `200`** — `{ "ok": true, "stopped": true }`

---

## WebSocket

### `/driver?token=<token>`

Driver telemetry input. Connect after obtaining a token from `POST /driver/join`.

Send JSON frames matching the `DriverPacket` structure (mirrors the GT7 UDP telemetry format). The server uses the `position`, `currentLap`, `lapCount`, and `lastLaptime` fields for sector tracking.

```
ws://localhost:3000/driver?token=3f4a1b2c-...
```

Close codes:

- `4001` — token missing
- `4002` — invalid token
- `4003` — no active session

---

### `/overlay`

Overlay frontend output. Connect to receive the broadcast stream.

```
ws://localhost:3000/overlay
```

On connection, the server immediately sends the current session state as a `roster` message (so the overlay doesn't wait for the next broadcast tick).

Two message types are sent:

#### `RosterBroadcast`

Sent once on overlay connect, and again whenever `POST /session` is called.

```ts
{
  type:    "roster";
  session: {
    id:        string;
    status:    "waiting" | "racing" | "finished";
    mode:      "race" | "qualifying" | "practice";
    trackId:   string;
    createdAt: number;        // Unix ms
    roster:    RosterEntry[];
  };
  roster: RosterEntry[];      // same as session.roster, provided for convenience
}
```

#### `StateBroadcast`

Sent at `BROADCAST_HZ` (default 20 Hz).

```ts
{
  type: "state";

  drivers: {
    [driverId: number]: {
      id:        number;
      connected: boolean;
      lastSeen:  number;       // Unix ms
      telemetry: DriverTelemetry | null;
      derived:   Derived;
    }
  };

  raceState: {
    mode:           "race" | "qualifying" | "practice";
    trackId:        string | null;   // matches TRACK_ID env var, null if no track loaded
    sectorCount:    number;
    lap:            number;          // current lap of the rank-1 driver, clamped to totalLaps
    totalLaps:      number;
    phase:          "racing" | "finalLap" | "finished";
                                     // finished = chequered flag (first driver has crossed the line);
                                     // always "racing" outside race mode
    dayProgression: number;          // 0.0–1.0
    order:          number[];        // driver IDs sorted by rank (index 0 = P1)
    // rank order and gap logic differ by mode — see table below
  };

  overlayState: {
    standings:      { visible: boolean };
    sector:         { visible: boolean; driverIds: number[] };
    carTelemetry:   { visible: boolean; driverIds: number[] };
    driverShowcase: { visible: boolean; driverId: number | null };
    driverTelemetry: { visible: boolean; driverId: number | null };
    trackMap:       { visible: boolean };
  };
}
```

##### `DriverTelemetry`

```ts
{
  // Identification
  carCode:            number;
  carCategory:        string;        // e.g. "GT3"

  // Position & laps
  lapCount:           number;
  totalLaps:          number;
  bestLaptime:        number;        // ms; 0 until first lap completed
  lastLaptime:        number;        // ms; 0 until first lap completed
  currentLap:         number;        // ms elapsed in the current lap
  RaceStartPosition:  number;        // grid slot (1-indexed)
  dayProgression:     number;        // 0.0–1.0

  // Motion
  speed:              number;        // m/s
  position:           [x: number, y: number, z: number];

  // Engine
  EngineRPM:          number;
  minAlertRPM:        number;
  maxAlertRPM:        number;
  gears:              number;        // raw byte: low nibble = current, high = suggested
  currentGear:        number;        // decoded from gears
  suggestedGear:      number;        // decoded from gears

  // Controls
  throttle:           number;        // 0–255
  brake:              number;        // 0–255
  wheelRotation:      number;        // radians, raw from PacketB; 0 if not sent

  // Fuel
  fuelLevel:          number;        // litres
  fuelCapacity:       number;        // litres

  // Tyres
  tyreTemp:           [FL: number, FR: number, RL: number, RR: number];  // °C
}
```

##### `Derived`

Computed server-side each broadcast tick from telemetry + sector tracking.

```ts
{
  rank:         number;    // 1-indexed; 0 if driver has no telemetry
  gapToLeader:  number;    // seconds behind P1 (see mode table below)
  gapToAhead:   number;    // seconds behind the driver directly ahead
  arcFraction:  number;    // 0.0–1.0 position along the ideal line
  pitted:       boolean;   // true when speed < ~10 km/h

  // One entry per sector (length = raceState.sectorCount)
  currentSector:  number;          // 0-indexed sector the driver is currently in (resets to 0 at each lap)
  sectors:        number[];        // ms times from the last completed lap; 0 = not yet completed
  sectorStatus:   SectorStatus[];  // "purple" | "green" | "red" | "neutral"
  bestLapSectors: number[];        // ms times from the driver's fastest lap in the current mode;
                                   // empty [] until a lap completes in this mode
}
```

`sectorStatus` values:

- `"purple"` — session best (fastest anyone has done this sector)
- `"green"` — personal best (fastest this driver has done this sector)
- `"red"` — slower than personal best
- `"neutral"` — sector not yet completed

##### Mode behaviour

| | `race` | `qualifying` / `practice` |
|---|---|---|
| **`raceState.order`** | `lapCount + arcFraction` descending | `bestLaptime` ascending; no-time drivers at end |
| **`derived.rank`** | position on track | fastest-lap position |
| **`derived.gapToLeader`** | `(scoreDelta × arcLength) / leaderSpeed` s | `(myBestLap − leaderBestLap) / 1000` s |
| **`derived.gapToAhead`** | same formula vs car ahead | `(myBestLap − carAheadBestLap) / 1000` s |
| **`derived.bestLapSectors`** | sectors from fastest lap in race mode | sectors from fastest lap in qualifying/practice mode |

Gaps in qualifying/practice are `0` for drivers who have not yet completed a lap (`bestLaptime === 0`). `bestLapSectors` is stored independently per mode — switching modes does not clear previous recordings.

---

## Track calibration

Track calibration records the physical boundaries and racing lines of a circuit so the server can compute accurate arc-fraction positions and sector crossing times.

### Prerequisites

The relay server must be running (`yarn dev`) before starting any recording.

### Step 1 — create a session for the recorder

Open `http://localhost:3000/recorder` in a browser and click **Start recording session**. This creates a session with driver ID `1` (`Recorder`). You can also call `POST /session` directly.

### Step 2 — open the recorder CLI

```bash
yarn record
```

The interactive menu presents six actions:

| #   | Action                | Description                                               |
| --- | --------------------- | --------------------------------------------------------- |
| 1   | **Record a line**     | Capture position data for one lap of a specific line type |
| 2   | **Process track**     | Compute sector boundaries from recorded lines             |
| 3   | **Test sectors**      | Live verification that sector crossings fire correctly    |
| 4   | **Track info**        | Show which lines have been recorded and track metadata    |
| 5   | **List tracks**       | Show all tracks on disk                                   |
| 6   | **Monitor telemetry** | Live telemetry dashboard for debugging                    |

### Step 3 — record the three lines

You need three recordings per track, each done as a separate lap:

| Line           | How to drive                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------- |
| **left edge**  | Hug the left kerb/white line continuously for one full lap                                        |
| **right edge** | Hug the right kerb/white line continuously for one full lap                                       |
| **ideal line** | Drive your normal racing line — **note the sector times shown by the game** at the end of the lap |

For each recording:

1. Choose **Record a line**
2. Enter (or select) a track ID — use a short slug, e.g. `tsukuba` or `brands-hatch-indy`
3. Choose the line type (`left`, `right`, or `ideal`)
4. Enter driver ID `1`
5. Confirm the server URL (default `ws://localhost:3000/overlay`)
6. Drive one complete lap in GT7 — the recorder starts automatically when it detects movement and stops when a new lap begins
7. The line is saved to `tracks/<id>/<line>.json`

Repeat for all three line types.

### Step 4 — process the track

1. Choose **Process track**
2. Select the track
3. Enter the sector times from the **ideal-line lap** as shown by the game, comma-separated in seconds — e.g. `28.451,15.023,18.204`

The processor computes arc-length parameterization, sector boundary positions and normals, and writes `tracks/<id>/track.json`.

### Step 5 — verify with sector tester

1. Choose **Test sectors**
2. Select the processed track
3. Enter driver ID `1` and drive a lap

The terminal shows each sector crossing in real time as it fires. Confirm the crossings match the circuit's actual sector markers.

### Step 6 — start the server with the track

```bash
TRACK_ID=tsukuba yarn dev
```

The `TRACK_ID` value must match the folder name under `tracks/`. Once loaded, every `StateBroadcast` will contain the correct `raceState.trackId`, `raceState.sectorCount`, and per-driver `derived.sectorStatus` data.

### Track files on disk

```
tracks/
  tsukuba/
    left-edge.json    raw position samples (left kerb)
    right-edge.json   raw position samples (right kerb)
    ideal-line.json   raw position samples (racing line)
    track.json        computed track — loaded by the server
```

Only `track.json` is required at runtime. The three raw recordings can be kept for re-processing if sector times need to be corrected.
