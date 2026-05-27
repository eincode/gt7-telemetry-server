import type { ComputedTrack, Vec3, SectorBoundary } from './recorder/types';
import type { SectorStatus } from './types';

// ── Vec3 math ──────────────────────────────────────────────────────────────────

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function signedDist(carPos: Vec3, b: SectorBoundary): number {
  return dot3(sub3(carPos, b.position), b.normal);
}

function nearestIndex(line: Vec3[], P: Vec3): number {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = dist3(line[i], P);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// ── Per-driver state ───────────────────────────────────────────────────────────

export interface DriverSectorState {
  currentSector: number;
  sectorStartLapT: number;
  prevSign: number | null;
  prevLapT: number | null;
  prevLapCount: number | null;
  currentLapSectors: number[];
  lastLapSectors: number[];       // most recently completed full lap
  personalBestSectors: number[];  // per-sector personal bests across all laps
  arcFraction: number;            // 0–1 position along the ideal line
}

// Session-level best per sector across all drivers — reset on clearAll()
const sessionBestSectors: number[] = [];
const driverStates = new Map<number, DriverSectorState>();

function getOrCreate(driverId: number): DriverSectorState {
  let state = driverStates.get(driverId);
  if (!state) {
    state = {
      currentSector: 0,
      sectorStartLapT: 0,
      prevSign: null,
      prevLapT: null,
      prevLapCount: null,
      currentLapSectors: [],
      lastLapSectors: [],
      personalBestSectors: [],
      arcFraction: 0,
    };
    driverStates.set(driverId, state);
  }
  return state;
}

export function getState(driverId: number): DriverSectorState | undefined {
  return driverStates.get(driverId);
}

export function clearAll(): void {
  driverStates.clear();
  sessionBestSectors.length = 0;
}

export function update(
  driverId: number,
  track: ComputedTrack,
  carPos: Vec3,
  currentLapT: number | undefined,
  lapCount: number,
  lastLaptime: number,
): void {
  const { sectorCount, sectorBoundaries, idealLine } = track;
  const state = getOrCreate(driverId);

  // ── arc-fraction for ranking (always computed) ─────────────────────────────
  const idx = nearestIndex(idealLine, carPos);
  state.arcFraction = idx / (idealLine.length - 1);

  // Skip sector crossing logic if no lap timing data
  if (currentLapT === undefined) {
    state.prevLapCount = lapCount;
    return;
  }

  // ── lap change ─────────────────────────────────────────────────────────────
  if (state.prevLapCount !== null && lapCount > state.prevLapCount) {
    // Finalize the last sector using the game's reported total lap time
    if (lastLaptime > 0 && lastLaptime < 600_000) {
      const lastSectorMs = lastLaptime - state.sectorStartLapT;
      if (lastSectorMs > 0) state.currentLapSectors.push(lastSectorMs);
    }

    if (state.currentLapSectors.length === sectorCount) {
      state.lastLapSectors = [...state.currentLapSectors];
      // Update personal and session bests
      for (let s = 0; s < sectorCount; s++) {
        const t = state.currentLapSectors[s];
        if (state.personalBestSectors[s] === undefined || t < state.personalBestSectors[s]) {
          state.personalBestSectors[s] = t;
        }
        if (sessionBestSectors[s] === undefined || t < sessionBestSectors[s]) {
          sessionBestSectors[s] = t;
        }
      }
    }

    state.currentSector = 0;
    state.sectorStartLapT = 0;
    state.currentLapSectors = [];
    state.prevSign = null;
    state.prevLapT = null;
  }
  state.prevLapCount = lapCount;

  // ── sector crossing detection ──────────────────────────────────────────────
  if (state.currentSector < sectorBoundaries.length) {
    const boundary = sectorBoundaries[state.currentSector];
    const sd = signedDist(carPos, boundary);

    if (state.prevSign === null) {
      state.prevSign = sd;
      state.prevLapT = currentLapT;
    } else if (state.prevSign < 0 && sd >= 0) {
      // Sub-packet interpolation: estimate exact crossing moment
      const f = Math.abs(state.prevSign) / (Math.abs(state.prevSign) + sd);
      const crossingLapT = (state.prevLapT ?? currentLapT) + f * (currentLapT - (state.prevLapT ?? currentLapT));
      state.currentLapSectors.push(crossingLapT - state.sectorStartLapT);
      state.sectorStartLapT = crossingLapT;
      state.currentSector++;
      state.prevSign = null;
      state.prevLapT = null;
    } else {
      state.prevSign = sd;
      state.prevLapT = currentLapT;
    }
  }
}

export function getSectorStatus(driverId: number, sectorIndex: number): SectorStatus {
  const state = driverStates.get(driverId);
  if (!state || state.lastLapSectors[sectorIndex] === undefined) return 'neutral';

  const t           = state.lastLapSectors[sectorIndex];
  const sessionBest = sessionBestSectors[sectorIndex];
  const personalBest = state.personalBestSectors[sectorIndex];

  if (sessionBest !== undefined && t <= sessionBest) return 'purple';
  if (personalBest !== undefined && t <= personalBest) return 'green';
  return 'red';
}
