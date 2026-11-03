import type { DriverPacket } from "../types";

/** Laps per recorded run, and the race length a replay simulates. */
export const RACE_LAPS = 5;

/** How much driving before the start line is kept, so replays roll up to it. */
export const PRE_ROLL_MS = 2000;

export interface RecordedPacket {
  t: number; // ms relative to the start-line crossing (pre-roll is negative), pauses removed
  p: DriverPacket; // raw packet exactly as the client sent it
}

export interface RunMeta {
  version: 1;
  trackId: string;
  label: string;
  laps: number;
  driverId: number;
  recordedAt: string;
  durationMs: number; // line crossing → finish, pauses removed
  lapTimesMs: number[];
  packetCount: number;
}

// `packets` must stay the last key — storage reads the header without parsing it.
export interface RunRecording extends RunMeta {
  packets: RecordedPacket[];
}

export interface ArmedStatus {
  driverId: number;
  label: string;
  trackId: string;
  phase: "waiting" | "recording";
  lap: number; // 0 while waiting, then 1…RACE_LAPS
  elapsedMs: number; // recorded time so far, pauses removed
}
