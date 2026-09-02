// src/gap/projection.ts

import { TrackJson, TrackRuler } from "../track-ruler";
import { Vec3, clamp, dot } from "./vec3";

export interface Projection {
  distanceAlongLap: number; // [0, trackLength)
  segmentIndex: number; // feed back as the next hintIndex
  perpDistance: number; // 3D distance from car to centerline
  lateralOffset: number; // signed horizontal offset, negative = left
  trustworthy: boolean; // safe to record in the history buffer
  usedFullScan: boolean; // diagnostic — see verify section
}

const TRUST_MARGIN_M = 15;

/** Project onto one segment. Returns squared perpendicular distance (no sqrt). */
function projectOntoSegment(
  ruler: TrackRuler,
  segmentIndex: number,
  carPosition: Vec3,
): { fractionAlongSegment: number; perpDistanceSquared: number } {
  const segmentStart = ruler.point(segmentIndex);
  const segmentEnd = ruler.point((segmentIndex + 1) % ruler.segmentCount);

  const segmentVector: Vec3 = [
    segmentEnd[0] - segmentStart[0],
    segmentEnd[1] - segmentStart[1],
    segmentEnd[2] - segmentStart[2],
  ];
  const startToCar: Vec3 = [
    carPosition[0] - segmentStart[0],
    carPosition[1] - segmentStart[1],
    carPosition[2] - segmentStart[2],
  ];

  const lengthSquared = dot(segmentVector, segmentVector);

  let fractionAlongSegment = 0;
  if (lengthSquared > 1e-9) {
    fractionAlongSegment = dot(startToCar, segmentVector) / lengthSquared;
    // REQUIRED. The raw value answers "where on the INFINITE line", which can
    // land past either endpoint and place the car segments away from its true
    // position — while still reporting a small perpendicular distance.
    fractionAlongSegment = clamp(fractionAlongSegment, 0, 1);
  }

  const ex = startToCar[0] - segmentVector[0] * fractionAlongSegment;
  const ey = startToCar[1] - segmentVector[1] * fractionAlongSegment;
  const ez = startToCar[2] - segmentVector[2] * fractionAlongSegment;

  return {
    fractionAlongSegment,
    perpDistanceSquared: ex * ex + ey * ey + ez * ez,
  };
}

export function projectToTrack(
  ruler: TrackRuler,
  carPosition: Vec3,
  hintIndex: number,
): Projection {
  const n = ruler.segmentCount;

  let bestIndex = -1;
  let bestFraction = 0;
  let bestPerpSquared = Infinity;

  const consider = (i: number) => {
    const r = projectOntoSegment(ruler, i, carPosition);
    if (r.perpDistanceSquared < bestPerpSquared) {
      bestPerpSquared = r.perpDistanceSquared;
      bestFraction = r.fractionAlongSegment;
      bestIndex = i;
    }
  };

  // --- local search around the previous match -----------------------------
  if (hintIndex >= 0) {
    const w = ruler.searchWindow;
    for (let k = -w; k <= w; k++) {
      // Modulo wrap is REQUIRED. Without it a car loses the track at the
      // start/finish line once every lap.
      consider((((hintIndex + k) % n) + n) % n);
    }
  }

  // --- full scan fallback --------------------------------------------------
  let usedFullScan = false;
  const threshold = ruler.fallbackThreshold;
  if (hintIndex < 0 || bestPerpSquared > threshold * threshold) {
    usedFullScan = true;
    for (let i = 0; i < n; i++) consider(i);
  }

  // --- distance along lap --------------------------------------------------
  let distanceAlongLap =
    ruler.cumulativeDistance[bestIndex] +
    bestFraction * ruler.segmentLength(bestIndex);
  if (distanceAlongLap >= ruler.trackLength)
    distanceAlongLap -= ruler.trackLength;

  // --- lateral offset (horizontal plane only) ------------------------------
  const segmentStart = ruler.point(bestIndex);
  const segmentEnd = ruler.point((bestIndex + 1) % n);
  const closestX =
    segmentStart[0] + (segmentEnd[0] - segmentStart[0]) * bestFraction;
  const closestZ =
    segmentStart[2] + (segmentEnd[2] - segmentStart[2]) * bestFraction;

  const offsetX = carPosition[0] - closestX;
  const offsetZ = carPosition[2] - closestZ;
  const tangentX = segmentEnd[0] - segmentStart[0];
  const tangentZ = segmentEnd[2] - segmentStart[2];

  const cross = tangentX * offsetZ - tangentZ * offsetX;
  const side = cross === 0 ? 1 : Math.sign(cross);
  const lateralOffset =
    ruler.lateralSign * side * Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);

  const perpDistance = Math.sqrt(bestPerpSquared);

  return {
    distanceAlongLap,
    segmentIndex: bestIndex,
    perpDistance,
    lateralOffset,
    trustworthy: perpDistance <= ruler.halfWidth[bestIndex] + TRUST_MARGIN_M,
    usedFullScan,
  };
}

/**
 * Call once per track, after constructing the ruler. Works out which sign
 * convention this game uses so that negative lateralOffset always means left.
 */
export function calibrateLateralSign(ruler: TrackRuler, track: TrackJson) {
  if (!track.leftLine?.length) return;
  ruler.lateralSign = 1;
  const probe = projectToTrack(ruler, track.leftLine[0] as Vec3, -1);
  if (probe.lateralOffset > 0) ruler.lateralSign = -1;
  console.log(
    `[track ${ruler.trackId}] lateralSign calibrated to ${ruler.lateralSign}`,
  );
}
