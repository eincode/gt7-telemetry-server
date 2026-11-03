import type WebSocket from "ws";
import type { DriverState } from "../../drivers";
import { ingestPacket } from "../../ingest";
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

  ingestPacket(state, packet);
}
