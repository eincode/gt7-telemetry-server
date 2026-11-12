// src/gap/gap-engine.ts

import { SessionMode } from "../types";
import { DriverProgress, GapPacket } from "./driver-progress";
import { TrackRuler } from "./track-ruler";

export interface StandingsRow {
  driverId: string;
  position: number;
  gapText: string;
  gapSeconds: number | null;
  gapMetres: number | null;
  totalTime: number | null;
  finished: boolean;
  /** Whole laps behind the leader, by distance. 0 for the leader and anyone on the lead lap. */
  lapsDown: number;
}

export class GapEngine {
  private readonly drivers = new Map<string, DriverProgress>();
  private finishCounter = 0;
  private raceStartTime: number | null = null;

  constructor(private readonly ruler: TrackRuler) {}

  /** Call on every packet, ~20 Hz per driver. */
  onPacket(
    driverId: string,
    packet: GapPacket,
    timestamp: number,
    mode: SessionMode,
  ): void {
    let progress = this.drivers.get(driverId);
    if (!progress) {
      progress = new DriverProgress(driverId, this.ruler);
      this.drivers.set(driverId, progress);
    }
    const wasArmed = progress.armed;
    const wasFinished = progress.finished;

    progress.update(packet, timestamp, mode, this.finishCounter > 0);

    if (
      !wasArmed &&
      progress.armed &&
      progress.armedAtLapCount === 1 &&
      this.raceStartTime === null
    ) {
      this.raceStartTime = progress.crossedLineAt;
      console.log(`[race] clock started by ${driverId}`);
    }

    if (!wasFinished && progress.finished) {
      progress.finishOrder = ++this.finishCounter;
    }
  }

  totalTimeFor(progress: DriverProgress): number | null {
    if (this.raceStartTime === null || !progress.armed) return null;
    const end = progress.finishTime ?? progress.lastTimestamp;
    return end - this.raceStartTime;
  }

  /** Whole laps between the leader and this driver. Finished drivers have their
   *  distance snapped to a lap multiple, so the epsilon only absorbs float error. */
  lapsDownFor(leader: DriverProgress, behind: DriverProgress): number {
    if (!leader.armed || !behind.armed) return 0;
    const L = this.ruler.trackLength;
    const laps = Math.floor((leader.totalDistance - behind.totalDistance) / L + 1e-6);
    return Math.max(0, laps);
  }

  /** Call on the standings refresh, 5–10 Hz. NOT at 60 Hz. */
  standings(reportedPositions: Map<string, number>): StandingsRow[] {
    const ordered = [...this.drivers.values()]
      // .filter((d) => d.armed)
      .sort((a, b) => {
        // The game reports each driver's position from their own packet, and
        // those arrive at different moments — during an overtake two drivers
        // can briefly both claim the same slot. Tiebreak on distance.
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.finished && b.finished) return a.finishOrder! - b.finishOrder!;
        const pa = reportedPositions.get(a.driverId) ?? 999;
        const pb = reportedPositions.get(b.driverId) ?? 999;
        if (pa !== pb) return pa - pb;
        return b.totalDistance - a.totalDistance;
      });

    const L = this.ruler.trackLength;
    const rows: StandingsRow[] = [];

    for (let i = 0; i < ordered.length; i++) {
      const behind = ordered[i];
      const position = i + 1;

      if (i === 0) {
        rows.push({
          driverId: behind.driverId,
          position,
          gapText: "Leader",
          gapSeconds: null,
          gapMetres: null,
          totalTime: this.totalTimeFor(behind),
          finished: behind.finished,
          lapsDown: 0,
        });
        continue;
      }

      const ahead = ordered[i - 1];
      const gapMetres = ahead.totalDistance - behind.totalDistance;

      let gapText: string;
      let gapSeconds: number | null = null;

      const laps = Math.round(gapMetres / L);

      if (laps >= 1 && gapMetres >= L * 0.9) {
        gapText = `+${laps} Lap${laps > 1 ? "s" : ""}`;
      } else if (behind.finished && ahead.finished) {
        gapSeconds = behind.finishTime! - ahead.finishTime!;
        gapText = `+${gapSeconds.toFixed(3)}`;
      } else {
        const wasThereAt = ahead.history.timeAt(behind.totalDistance);
        if (wasThereAt === null) {
          gapText = "--";
        } else {
          const seconds = behind.lastTimestamp - wasThereAt;
          if (seconds < 0) {
            // Reported order and our distances disagree — happens momentarily
            // during a pass.
            gapText = "--";
          } else {
            gapSeconds = seconds;
            gapText = `+${seconds.toFixed(3)}`;
          }
        }
      }

      rows.push({
        driverId: behind.driverId,
        position,
        gapText,
        gapSeconds,
        gapMetres,
        totalTime: this.totalTimeFor(behind),
        finished: behind.finished,
        lapsDown: this.lapsDownFor(ordered[0], behind),
      });
    }

    return rows;
  }
}
