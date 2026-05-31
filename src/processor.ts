import type { DriverState } from './drivers';
import * as sectorTracker from './sector-tracker';
import { getTrack } from './track';
import type { Derived, DriverBroadcast, RaceState, SectorStatus, SessionMode } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function nullDerived(sectorCount: number): Derived {
  return {
    rank: 0,
    gapToLeader: 0,
    gapToAhead: 0,
    sectors: Array<number>(sectorCount).fill(0),
    sectorStatus: Array<SectorStatus>(sectorCount).fill('neutral'),
    bestLapSectors: [],
    currentSector: 0,
    arcFraction: 0,
    pitted: false,
  };
}

// race mode: higher score = further ahead
function raceScore(d: DriverState): number {
  if (!d.telemetry) return -1;
  return d.telemetry.lapCount + (sectorTracker.getState(d.id)?.arcFraction ?? 0);
}

// Sort the connected+telemetry drivers by the correct criterion for the mode.
// qualifying / practice → ascending bestLaptime (0 = no lap set, goes to end).
// race                  → descending raceScore (lapCount + arcFraction).
function sortActive(drivers: DriverState[], mode: SessionMode): DriverState[] {
  const active = drivers.filter((d) => d.connected && d.telemetry !== null);

  if (mode === 'race') {
    return [...active].sort((a, b) => raceScore(b) - raceScore(a));
  }

  // qualifying / practice
  return [...active].sort((a, b) => {
    const ta = a.telemetry!.bestLaptime;
    const tb = b.telemetry!.bestLaptime;
    if (ta === 0 && tb === 0) return 0;
    if (ta === 0) return 1;   // no time set → end of list
    if (tb === 0) return -1;
    return ta - tb;           // lower laptime = better
  });
}

// ── Driver broadcasts ─────────────────────────────────────────────────────────

export function buildDriverBroadcasts(
  drivers: DriverState[],
  mode: SessionMode,
): Record<number, DriverBroadcast> {
  const track       = getTrack();
  const sectorCount = track?.sectorCount ?? 3;
  const sorted      = sortActive(drivers, mode);

  // Build rank map (1-indexed, 0 = not active)
  const rankMap = new Map<number, number>();
  sorted.forEach((d, i) => rankMap.set(d.id, i + 1));

  // ── Gap factories ──────────────────────────────────────────────────────────
  //
  // race mode    : gap in seconds = (score delta) × arcLength / leaderSpeed
  // qual/practice: gap in seconds = bestLaptime delta (ms → s)

  const leader      = sorted[0];
  const leaderScore = leader ? raceScore(leader) : 0;
  const leaderSpeed = Math.max(leader?.telemetry?.speed ?? 10, 10);
  const arcLengthM  = track?.arcLengthM ?? 1;
  const leaderBest  = leader?.telemetry?.bestLaptime ?? 0;

  function raceGaps(d: DriverState, rank: number) {
    if (rank === 1) return { gapToLeader: 0, gapToAhead: 0 };
    const score       = raceScore(d);
    const gapToLeader = Math.max(0, (leaderScore - score) * arcLengthM / leaderSpeed);
    const ahead       = sorted[rank - 2];
    const aheadScore  = ahead ? raceScore(ahead) : leaderScore;
    const gapToAhead  = Math.max(0, (aheadScore - score) * arcLengthM / leaderSpeed);
    return { gapToLeader, gapToAhead };
  }

  function qualGaps(d: DriverState, rank: number) {
    if (rank === 1) return { gapToLeader: 0, gapToAhead: 0 };
    const dBest = d.telemetry!.bestLaptime;
    if (dBest === 0 || leaderBest === 0) return { gapToLeader: 0, gapToAhead: 0 };
    const gapToLeader = Math.max(0, (dBest - leaderBest) / 1000);
    const ahead       = sorted[rank - 2];
    const aheadBest   = ahead?.telemetry?.bestLaptime ?? leaderBest;
    const gapToAhead  = aheadBest === 0 ? 0 : Math.max(0, (dBest - aheadBest) / 1000);
    return { gapToLeader, gapToAhead };
  }

  const getGaps = mode === 'race' ? raceGaps : qualGaps;

  // ── Build per-driver result ────────────────────────────────────────────────

  const result: Record<number, DriverBroadcast> = {};

  for (const d of drivers) {
    const tel = d.telemetry;
    let derived: Derived;

    if (!tel || !d.connected) {
      derived = nullDerived(sectorCount);
    } else {
      const rank = rankMap.get(d.id) ?? 0;
      const st   = sectorTracker.getState(d.id);

      const { gapToLeader, gapToAhead } = rank > 0
        ? getGaps(d, rank)
        : { gapToLeader: 0, gapToAhead: 0 };

      const sectors: number[]            = [];
      const sectorStatus: SectorStatus[] = [];
      for (let s = 0; s < sectorCount; s++) {
        sectors.push(st?.lastLapSectors[s] ?? 0);
        sectorStatus.push(sectorTracker.getSectorStatus(d.id, s));
      }

      derived = {
        rank,
        gapToLeader,
        gapToAhead,
        sectors,
        sectorStatus,
        bestLapSectors: sectorTracker.getBestLapSectors(d.id, mode),
        currentSector: st?.currentSector ?? 0,
        arcFraction: st?.arcFraction ?? 0,
        pitted: tel.speed < 3, // ~10 km/h threshold
      };
    }

    result[d.id] = {
      id:        d.id,
      connected: d.connected,
      lastSeen:  d.lastSeen,
      telemetry: tel,
      derived,
    };
  }

  return result;
}

// ── Race state ────────────────────────────────────────────────────────────────

export function buildRaceState(drivers: DriverState[], mode: SessionMode): RaceState {
  const track  = getTrack();
  const sorted = sortActive(drivers, mode);
  const leader = sorted[0];

  const base = {
    mode,
    trackId:     track?.id ?? null,
    sectorCount: track?.sectorCount ?? 0,
  };

  if (!leader?.telemetry) {
    return { ...base, lap: 0, totalLaps: 0, dayProgression: 0, order: [] };
  }

  return {
    ...base,
    lap:            leader.telemetry.lapCount,
    totalLaps:      leader.telemetry.totalLaps,
    dayProgression: leader.telemetry.dayProgression,
    order:          sorted.map((d) => d.id),
  };
}
