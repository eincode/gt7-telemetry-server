import { salsa20Xor } from "./salsa20";

// Mirrors friz-telemetry's decode.ts (decryptPacket) and version.ts.

export const MAGIC = 0x47375330; // "G7S0" little-endian

const SALSA_KEY = "Simulator Interface Packet GT7 ver 0.0";

// Fixed 32-byte ASCII key, null-padded.
const KEY = Buffer.alloc(32);
Buffer.from(SALSA_KEY, "ascii").copy(KEY);

// Datagram size per packet version, as sent by the PS5.
export const PACKET_SIZE = {
  A: 296,
  B: 316,
  TILDE: 344,
  C: 368,
} as const;

export type PacketVersion = keyof typeof PACKET_SIZE;

const IV_MASK: Record<PacketVersion, number> = {
  A: 0xdeadbeaf,
  B: 0xdeadbeef,
  C: 0xdeadbeef,
  TILDE: 0x55fabb4f,
};

export function detectVersion(byteLength: number): PacketVersion | null {
  switch (byteLength) {
    case PACKET_SIZE.A:
      return "A";
    case PACKET_SIZE.B:
      return "B";
    case PACKET_SIZE.TILDE:
      return "TILDE";
    case PACKET_SIZE.C:
      return "C";
    default:
      return null;
  }
}

/**
 * Decrypts a raw GT7 telemetry datagram. Returns null when the size isn't a
 * known packet version or the decrypted magic isn't "G7S0".
 */
export function decryptPacket(raw: Buffer): Buffer | null {
  const version = detectVersion(raw.length);
  if (!version) return null;

  // iv1 sits inside the ciphertext at 0x40 and must be read before decrypting.
  const iv1 = raw.readUInt32LE(0x40);
  const iv2 = (iv1 ^ IV_MASK[version]) >>> 0;

  const nonce = Buffer.alloc(8);
  nonce.writeUInt32LE(iv2, 0);
  nonce.writeUInt32LE(iv1, 4);

  const plaintext = salsa20Xor(raw, KEY, nonce);
  if (plaintext.readUInt32LE(0x00) !== MAGIC) return null;
  return plaintext;
}
