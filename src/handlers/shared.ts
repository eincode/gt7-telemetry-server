import { loadTrack } from "../track";
import type { SessionMode } from "../types";
import { GapEngine } from "../v2/gap-engine";
import { TrackRuler } from "../v2/track-ruler";
import {
  calibrateLateralSign,
  calibrateSectors,
} from "../v2/utils/projection";

export const VALID_MODES: SessionMode[] = ["race", "qualifying", "practice"];
export const MAX_DRIVERS = 16;

let gapEngine: GapEngine | null = null;

export function onRaceStart(trackId: string) {
  const trackJson = loadTrack(trackId);
  const ruler = new TrackRuler(trackJson);
  calibrateLateralSign(ruler, trackJson);
  calibrateSectors(ruler, trackJson);
  gapEngine = new GapEngine(ruler);
}

export function getGapEngine() {
  return gapEngine;
}
