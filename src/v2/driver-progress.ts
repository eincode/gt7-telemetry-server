// src/gap/driver-progress.ts

import { SessionMode } from "../types";
import { HistoryBuffer } from "./history-buffer";
import { TrackRuler } from "./track-ruler";
import { Projection, projectToTrack } from "./utils/projection";
import { Vec3 } from "./utils/vec3";

export interface GapPacket {
  position: [number, number, number];
  speed: number; // m/s
  lapCount: number;
  currentLap: number;
  totalLaps: number;
}

export class DriverProgress {
  readonly driverId: string;

  armed = false;
  totalDistance = 0;
  lastTimestamp = -1;
  lastSpeed = 0;
  lastProjection: Projection | null = null;
  readonly history: HistoryBuffer;

  private hintIndex = -1;
  private lastDistanceAlongLap = 0;
  private lastLapCount = -1;

  // Diagnostics
  resetCount = 0;
  wrapCount = 0;
  untrustworthyCount = 0;

  finished = false;
  finishTime: number | null = null;
  finishOrder: number | null = null;

  armedAtLapCount: number | null = null;
  crossedLineAt: number | null = null;

  constructor(
    driverId: string,
    private readonly ruler: TrackRuler,
  ) {
    this.driverId = driverId;
    this.history = new HistoryBuffer(ruler.trackLength);
  }

  update(packet: GapPacket, timestamp: number, mode: SessionMode): void {
    if (this.finished) return; // freeze — ignore the cooldown lap entirely
    const projection = projectToTrack(
      this.ruler,
      packet.position as Vec3,
      this.hintIndex,
    );
    this.hintIndex = projection.segmentIndex;
    this.lastProjection = projection;

    const L = this.ruler.trackLength;

    // --- arming ------------------------------------------------------------
    // Start recording only once the driver crosses the line. Every buffer then
    // begins at the same place, so lookups work from the first metre.
    // Trigger on ANY increment, not 0→1, so a mid-race rejoin still arms.
    if (!this.armed) {
      if (this.lastLapCount >= 0 && packet.lapCount > this.lastLapCount) {
        this.armed = true;
        this.totalDistance = 0;
        this.history.clear();
        console.log(`[${this.driverId}] armed at lap ${packet.lapCount}`);
      }
      this.lastLapCount = packet.lapCount;
      this.lastDistanceAlongLap = projection.distanceAlongLap;
      this.lastTimestamp = timestamp;
      this.lastSpeed = packet.speed;
      return;
    }
    this.lastLapCount = packet.lapCount;

    // --- accumulate --------------------------------------------------------
    let change = projection.distanceAlongLap - this.lastDistanceAlongLap;

    if (change < -L / 2) {
      change += L; // crossed the line forwards
      this.wrapCount++;
    } else if (change > L / 2) {
      change -= L; // crossed backwards
      this.wrapCount++;
    }

    const dt = timestamp - this.lastTimestamp;
    const maxPossible = Math.max(packet.speed, 10) * dt * 1.5 + 15;

    if (Math.abs(change) > maxPossible) {
      // Teleport, reset, or a projection that landed somewhere impossible.
      // Rebuild from the packet and drop the history — interpolating across a
      // discontinuity produces nonsense.
      this.totalDistance =
        Math.max(0, packet.lapCount - 1) * L + projection.distanceAlongLap;
      this.history.clear();
      this.resetCount++;
      console.warn(
        `[${this.driverId}] reset detected: change ${change.toFixed(1)} m ` +
          `exceeds ${maxPossible.toFixed(1)} m in ${(dt * 1000).toFixed(0)} ms`,
      );
    } else {
      this.totalDistance += change;
    }

    this.lastDistanceAlongLap = projection.distanceAlongLap;
    this.lastTimestamp = timestamp;
    this.lastSpeed = packet.speed;

    // --- record ------------------------------------------------------------
    // Only trustworthy projections. A car in the gravel projects onto some
    // arbitrary bit of centerline; recording that poisons the car behind.
    if (projection.trustworthy) {
      this.history.append(timestamp, this.totalDistance);
    } else {
      this.untrustworthyCount++;
    }

    const currentLap = packet.currentLap ?? packet.lapCount;
    if (
      mode === "race" &&
      packet.totalLaps > 0 &&
      currentLap > packet.totalLaps
    ) {
      this.finished = true;

      // Snap to the exact line crossing. Round, not floor — we detect one packet
      // after the fact, and a lapped car finishes on a lower lap count.
      const lapsCompleted = Math.round(this.totalDistance / L);
      const finishDistance = lapsCompleted * L;

      // Interpolate the real crossing time out of the buffer rather than using
      // this packet's timestamp, which is up to 16 ms late.
      this.finishTime = this.history.timeAt(finishDistance) ?? timestamp;
      this.totalDistance = finishDistance;

      console.log(`[${this.driverId}] finished, lap ${lapsCompleted}`);
    }
  }
}
