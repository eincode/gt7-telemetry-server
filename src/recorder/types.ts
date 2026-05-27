export type Vec3 = [number, number, number];
export type LineKind = 'left' | 'right' | 'ideal';
export type RecorderPhase = 'waiting' | 'recording' | 'done';

export interface PositionSample {
  t: number;      // wall-clock ms since recording started
  lapT: number;   // packet.currentLap value (ms elapsed in current lap)
  x: number;
  y: number;
  z: number;
}

export interface RecordingFile {
  trackId: string;
  line: LineKind;
  recordedAt: string;   // ISO 8601
  durationMs: number;
  sampleCount: number;
  samples: PositionSample[];
}

export interface SectorBoundary {
  arcFraction: number;  // 0.0–1.0 along the ideal line
  position: Vec3;       // center point — exact position from lapT lookup in the ideal-line recording
  normal: Vec3;         // unit track-forward direction — crossing test: dot(car - position, normal) sign change
  leftEdge: Vec3;       // left track edge at this boundary (perpendicular projection)
  rightEdge: Vec3;      // right track edge at this boundary (perpendicular projection)
}

export interface ComputedTrack {
  id: string;
  sectorCount: number;
  centerline: Vec3[];   // 500 pts — avg of left+right, for visualization
  idealLine: Vec3[];    // 500 pts — resampled ideal, for progress & tangent lookups
  leftLine: Vec3[];     // 500 pts — resampled left edge, for boundary geometry
  rightLine: Vec3[];    // 500 pts — resampled right edge, for boundary geometry
  arcLengthM: number;   // total arc length of idealLine in meters
  sectorBoundaries: SectorBoundary[];
  sectorTimesMs: number[];      // per-sector ms from the ideal-line recording lap — used to locate boundaries
  computedAt: string;           // ISO 8601
}
