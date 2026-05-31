import * as fs from 'fs';
import * as path from 'path';
import type { ComputedTrack } from './recorder/types';

const TRACKS_ROOT = path.join(process.cwd(), 'tracks');

let activeTrack: ComputedTrack | null = null;

export function loadTrack(trackId: string): ComputedTrack {
  const trackPath = path.join(TRACKS_ROOT, trackId, 'track.json');
  if (!fs.existsSync(trackPath)) {
    throw new Error(
      `Track "${trackId}" not found — run: yarn record process --track ${trackId} --times <ms1,ms2,...>`,
    );
  }
  const track = JSON.parse(fs.readFileSync(trackPath, 'utf-8')) as ComputedTrack;
  activeTrack = track;
  console.log(`[track] loaded "${trackId}" (${track.sectorCount} sectors, ${track.arcLengthM.toFixed(0)} m)`);
  return track;
}

export function getTrack(): ComputedTrack | null {
  return activeTrack;
}

export function setTrack(track: ComputedTrack): void {
  activeTrack = track;
}

export function clearTrack(): void {
  activeTrack = null;
}
