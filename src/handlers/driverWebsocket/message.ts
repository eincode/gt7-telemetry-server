import type WebSocket from "ws";
import type { DriverState } from "../../drivers";
import * as drivers from "../../drivers";
import * as sectorTracker from "../../sector-tracker";
import * as session from "../../session";
import { getTrack } from "../../track";
import type { DriverPacket } from "../../types";
import { getGapEngine } from "../shared";

export default function handler(
  ws: WebSocket,
  state: DriverState,
  data: WebSocket.RawData,
) {
  let packet: DriverPacket;
  try {
    packet = JSON.parse(data.toString()) as DriverPacket;
  } catch {
    return;
  }
  if (typeof packet.magic !== "number" || typeof packet.carCode !== "number")
    return;

  drivers.updatePacket(state, packet);

  // Gap engine calculation moved here
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
