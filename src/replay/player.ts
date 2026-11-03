import { broadcast } from "../broadcaster";
import type { DriverState } from "../drivers";
import * as drivers from "../drivers";
import { onRaceStart } from "../handlers/shared";
import { ingestPacket } from "../ingest";
import * as sectorTracker from "../sector-tracker";
import * as session from "../session";
import type { DriverPacket, RosterEntry, Session } from "../types";
import * as packetRecorder from "./recorder";
import { loadRun } from "./storage";
import { RACE_LAPS, type RunRecording } from "./types";

// Replays recorded time-trial runs as a race: one roster driver per run, all
// fed through ingestPacket() exactly like live WebSocket packets.
//
// Time-trial packets carry no race context, so each one is rewritten:
// lapCount 0 before the line then 1…RACE_LAPS (RACE_LAPS+1 once finished),
// totalLaps = RACE_LAPS, lap times recomputed from the run itself, and
// RaceStartPosition / preRaceNumCars set from the replay's live order.

export const DEFAULT_STAGGER_MS = 300;
const TICK_MS = 8;

interface ReplayDriver {
  label: string;
  state: DriverState;
  packets: DriverPacket[];
  times: number[]; // ms on the replay timeline, ascending
  lapTimesMs: number[];
  crossAtMs: number; // replay-timeline time this driver crosses the line
  emitted: number; // index of the last packet sent, -1 before the first
}

interface Replay {
  sessionId: string;
  trackId: string;
  staggerMs: number;
  startedAt: number; // performance.now()
  finishedAt: number | null;
  timer: NodeJS.Timeout | null;
  drivers: ReplayDriver[];
}

let current: Replay | null = null;

export function isRunning(): boolean {
  return current?.timer != null;
}

export function start(trackId: string, labels: string[], staggerMs: number): Session {
  // Load and validate everything before touching live state.
  const runs = labels.map((label) => {
    const run = loadRun(trackId, label);
    if (run.lapTimesMs.length < RACE_LAPS) {
      throw new Error(
        `recording "${label}" has ${run.lapTimesMs.length} laps, needs ${RACE_LAPS}`,
      );
    }
    return run;
  });
  onRaceStart(trackId); // loads the track + fresh gap engine; throws if missing

  stop();
  packetRecorder.cancelAll();
  drivers.clearDrivers();
  sectorTracker.clearAll();

  const roster: RosterEntry[] = labels.map((label, i) => ({
    id: i + 1,
    name: label,
    country: "",
    psnId: "",
  }));
  const s = session.createSession(roster, "race", trackId);
  broadcast({ type: "roster", session: s, roster });

  // Shift everyone so the earliest pre-roll packet lands at t = 0.
  const lead = Math.max(...runs.map((r) => -r.packets[0].t), 0);

  const replayDrivers = runs.map((run, i) => {
    const state = drivers.resolveToken(drivers.registerDriver(i + 1))!;
    drivers.connectDriverMock(state);
    return buildDriver(run, state, lead + i * staggerMs);
  });

  current = {
    sessionId: s.id,
    trackId,
    staggerMs,
    startedAt: performance.now(),
    finishedAt: null,
    timer: setInterval(tick, TICK_MS),
    drivers: replayDrivers,
  };
  console.log(
    `[replay] started on "${trackId}": ${labels.join(", ")} (${staggerMs} ms stagger)`,
  );
  return s;
}

export function stop(): boolean {
  if (!current) return false;
  const wasRunning = current.timer !== null;
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
  for (const d of current.drivers) drivers.disconnectDriver(d.state);
  current = null;
  if (wasRunning) console.log("[replay] stopped");
  return wasRunning;
}

export function status() {
  if (!current) return { state: "idle" as const };
  const now = current.finishedAt ?? performance.now();
  return {
    state: current.timer ? ("running" as const) : ("finished" as const),
    trackId: current.trackId,
    staggerMs: current.staggerMs,
    elapsedMs: Math.round(now - current.startedAt),
    drivers: current.drivers.map((d) => {
      const p = d.emitted >= 0 ? d.packets[d.emitted] : null;
      return {
        id: d.state.id,
        label: d.label,
        lap: p?.lapCount ?? 0,
        position: p?.RaceStartPosition ?? null,
        finished: d.emitted === d.packets.length - 1,
        lapTimesMs: d.lapTimesMs,
      };
    }),
  };
}

export function buildDriver(run: RunRecording, state: DriverState, crossAtMs: number): ReplayDriver {
  // The start is the first lapCount increment, not the first t >= 0 — a pre-roll
  // packet can arrive in the same millisecond as the crossing and share t = 0.
  const crossIdx = run.packets.findIndex(
    (rp, i) => i > 0 && rp.p.lapCount > run.packets[i - 1].p.lapCount,
  );
  const startLap = run.packets[crossIdx].p.lapCount;
  const lapTimes = run.lapTimesMs.slice(0, RACE_LAPS);
  const packets: DriverPacket[] = [];
  const times: number[] = [];

  for (const [i, { t, p }] of run.packets.entries()) {
    const lap = i < crossIdx ? 0 : Math.min(p.lapCount - startLap + 1, RACE_LAPS + 1);
    const done = lapTimes.slice(0, Math.max(0, lap - 1));
    packets.push({
      ...p,
      packetId: packets.length,
      lapCount: lap,
      totalLaps: RACE_LAPS,
      currentLap: lap === 0 ? 0 : p.currentLap,
      lastLaptime: done.length > 0 ? done[done.length - 1] : -1,
      bestLaptime: done.length > 0 ? Math.min(...done) : -1,
    });
    times.push(t + crossAtMs);
    if (lap > RACE_LAPS) break; // finish line packet — nothing after it
  }

  return {
    label: run.label,
    state,
    packets,
    times,
    lapTimesMs: lapTimes,
    crossAtMs,
    emitted: -1,
  };
}

// Higher = further ahead. Finished drivers rank by finish time.
function progress(d: ReplayDriver, elapsed: number): number {
  if (d.emitted < 0) return -Infinity;
  const p = d.packets[d.emitted];
  if (p.lapCount > RACE_LAPS) return RACE_LAPS + 1 - d.times[d.emitted] / 1e9;
  if (p.lapCount === 0) return -(d.crossAtMs - elapsed) / 1e9;
  const lapMs = d.lapTimesMs[p.lapCount - 1] || 1;
  return p.lapCount - 1 + Math.min((p.currentLap ?? 0) / lapMs, 0.999);
}

function tick(): void {
  const r = current;
  if (!r) return;

  // Someone replaced or ended the session — this replay's drivers are gone.
  if (session.getSession()?.id !== r.sessionId) {
    stop();
    return;
  }

  const elapsed = performance.now() - r.startedAt;

  // Advance each driver to the latest due packet. Only that one is sent, so the
  // gap engine never sees two packets with the same timestamp.
  const due: ReplayDriver[] = [];
  for (const d of r.drivers) {
    let i = d.emitted;
    while (i + 1 < d.times.length && d.times[i + 1] <= elapsed) i++;
    if (i > d.emitted) {
      d.emitted = i;
      due.push(d);
    }
  }

  if (due.length > 0) {
    const order = [...r.drivers].sort((a, b) => progress(b, elapsed) - progress(a, elapsed));
    for (const d of due) {
      const p = d.packets[d.emitted];
      p.RaceStartPosition = order.indexOf(d) + 1;
      p.preRaceNumCars = r.drivers.length;
      ingestPacket(d.state, p, { record: false });
    }
  }

  if (r.drivers.every((d) => d.emitted === d.packets.length - 1)) {
    clearInterval(r.timer!);
    r.timer = null;
    r.finishedAt = performance.now();
    console.log("[replay] all drivers finished");
  }
}
