import * as fs from 'fs';
import * as path from 'path';
import type { Vec3, PositionSample, RecordingFile, SectorBoundary, ComputedTrack } from './types';

const RESAMPLE_N = 500;

// ── Vec3 math ─────────────────────────────────────────────────────────────────

function dist3(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// ── Arc-length helpers ────────────────────────────────────────────────────────

function cumArcLengths(pts: Vec3[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + dist3(pts[i - 1], pts[i]));
  }
  return cum;
}

function interpolateAtTarget(pts: Vec3[], cum: number[], target: number): Vec3 {
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (target - cum[lo]) / span : 0;
  return lerpVec3(pts[lo], pts[hi], t);
}

// ── lapT lookup ───────────────────────────────────────────────────────────────
//
// Finds the interpolated 3D position in raw recording samples at a given lapT.
// Samples must be sorted by lapT ascending (they are, since they arrive in
// packet order and currentLap is monotonically increasing within a lap).

function lapTLookup(samples: PositionSample[], targetLapT: number): Vec3 {
  if (targetLapT <= samples[0].lapT) return [samples[0].x, samples[0].y, samples[0].z];

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1];
    if (a.lapT <= targetLapT && b.lapT >= targetLapT) {
      const span = b.lapT - a.lapT;
      const t    = span > 0 ? (targetLapT - a.lapT) / span : 0;
      return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t];
    }
  }

  const last = samples[samples.length - 1];
  return [last.x, last.y, last.z];
}

// ── Exported math ─────────────────────────────────────────────────────────────

export function resample(pts: Vec3[], n: number): Vec3[] {
  if (pts.length < 2) throw new Error('resample: need at least 2 points');
  const cum = cumArcLengths(pts);
  const total = cum[cum.length - 1];
  if (total === 0) throw new Error('resample: zero arc length — recording may be empty or stationary');

  const result: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    result.push(interpolateAtTarget(pts, cum, target));
  }
  return result;
}

export function positionAtFraction(line: Vec3[], fraction: number): Vec3 {
  if (line.length === 0) throw new Error('positionAtFraction: line is empty');
  const f = Math.max(0, Math.min(1, fraction));
  if (f === 1) return line[line.length - 1];
  const cum = cumArcLengths(line);
  const target = f * cum[cum.length - 1];
  return interpolateAtTarget(line, cum, target);
}

// Returns the unit forward direction of the track at index idx in a resampled line.
export function tangentAt(line: Vec3[], idx: number): Vec3 {
  const prev = line[Math.max(0, idx - 1)];
  const next = line[Math.min(line.length - 1, idx + 1)];
  return normalize3(sub3(next, prev));
}

// Returns the index of the point in `line` closest to P.
export function nearestIndex(line: Vec3[], P: Vec3): number {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = dist3(line[i], P);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// Finds the point on `line` that lies in the plane perpendicular to T through P
// (i.e. where dot(Q - P, T) = 0). `hintIdx` steers toward the right crossing
// when the line wraps around the track and crosses the plane twice.
export function perpIntersection(line: Vec3[], P: Vec3, T: Vec3, hintIdx: number): Vec3 {
  // Compute signed along-track distance for every point
  const dots = line.map((Q) => dot3(sub3(Q, P), T));

  // Collect all sign-change crossings with their interpolated point
  type Candidate = { point: Vec3; idxDist: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < line.length - 1; i++) {
    if (dots[i] * dots[i + 1] <= 0) {
      const span = dots[i] - dots[i + 1];
      const t = span !== 0 ? dots[i] / span : 0;
      candidates.push({
        point: lerpVec3(line[i], line[i + 1], t),
        idxDist: Math.min(Math.abs(i - hintIdx), Math.abs(i + 1 - hintIdx)),
      });
    }
  }

  if (candidates.length > 0) {
    // Pick the crossing closest to the hint index (same section of track)
    candidates.sort((a, b) => a.idxDist - b.idxDist);
    return candidates[0].point;
  }

  // Fallback: return the point with the smallest |dot| (closest to the plane)
  let best = line[0], bestAbs = Math.abs(dots[0]);
  for (let i = 1; i < line.length; i++) {
    if (Math.abs(dots[i]) < bestAbs) { bestAbs = Math.abs(dots[i]); best = line[i]; }
  }
  return best;
}

// Builds a full SectorBoundary from a center point on the ideal line.
// All geometry is computed from the resampled lines — no lap time involved.
export function buildBoundary(
  P: Vec3,
  arcFraction: number,
  idealLine: Vec3[],
  leftLine: Vec3[],
  rightLine: Vec3[],
): SectorBoundary {
  const idx       = nearestIndex(idealLine, P);
  const T         = tangentAt(idealLine, idx);   // track-forward, already normalised
  const leftEdge  = perpIntersection(leftLine,  P, T, idx);
  const rightEdge = perpIntersection(rightLine, P, T, idx);
  return { arcFraction, position: P, normal: T, leftEdge, rightEdge };
}

// ── computeTrack ──────────────────────────────────────────────────────────────

function loadRecording(outputDir: string, filename: string, label: string): RecordingFile {
  const p = path.join(outputDir, filename);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Missing recording: ${filename}\n  Run: yarn record record --track <id> --line ${label} --driver <id>`,
    );
  }
  const rec = JSON.parse(fs.readFileSync(p, 'utf-8')) as RecordingFile;
  if (rec.sampleCount === 0 || rec.samples.length === 0) {
    throw new Error(`Recording ${filename} has no samples — re-record this line`);
  }
  return rec;
}

export function computeTrack(opts: {
  trackId: string;
  sectorTimesMs: number[];   // sector times from the ideal-line recording lap
  outputDir: string;
}): ComputedTrack {
  const { trackId, sectorTimesMs, outputDir } = opts;
  const sectorCount = sectorTimesMs.length;

  const leftRec  = loadRecording(outputDir, 'left-edge.json',  'left');
  const rightRec = loadRecording(outputDir, 'right-edge.json', 'right');
  const idealRec = loadRecording(outputDir, 'ideal-line.json', 'ideal');

  const toVec3 = (s: { x: number; y: number; z: number }): Vec3 => [s.x, s.y, s.z];

  const leftLine  = resample(leftRec.samples.map(toVec3),  RESAMPLE_N);
  const rightLine = resample(rightRec.samples.map(toVec3), RESAMPLE_N);
  const idealLine = resample(idealRec.samples.map(toVec3), RESAMPLE_N);

  const centerline: Vec3[] = idealLine.map((_, i) => [
    (leftLine[i][0] + rightLine[i][0]) / 2,
    (leftLine[i][1] + rightLine[i][1]) / 2,
    (leftLine[i][2] + rightLine[i][2]) / 2,
  ]);

  const arcLengthM = cumArcLengths(idealLine).at(-1)!;

  // Place each sector boundary at the exact 3D position where the car was
  // at the cumulative sector time in the ideal-line recording.
  // Because the times come from the SAME lap as the recording, this is a
  // direct lookup — no speed-profile assumptions needed.
  const sectorBoundaries: SectorBoundary[] = [];
  let cumT = 0;
  for (let i = 0; i < sectorCount - 1; i++) {
    cumT += sectorTimesMs[i];
    const P           = lapTLookup(idealRec.samples, cumT);
    const idx         = nearestIndex(idealLine, P);
    const arcFraction = idx / (RESAMPLE_N - 1);
    sectorBoundaries.push(buildBoundary(P, arcFraction, idealLine, leftLine, rightLine));
  }

  const track: ComputedTrack = {
    id: trackId,
    sectorCount,
    centerline,
    idealLine,
    leftLine,
    rightLine,
    arcLengthM,
    sectorBoundaries,
    sectorTimesMs,
    computedAt: new Date().toISOString(),
  };

  const trackPath = path.join(outputDir, 'track.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(trackPath, JSON.stringify(track, null, 2));
  return track;
}
