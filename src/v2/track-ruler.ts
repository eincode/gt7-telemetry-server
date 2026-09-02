// src/gap/track-ruler.ts

import { Vec3, clamp, distance3D } from "./utils/vec3";

/** Worst-case speed used to size the projection search window. */
const MAX_PLAUSIBLE_SPEED_MPS = 150;
const PACKET_HZ = 60;

export interface TrackJson {
  id: string;
  centerline: [number, number, number][];
  leftLine?: [number, number, number][];
  rightLine?: [number, number, number][];
  arcLengthM?: number;
}

export class TrackRuler {
  readonly trackId: string;
  readonly segmentCount: number;
  readonly trackLength: number;

  /** Flat [x,y,z,...], length 3 * segmentCount. */
  private readonly coords: Float64Array;
  /** Length segmentCount + 1. Last element === trackLength. */
  readonly cumulativeDistance: Float64Array;
  /** Length segmentCount. */
  readonly halfWidth: Float64Array;

  readonly minSpacing: number;
  readonly maxSpacing: number;
  readonly meanSpacing: number;
  readonly maxHalfWidth: number;

  /** Derived search parameters — never hardcode these. */
  readonly searchWindow: number;
  readonly fallbackThreshold: number;

  /** +1 or -1, calibrated so negative lateralOffset means left. */
  lateralSign: number = 1;

  constructor(track: TrackJson) {
    this.trackId = track.id;
    const raw = track.centerline;

    // --- drop the duplicated closing point -------------------------------
    // The export repeats point 0 at the end. Leaving it in creates a ~0.1 m
    // segment sitting exactly on the start/finish line, where dividing by its
    // squared length goes unstable — the worst possible place for it.
    let count = raw.length;
    const firstToLast = distance3D(raw[0] as Vec3, raw[count - 1] as Vec3);
    const firstSpacing = distance3D(raw[0] as Vec3, raw[1] as Vec3);
    const droppedClosingPoint = firstToLast < 0.5 * firstSpacing;
    if (droppedClosingPoint) count -= 1;
    this.segmentCount = count;

    this.coords = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.coords[i * 3] = raw[i][0];
      this.coords[i * 3 + 1] = raw[i][1];
      this.coords[i * 3 + 2] = raw[i][2];
    }

    // --- cumulative distance (the ruler) ---------------------------------
    this.cumulativeDistance = new Float64Array(count + 1);
    let minSpacing = Infinity;
    let maxSpacing = 0;
    for (let i = 0; i < count; i++) {
      const spacing = distance3D(this.point(i), this.point((i + 1) % count));
      this.cumulativeDistance[i + 1] = this.cumulativeDistance[i] + spacing;
      if (spacing < minSpacing) minSpacing = spacing;
      if (spacing > maxSpacing) maxSpacing = spacing;
    }
    this.trackLength = this.cumulativeDistance[count];
    this.minSpacing = minSpacing;
    this.maxSpacing = maxSpacing;
    this.meanSpacing = this.trackLength / count;

    // --- half-width from the edge lines -----------------------------------
    this.halfWidth = new Float64Array(count);
    let maxHalfWidth = 0;
    const left = track.leftLine;
    const right = track.rightLine;
    if (left?.length && right?.length) {
      for (let i = 0; i < count; i++) {
        const li = Math.min(
          left.length - 1,
          Math.round((i * (left.length - 1)) / count),
        );
        const ri = Math.min(
          right.length - 1,
          Math.round((i * (right.length - 1)) / count),
        );
        const w = distance3D(left[li] as Vec3, right[ri] as Vec3) / 2;
        this.halfWidth[i] = w;
        if (w > maxHalfWidth) maxHalfWidth = w;
      }
    } else {
      this.halfWidth.fill(7);
      maxHalfWidth = 7;
      console.warn(
        `[track ${this.trackId}] no edge lines; half-width defaulted to 7 m`,
      );
    }
    this.maxHalfWidth = maxHalfWidth;

    // --- derived search parameters ----------------------------------------
    const metresPerPacket = MAX_PLAUSIBLE_SPEED_MPS / PACKET_HZ;
    const rawWindow = Math.ceil(metresPerPacket / this.minSpacing) * 8;
    this.searchWindow = clamp(rawWindow, 8, Math.floor(count / 4));
    this.fallbackThreshold = this.maxHalfWidth * 2;

    this.validate(track, droppedClosingPoint);
  }

  point(i: number): Vec3 {
    const o = i * 3;
    return [this.coords[o], this.coords[o + 1], this.coords[o + 2]];
  }

  segmentLength(i: number): number {
    return this.cumulativeDistance[i + 1] - this.cumulativeDistance[i];
  }

  // -------------------------------------------------------------------------

  private validate(track: TrackJson, droppedClosingPoint: boolean) {
    const tag = `[track ${this.trackId}]`;

    console.log(
      `${tag} points ${track.centerline.length} → segments ${this.segmentCount}` +
        ` (closing point ${droppedClosingPoint ? "dropped" : "NOT dropped"})`,
    );
    console.log(
      `${tag} lapLength ${this.trackLength.toFixed(2)} m` +
        `  spacing min ${this.minSpacing.toFixed(2)} / mean ${this.meanSpacing.toFixed(2)}` +
        ` / max ${this.maxSpacing.toFixed(2)} m`,
    );
    console.log(
      `${tag} halfWidth max ${this.maxHalfWidth.toFixed(2)} m` +
        `  searchWindow ±${this.searchWindow}` +
        `  fallbackThreshold ${this.fallbackThreshold.toFixed(1)} m`,
    );

    if (!droppedClosingPoint) {
      console.warn(
        `${tag} closing point not detected — check the centerline export`,
      );
    }

    // Cross-check against the file's own figure. We use our own number; this is
    // purely a canary for a malformed export.
    if (track.arcLengthM) {
      const drift =
        Math.abs(this.trackLength - track.arcLengthM) / track.arcLengthM;
      if (drift > 0.01) {
        console.log(
          `${tag} arcLengthM ${track.arcLengthM.toFixed(2)} m differs from computed ` +
            `${this.trackLength.toFixed(2)} m by ${(drift * 100).toFixed(1)}% — ` +
            `using computed (field may describe a different line)`,
        );
      }
    }

    if (this.maxSpacing > 10 * this.meanSpacing) {
      console.error(
        `${tag} spacing outlier ${this.maxSpacing.toFixed(1)} m — points likely out of order`,
      );
    }

    if (this.minSpacing < 0.01) {
      console.error(`${tag} degenerate segment present (${this.minSpacing} m)`);
    }

    // The centerline should be the midpoint of the edge lines. If it isn't, the
    // arrays are misaligned and every distanceAlongLap on this track is wrong.
    if (
      track.leftLine?.length === track.centerline.length &&
      track.rightLine?.length
    ) {
      let worst = 0;
      for (let i = 0; i < this.segmentCount; i++) {
        for (let k = 0; k < 3; k++) {
          const mid = (track.leftLine[i][k] + track.rightLine[i][k]) / 2;
          worst = Math.max(worst, Math.abs(mid - track.centerline[i][k]));
        }
      }
      if (worst > 0.01) {
        console.warn(
          `${tag} centerline is not the left/right midpoint (worst ${worst.toFixed(3)} m) ` +
            `— edge arrays may be misaligned`,
        );
      } else {
        console.log(`${tag} centerline confirmed as left/right midpoint`);
      }
    }
  }
}
