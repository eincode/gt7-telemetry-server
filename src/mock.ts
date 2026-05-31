import * as drivers from './drivers';
import * as sectorTracker from './sector-tracker';
import * as session from './session';
import { getTrack, setTrack } from './track';
import { broadcast } from './broadcaster';
import type { RosterEntry } from './types';
import type { ComputedTrack, Vec3 } from './recorder/types';

// ── Constants ──────────────────────────────────────────────────────────────────

const TOTAL_LAPS    = 5;
const STAGGER       = 0.025;   // arcFrac gap between grid slots
const FUEL_CAPACITY = 60.0;    // litres
const NUM_GEARS     = 6;
const MAX_SPEED_MS  = 50.0;    // m/s ceiling for gear model
const SIN_CYCLES    = 3;       // braking zones per lap
const MIN_RPM       = 800;
const REDLINE_RPM   = 8000;
const MIN_ALERT_RPM = 7000;
const MAX_ALERT_RPM = 7500;
const DAY_START     = 0.45;
const DAY_END       = 0.55;
const MOCK_MAGIC    = 0x47375330;

// ── Mock roster ────────────────────────────────────────────────────────────────

const MOCK_ROSTER: RosterEntry[] = [
  { id: 1, name: 'Alex Martin',   country: 'GBR' },
  { id: 2, name: 'Kenji Tanaka',  country: 'JPN' },
  { id: 3, name: 'Sofia Russo',   country: 'ITA' },
  { id: 4, name: 'Lars Eriksson', country: 'SWE' },
];

// carCodes for synthetic packets — not in the roster but needed to satisfy DriverPacket.carCode
const MOCK_CAR_CODES = [1200, 2100, 3300, 4400];

// ── Per-driver pace config (index 0 = fastest, starts furthest ahead) ─────────

interface PaceConfig {
  pacePct:      number;  // lap-time multiplier vs reference (1.06 = 6% slower than ref)
  amplitude:    number;  // speed-wave depth A (fraction of base pace)
  sinPhase:     number;  // phase offset so drivers don't brake simultaneously
  startArcFrac: number;  // initial track position (grid stagger)
}

const PACE_CONFIGS: PaceConfig[] = [
  { pacePct: 1.06, amplitude: 0.40, sinPhase: 0.0, startArcFrac: STAGGER * 3 },
  { pacePct: 1.10, amplitude: 0.36, sinPhase: 1.2, startArcFrac: STAGGER * 2 },
  { pacePct: 1.14, amplitude: 0.38, sinPhase: 2.4, startArcFrac: STAGGER * 1 },
  { pacePct: 1.19, amplitude: 0.42, sinPhase: 0.8, startArcFrac: STAGGER * 0 },
];

// ── Synthetic track fallback ───────────────────────────────────────────────────
// A degenerate 1000 m straight with 3 equal sectors.
// Satisfies the full ComputedTrack interface so sectorTracker.update() works
// identically whether a real track is loaded or not.

function buildSyntheticTrack(): ComputedTrack {
  const N = 500;
  const line: Vec3[] = Array.from({ length: N }, (_, i) => [i * (1000 / (N - 1)), 0, 0]);

  return {
    id:          'synthetic',
    sectorCount: 3,
    centerline:  line,
    idealLine:   line,
    leftLine:    line.map(([x]) => [x,  10, 0] as Vec3),
    rightLine:   line.map(([x]) => [x, -10, 0] as Vec3),
    arcLengthM:  1000,
    sectorBoundaries: [
      { arcFraction: 1 / 3, position: [1000 / 3, 0, 0], normal: [1, 0, 0], leftEdge: [1000 / 3,  10, 0], rightEdge: [1000 / 3, -10, 0] },
      { arcFraction: 2 / 3, position: [2000 / 3, 0, 0], normal: [1, 0, 0], leftEdge: [2000 / 3,  10, 0], rightEdge: [2000 / 3, -10, 0] },
    ],
    sectorTimesMs: [26667, 26667, 26667],
    computedAt:    new Date().toISOString(),
  };
}

// ── Per-driver simulation state ────────────────────────────────────────────────

interface MockSim {
  driverId:        number;
  slot:            number;   // index into MOCK_ROSTER / PACE_CONFIGS
  arcFrac:         number;
  lapCount:        number;
  lapStartWallMs:  number;
  lastLaptime:     number;   // ms (0 until first lap completes)
  bestLaptime:     number;   // ms (0 until first lap completes)
  pace:            number;   // m/s base speed = arcLengthM / lapTimeS
  lapTimeS:        number;   // target lap duration in seconds
  amplitude:       number;
  sinPhase:        number;
  fuelPerLap:      number;   // litres per lap
  dayProgression:  number;
  packetId:        number;
  finished:        boolean;
}

// ── Tick one driver ────────────────────────────────────────────────────────────

function tickDriver(
  sim:         MockSim,
  driverState: ReturnType<typeof drivers.resolveToken> & object,
  track:       ComputedTrack,
  tickS:       number,
  mode:        import('./types').SessionMode,
): void {
  const now          = Date.now();
  const lapElapsedS  = (now - sim.lapStartWallMs) / 1000;
  const angle        = 2 * Math.PI * SIN_CYCLES * lapElapsedS / sim.lapTimeS + sim.sinPhase;

  // Speed: sinusoidal wave, floored at 10% of pace
  const speed = Math.max(
    sim.pace * (1 + sim.amplitude * Math.sin(angle)),
    sim.pace * 0.10,
  );

  // Throttle / brake from derivative of speed wave
  const cosVal  = Math.cos(angle);
  const throttle = Math.max(0, cosVal);
  const brake    = Math.max(0, -cosVal);

  // Advance position
  sim.arcFrac += speed * tickS / track.arcLengthM;

  // Current lap time (capture before any reset)
  let currentLapMs = now - sim.lapStartWallMs;

  // ── Lap rollover ────────────────────────────────────────────────────────────
  if (sim.arcFrac >= 1.0) {
    sim.arcFrac    -= 1.0;                // preserve overflow
    sim.lastLaptime = currentLapMs;
    if (sim.bestLaptime === 0 || currentLapMs < sim.bestLaptime) {
      sim.bestLaptime = currentLapMs;
    }
    sim.lapCount++;
    sim.lapStartWallMs = now;
    currentLapMs       = 0;              // signal new lap to sectorTracker
    if (sim.lapCount > TOTAL_LAPS) {
      sim.finished = true;
    }
  }

  // ── Position from ideal line ────────────────────────────────────────────────
  const idx = Math.round(Math.min(sim.arcFrac, 0.9999) * (track.idealLine.length - 1));
  const pos  = track.idealLine[idx];

  // ── Gear & RPM model ────────────────────────────────────────────────────────
  const gearBand = MAX_SPEED_MS / NUM_GEARS;
  const gear     = Math.min(NUM_GEARS, Math.max(1, Math.ceil(speed / gearBand)));
  const speedInGear = speed - (gear - 1) * gearBand;
  const rpm = Math.min(REDLINE_RPM, Math.max(MIN_RPM,
    MIN_RPM + (speedInGear / gearBand) * (REDLINE_RPM - MIN_RPM),
  ));
  const gearEncoded = (gear << 4) | gear;  // currentGear = suggestedGear

  // ── Fuel & temps ────────────────────────────────────────────────────────────
  const lapsConsumed = (sim.lapCount - 1) + sim.arcFrac;
  const fuelLevel    = Math.max(0, FUEL_CAPACITY - lapsConsumed * sim.fuelPerLap);
  const tyreBase     = 85 + speed * 0.3;
  const tyreTemp: [number, number, number, number] = [
    tyreBase, tyreBase + 2, tyreBase - 1, tyreBase + 1,
  ];

  // ── Day progression ─────────────────────────────────────────────────────────
  const dayRange   = DAY_END - DAY_START;
  const raceTotalS = TOTAL_LAPS * sim.lapTimeS;
  sim.dayProgression = Math.min(DAY_END, sim.dayProgression + (dayRange / raceTotalS) * tickS);

  // ── Wheel RPS ────────────────────────────────────────────────────────────────
  const wheelRPS = speed / (2 * Math.PI * 0.33);
  const wrps: [number, number, number, number] = [wheelRPS, wheelRPS, wheelRPS, wheelRPS];

  // ── Build synthetic DriverPacket ─────────────────────────────────────────────
  const packet = {
    magic:                  MOCK_MAGIC,
    position:               pos as [number, number, number],
    worldVelocity:          [speed, 0, 0] as [number, number, number],
    rotation:               [0, 0, 0] as [number, number, number],
    orientationRelativeToNorth: 0,
    angularVelocity:        [0, 0, 0] as [number, number, number],
    bodyHeight:             0.12,
    EngineRPM:              rpm,
    iv:                     [0, 0, 0, 0] as [number, number, number, number],
    fuelLevel,
    fuelCapacity:           FUEL_CAPACITY,
    speed,
    boost:                  1.0,
    oilPressure:            400,
    waterTemp:              85,
    oilTemp:                95,
    tyreTemp,
    packetId:               sim.packetId++,
    lapCount:               sim.lapCount,
    totalLaps:              TOTAL_LAPS,
    bestLaptime:            sim.bestLaptime,
    lastLaptime:            sim.lastLaptime,
    dayProgression:         sim.dayProgression,
    RaceStartPosition:      sim.slot + 1,
    preRaceNumCars:         MOCK_ROSTER.length,
    minAlertRPM:            MIN_ALERT_RPM,
    maxAlertRPM:            MAX_ALERT_RPM,
    calcMaxSpeed:           MAX_SPEED_MS * 3.6,
    flags:                  0,
    gears:                  gearEncoded,
    throttle:               Math.round(throttle * 255),
    brake:                  Math.round(brake    * 255),
    roadPlane:              [0, 1, 0] as [number, number, number],
    roadPlaneDistance:      0,
    wheelRPS:               wrps,
    tyreRadius:             [0.33, 0.33, 0.33, 0.33] as [number, number, number, number],
    suspHeight:             [0.05, 0.05, 0.05, 0.05] as [number, number, number, number],
    clutch:                 1.0,
    clutchEngagement:       1.0,
    RPMFromClutchToGearbox: 0,
    transmissionTopSpeed:   MAX_SPEED_MS * 3.6,
    gearRatios:             [3.5, 2.5, 1.8, 1.4, 1.1, 0.9, 0.0, 0.0] as [number, number, number, number, number, number, number, number],
    carCode:                MOCK_CAR_CODES[sim.slot],
    currentLap:             currentLapMs,
    carCategory:            'GT3',
  };

  drivers.updatePacket(driverState, packet);
  sectorTracker.update(sim.driverId, track, pos, currentLapMs, sim.lapCount, sim.lastLaptime, mode);
}

// ── Entry point ────────────────────────────────────────────────────────────────

export function startMockSimulation(broadcastHz: number): void {
  drivers.clearDrivers();
  sectorTracker.clearAll();

  const loadedTrack = getTrack();
  const track       = loadedTrack ?? buildSyntheticTrack();
  if (!loadedTrack) setTrack(track);  // register synthetic track so processor.ts can read it
  const refLapTimeS = track.id === 'synthetic'
    ? 80
    : track.sectorTimesMs.reduce((a, b) => a + b, 0) / 1000;
  const fuelPerLap = track.id === 'synthetic'
    ? 5.0
    : Math.max(1, track.arcLengthM * 2 / 1000);  // ~2 L/km

  // Create session — mock always runs in race mode
  const s = session.createSession(MOCK_ROSTER, 'race', track.id);
  broadcast({ type: 'roster', session: s, roster: MOCK_ROSTER });

  // Register and mark all 4 drivers as connected (no real WebSocket)
  const sims: MockSim[] = [];
  const driverStates:  NonNullable<ReturnType<typeof drivers.resolveToken>>[] = [];

  for (let i = 0; i < MOCK_ROSTER.length; i++) {
    const cfg   = PACE_CONFIGS[i];
    const entry = MOCK_ROSTER[i];
    const token = drivers.registerDriver(entry.id);
    const state = drivers.resolveToken(token)!;
    drivers.connectDriverMock(state);
    driverStates.push(state);

    sims.push({
      driverId:       entry.id,
      slot:           i,
      arcFrac:        cfg.startArcFrac,
      lapCount:       1,
      lapStartWallMs: Date.now(),
      lastLaptime:    0,
      bestLaptime:    0,
      pace:           track.arcLengthM / (refLapTimeS * cfg.pacePct),
      lapTimeS:       refLapTimeS * cfg.pacePct,
      amplitude:      cfg.amplitude,
      sinPhase:       cfg.sinPhase,
      fuelPerLap,
      dayProgression: DAY_START,
      packetId:       0,
      finished:       false,
    });
  }

  const tickMs = Math.round(1000 / broadcastHz);
  setInterval(() => {
    const tickS = tickMs / 1000;
    for (let i = 0; i < sims.length; i++) {
      if (!sims[i].finished) {
        tickDriver(sims[i], driverStates[i], track, tickS, 'race');
      }
    }
  }, tickMs);

  const trackLabel = track.id === 'synthetic'
    ? 'synthetic track (no TRACK_ID set)'
    : `track "${track.id}" (${track.arcLengthM.toFixed(0)} m, ${track.sectorCount} sectors)`;
  console.log(`[mock] simulating ${MOCK_ROSTER.length} drivers on ${trackLabel}, ${TOTAL_LAPS} laps`);
}
