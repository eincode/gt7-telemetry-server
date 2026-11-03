import type { DriverState } from "./drivers";
import * as drivers from "./drivers";
import { getGapEngine } from "./handlers/shared";
import * as packetRecorder from "./replay/recorder";
import * as sectorTracker from "./sector-tracker";
import * as session from "./session";
import { getTrack } from "./track";
import type { DriverPacket } from "./types";

// Single entry point for a driver packet — live WebSocket and replay both go
// through here, so replayed runs exercise the exact same pipeline.
export function ingestPacket(
  state: DriverState,
  packet: DriverPacket,
  opts: { record?: boolean } = {},
): void {
  if (opts.record !== false) packetRecorder.onPacket(state.id, packet);

  drivers.updatePacket(state, packet);

  const timestamp = performance.now() / 1000;
  const gapEngine = getGapEngine();
  if (state.telemetry) {
    gapEngine?.onPacket(
      String(state.id),
      {
        position: state.telemetry?.position,
        speed: state.telemetry?.speed,
        lapCount: state.telemetry?.lapCount,
        currentLap: state.telemetry?.currentLap,
        totalLaps: state.telemetry?.totalLaps,
      },
      timestamp,
      session.getSession()?.mode ?? "practice",
    );
  }

  const track = getTrack();
  if (track) {
    sectorTracker.update(
      state.id,
      track,
      packet.position,
      packet.currentLap,
      packet.lapCount,
      packet.lastLaptime,
      session.getSession()?.mode,
    );
  }
}
