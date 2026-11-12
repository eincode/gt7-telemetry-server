import type { DriverPacket } from "../types";

// Builds a DriverPacket from a decrypted GT7 packet. Field offsets and
// encodings mirror friz-telemetry's parseServerPacket.ts, so the result is
// identical to the JSON the client used to send.

// Floats are rounded to 3 decimals (millimetres for positions), matching the
// old JSON payload and keeping replay recordings the same size.
const FLOAT_SCALE = 1000;

function readFloat(buf: Buffer, offset: number): number {
  return Math.round(buf.readFloatLE(offset) * FLOAT_SCALE) / FLOAT_SCALE;
}

function readVec3(buf: Buffer, offset: number): [number, number, number] {
  return [
    readFloat(buf, offset),
    readFloat(buf, offset + 4),
    readFloat(buf, offset + 8),
  ];
}

function readFloat4(
  buf: Buffer,
  offset: number,
): [number, number, number, number] {
  return [
    readFloat(buf, offset),
    readFloat(buf, offset + 4),
    readFloat(buf, offset + 8),
    readFloat(buf, offset + 12),
  ];
}

function readAscii(buf: Buffer, offset: number, length: number): string {
  return buf.toString("ascii", offset, offset + length).replace(/\0+$/, "");
}

/**
 * @param buf decrypted packet (from decryptPacket)
 * @param raw the original encrypted datagram — `iv` is taken from its bytes at
 *            0x40, since that field is only meaningful before decryption
 */
export function parsePacket(buf: Buffer, raw: Buffer): DriverPacket {
  const packet: DriverPacket = {
    magic: buf.readUInt32LE(0x00),
    position: readVec3(buf, 0x04),
    worldVelocity: readVec3(buf, 0x10),
    rotation: readVec3(buf, 0x1c),
    orientationRelativeToNorth: readFloat(buf, 0x28),
    angularVelocity: readVec3(buf, 0x2c),
    bodyHeight: readFloat(buf, 0x38),
    EngineRPM: readFloat(buf, 0x3c),
    iv: [raw[0x40], raw[0x41], raw[0x42], raw[0x43]],
    fuelLevel: readFloat(buf, 0x44),
    fuelCapacity: readFloat(buf, 0x48),
    speed: readFloat(buf, 0x4c),
    boost: readFloat(buf, 0x50),
    oilPressure: readFloat(buf, 0x54),
    waterTemp: readFloat(buf, 0x58),
    oilTemp: readFloat(buf, 0x5c),
    tyreTemp: readFloat4(buf, 0x60),
    packetId: buf.readInt32LE(0x70),
    lapCount: buf.readInt16LE(0x74),
    totalLaps: buf.readInt16LE(0x76),
    bestLaptime: buf.readInt32LE(0x78),
    lastLaptime: buf.readInt32LE(0x7c),
    dayProgression: buf.readInt32LE(0x80),
    RaceStartPosition: buf.readInt16LE(0x84),
    preRaceNumCars: buf.readInt16LE(0x86),
    minAlertRPM: buf.readInt16LE(0x88),
    maxAlertRPM: buf.readInt16LE(0x8a),
    calcMaxSpeed: buf.readInt16LE(0x8c),
    flags: buf.readUInt16LE(0x8e), // flags1 | flags2 << 8
    gears: buf.readUInt8(0x90), // both nibbles; drivers.ts splits them
    throttle: buf.readUInt8(0x91), // raw 0-255
    brake: buf.readUInt8(0x92), // raw 0-255
    roadPlane: readVec3(buf, 0x94),
    roadPlaneDistance: readFloat(buf, 0xa0),
    wheelRPS: readFloat4(buf, 0xa4),
    tyreRadius: readFloat4(buf, 0xb4),
    suspHeight: readFloat4(buf, 0xc4),
    clutch: readFloat(buf, 0xf4),
    clutchEngagement: readFloat(buf, 0xf8),
    RPMFromClutchToGearbox: readFloat(buf, 0xfc),
    transmissionTopSpeed: readFloat(buf, 0x100),
    gearRatios: [
      readFloat(buf, 0x104),
      readFloat(buf, 0x108),
      readFloat(buf, 0x10c),
      readFloat(buf, 0x110),
      readFloat(buf, 0x114),
      readFloat(buf, 0x118),
      readFloat(buf, 0x11c),
      readFloat(buf, 0x120),
    ],
    carCode: buf.readInt32LE(0x124),
  };

  // PacketB+ tail (>= 316 bytes)
  if (buf.length >= 0x138 + 4) {
    packet.wheelRotation = readFloat(buf, 0x128);
    packet.steeringAngularVelocity = readFloat(buf, 0x12c);
    packet.sway = readFloat(buf, 0x130);
    packet.heave = readFloat(buf, 0x134);
    packet.surge = readFloat(buf, 0x138);
  }

  // PacketTilda+ tail (>= 344 bytes)
  if (buf.length >= 0x158 + 4) {
    packet.throttleFiltered = buf.readUInt8(0x13c);
    packet.brakeFiltered = buf.readUInt8(0x13d);
    packet.torqueVectors = readFloat4(buf, 0x140);
    packet.energyRecovery = readFloat(buf, 0x150);
  }

  // PacketC-only tail (368 bytes)
  if (buf.length >= 0x16c + 4) {
    packet.surfaceType = readAscii(buf, 0x158, 4);
    packet.currentLap = buf.readInt32LE(0x15c);
    packet.wheelSteeringAngle = [readFloat(buf, 0x160), readFloat(buf, 0x164)];
    packet.wheelBase = readFloat(buf, 0x168);
    packet.carCategory = readAscii(buf, 0x16c, 4);
  }

  return packet;
}
