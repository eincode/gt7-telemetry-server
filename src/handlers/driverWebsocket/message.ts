import type WebSocket from "ws";
import * as drivers from "../../drivers";
import type { DriverState } from "../../drivers";
import * as sectorTracker from "../../sector-tracker";
import * as session from "../../session";
import { getTrack } from "../../track";
import type { DriverPacket } from "../../types";

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
