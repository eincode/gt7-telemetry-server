import type { DriverPacket } from "../types";
import { saveRun } from "./storage";
import {
  PRE_ROLL_MS,
  RACE_LAPS,
  type ArmedStatus,
  type RecordedPacket,
} from "./types";

// Records a driver's raw packets for exactly RACE_LAPS laps.
//
// Arm → wait for the first start-line crossing (drops the out-lap) → record →
// auto-save once lap RACE_LAPS is complete. A paused game keeps sending frozen
// packets; those are skipped and their duration removed from the timeline.

interface ArmedRun {
  driverId: number;
  label: string;
  trackId: string;
  phase: "waiting" | "recording";
  lastLapCount: number | null;
  prev: DriverPacket | null;
  lastWallMs: number;
  // waiting
  preRoll: { wallMs: number; p: DriverPacket }[];
  // recording
  startLapCount: number;
  startWallMs: number;
  pausedMs: number;
  packets: RecordedPacket[];
}

const armed = new Map<number, ArmedRun>();

export function arm(driverId: number, label: string, trackId: string): ArmedStatus {
  const run: ArmedRun = {
    driverId,
    label,
    trackId,
    phase: "waiting",
    lastLapCount: null,
    prev: null,
    lastWallMs: Date.now(),
    preRoll: [],
    startLapCount: 0,
    startWallMs: 0,
    pausedMs: 0,
    packets: [],
  };
  armed.set(driverId, run);
  console.log(`[rec] armed driver=${driverId} label="${label}" track="${trackId}" — waiting for line crossing`);
  return toStatus(run);
}

export function cancel(driverId: number): boolean {
  const had = armed.delete(driverId);
  if (had) console.log(`[rec] cancelled driver=${driverId}`);
  return had;
}

export function cancelAll(): number {
  const n = armed.size;
  armed.clear();
  return n;
}

export function status(): ArmedStatus[] {
  return Array.from(armed.values()).map(toStatus);
}

function toStatus(run: ArmedRun): ArmedStatus {
  const recording = run.phase === "recording";
  const last = run.packets[run.packets.length - 1];
  return {
    driverId: run.driverId,
    label: run.label,
    trackId: run.trackId,
    phase: run.phase,
    lap: recording && last ? last.p.lapCount - run.startLapCount + 1 : 0,
    elapsedMs: recording && last ? Math.round(last.t) : 0,
  };
}

function isFrozen(a: DriverPacket, b: DriverPacket): boolean {
  return (
    a.lapCount === b.lapCount &&
    a.currentLap === b.currentLap &&
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2]
  );
}

export function onPacket(driverId: number, packet: DriverPacket): void {
  const run = armed.get(driverId);
  if (!run) return;

  const now = Date.now();
  const frozen = run.prev !== null && isFrozen(run.prev, packet);
  if (frozen && run.phase === "recording") run.pausedMs += now - run.lastWallMs;
  run.lastWallMs = now;
  if (frozen) return;
  run.prev = packet;

  if (run.phase === "waiting") {
    const crossed = run.lastLapCount !== null && packet.lapCount > run.lastLapCount;
    run.lastLapCount = packet.lapCount;

    if (!crossed) {
      run.preRoll.push({ wallMs: now, p: packet });
      while (run.preRoll.length > 0 && now - run.preRoll[0].wallMs > PRE_ROLL_MS) {
        run.preRoll.shift();
      }
      return;
    }

    run.phase = "recording";
    run.startLapCount = packet.lapCount;
    run.startWallMs = now;
    // Keep pre-roll strictly negative even when it arrived in the same ms as the crossing.
    run.packets = run.preRoll.map(({ wallMs, p }) => ({ t: Math.min(wallMs - now, -1), p }));
    run.packets.push({ t: 0, p: packet });
    run.preRoll = [];
    console.log(`[rec] driver=${driverId} "${run.label}" crossed the line — recording ${RACE_LAPS} laps`);
    return;
  }

  // A restarted time trial drops lapCount — throw the attempt away and wait again.
  if (packet.lapCount < run.startLapCount) {
    console.log(`[rec] driver=${driverId} "${run.label}" lap count went backwards — run restarted, waiting for line`);
    arm(driverId, run.label, run.trackId);
    return;
  }

  const t = now - run.startWallMs - run.pausedMs;
  run.packets.push({ t, p: packet });

  const lapsDone = packet.lapCount - run.startLapCount;
  if (lapsDone > run.lastLapCount! - run.startLapCount) {
    console.log(`[rec] driver=${driverId} "${run.label}" lap ${lapsDone} done (${packet.lastLaptime} ms)`);
  }
  run.lastLapCount = packet.lapCount;

  if (lapsDone >= RACE_LAPS) finish(run);
}

function finish(run: ArmedRun): void {
  armed.delete(run.driverId);

  // Lap times from GT7's own lastLaptime at each crossing; fall back to the
  // recorded timeline if the game reported no time for a lap.
  const lapTimesMs: number[] = [];
  let lapStartT = 0;
  for (let i = 1; i < run.packets.length; i++) {
    const { t, p } = run.packets[i];
    if (t <= 0 || p.lapCount <= run.packets[i - 1].p.lapCount) continue;
    lapTimesMs.push(p.lastLaptime > 0 ? p.lastLaptime : Math.round(t - lapStartT));
    lapStartT = t;
  }

  const durationMs = Math.round(run.packets[run.packets.length - 1].t);
  try {
    const file = saveRun({
      version: 1,
      trackId: run.trackId,
      label: run.label,
      laps: RACE_LAPS,
      driverId: run.driverId,
      recordedAt: new Date().toISOString(),
      durationMs,
      lapTimesMs,
      packetCount: run.packets.length,
      packets: run.packets,
    });
    console.log(
      `[rec] saved "${run.label}" → ${file} (${run.packets.length} packets, laps ${lapTimesMs.join(" / ")} ms)`,
    );
  } catch (err) {
    console.error(`[rec] failed to save "${run.label}":`, (err as Error).message);
  }
}
