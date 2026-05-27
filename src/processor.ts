import type { DriverState } from './drivers';
import * as sectorTracker from './sector-tracker';
import { getTrack } from './track';
import type { Derived, DriverBroadcast, RaceState, SectorStatus } from './types';

function nullDerived(sectorCount: number): Derived {
  return {
    rank: 0,
    gapToLeader: 0,
    gapToAhead: 0,
    sectors: Array<number>(sectorCount).fill(0),
    sectorStatus: Array<SectorStatus>(sectorCount).fill('neutral'),
    arcFraction: 0,
    pitted: false,
  };
}

// rank score = lapCount + arcFraction; higher = further ahead
function rankScore(d: DriverState): number {
  if (!d.telemetry) return -1;
  return d.telemetry.lapCount + (sectorTracker.getState(d.id)?.arcFraction ?? 0);
}

export function buildDriverBroadcasts(
  drivers: DriverState[],
): Record<number, DriverBroadcast> {
  const track = getTrack();
  const sectorCount = track?.sectorCount ?? 3;

  // Rank only connected drivers with telemetry
  const active = drivers
    .filter((d) => d.connected && d.telemetry !== null)
    .sort((a, b) => rankScore(b) - rankScore(a)); // descending: rank 1 first

  const rankMap = new Map<number, number>();
  active.forEach((d, i) => rankMap.set(d.id, i + 1));

  const leader = active[0];
  const leaderScore = leader ? rankScore(leader) : 0;
  // Use leader's speed but floor at 10 m/s to avoid divide-by-zero when pitting
  const leaderSpeed = Math.max(leader?.telemetry?.speed ?? 10, 10);
  const arcLengthM  = track?.arcLengthM ?? 1;

  const result: Record<number, DriverBroadcast> = {};

  for (const d of drivers) {
    const tel = d.telemetry;
    let derived: Derived;

    if (!tel || !track || !d.connected) {
      derived = nullDerived(sectorCount);
    } else {
      const rank   = rankMap.get(d.id) ?? 0;
      const score  = rankScore(d);
      const st     = sectorTracker.getState(d.id);

      // Gap in seconds = (score difference in lap fractions) × track length ÷ leader speed
      const gapToLeader = rank === 1 ? 0 : Math.max(0, (leaderScore - score) * arcLengthM / leaderSpeed);

      const driverAhead     = active[rank - 2]; // rank-2 because active is 0-indexed
      const aheadScore      = driverAhead ? rankScore(driverAhead) : leaderScore;
      const gapToAhead      = rank === 1 ? 0 : Math.max(0, (aheadScore - score) * arcLengthM / leaderSpeed);

      const sectors: number[]       = [];
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

export function buildRaceState(drivers: DriverState[]): RaceState {
  const track  = getTrack();
  const active = drivers
    .filter((d) => d.connected && d.telemetry !== null)
    .sort((a, b) => rankScore(b) - rankScore(a));

  const leader = active[0];
  if (!leader?.telemetry) {
    return { trackId: track?.id ?? null, sectorCount: track?.sectorCount ?? 0, lap: 0, totalLaps: 0, dayProgression: 0, order: [] };
  }

  return {
    trackId:        track?.id ?? null,
    sectorCount:    track?.sectorCount ?? 0,
    lap:            leader.telemetry.lapCount,
    totalLaps:      leader.telemetry.totalLaps,
    dayProgression: leader.telemetry.dayProgression,
    order:          active.map((d) => d.id),
  };
}
