// Minimal Salsa20/20 keystream generator — just enough to decrypt GT7
// telemetry. Ported from friz-telemetry's salsa20.ts (same algorithm, loop
// form instead of fully unrolled).

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function rotl(v: number, n: number): number {
  return (v << n) | (v >>> (32 - n));
}

/**
 * XORs `data` with the Salsa20/20 keystream for `key` (32 bytes) and
 * `nonce` (8 bytes), starting at block counter 0. Returns a new buffer.
 */
export function salsa20Xor(data: Buffer, key: Buffer, nonce: Buffer): Buffer {
  const input = new Uint32Array(16);
  input[0] = SIGMA[0];
  for (let i = 0; i < 4; i++) input[1 + i] = key.readUInt32LE(i * 4);
  input[5] = SIGMA[1];
  input[6] = nonce.readUInt32LE(0);
  input[7] = nonce.readUInt32LE(4);
  input[8] = 0; // block counter, low word
  input[9] = 0; // block counter, high word
  input[10] = SIGMA[2];
  for (let i = 0; i < 4; i++) input[11 + i] = key.readUInt32LE(16 + i * 4);
  input[15] = SIGMA[3];

  const x = new Uint32Array(16);
  const block = Buffer.alloc(64);
  const out = Buffer.alloc(data.length);

  for (let pos = 0; pos < data.length; pos += 64) {
    x.set(input);
    for (let r = 0; r < 20; r += 2) {
      // Column round
      x[4] ^= rotl(x[0] + x[12], 7);
      x[8] ^= rotl(x[4] + x[0], 9);
      x[12] ^= rotl(x[8] + x[4], 13);
      x[0] ^= rotl(x[12] + x[8], 18);
      x[9] ^= rotl(x[5] + x[1], 7);
      x[13] ^= rotl(x[9] + x[5], 9);
      x[1] ^= rotl(x[13] + x[9], 13);
      x[5] ^= rotl(x[1] + x[13], 18);
      x[14] ^= rotl(x[10] + x[6], 7);
      x[2] ^= rotl(x[14] + x[10], 9);
      x[6] ^= rotl(x[2] + x[14], 13);
      x[10] ^= rotl(x[6] + x[2], 18);
      x[3] ^= rotl(x[15] + x[11], 7);
      x[7] ^= rotl(x[3] + x[15], 9);
      x[11] ^= rotl(x[7] + x[3], 13);
      x[15] ^= rotl(x[11] + x[7], 18);
      // Row round
      x[1] ^= rotl(x[0] + x[3], 7);
      x[2] ^= rotl(x[1] + x[0], 9);
      x[3] ^= rotl(x[2] + x[1], 13);
      x[0] ^= rotl(x[3] + x[2], 18);
      x[6] ^= rotl(x[5] + x[4], 7);
      x[7] ^= rotl(x[6] + x[5], 9);
      x[4] ^= rotl(x[7] + x[6], 13);
      x[5] ^= rotl(x[4] + x[7], 18);
      x[11] ^= rotl(x[10] + x[9], 7);
      x[8] ^= rotl(x[11] + x[10], 9);
      x[9] ^= rotl(x[8] + x[11], 13);
      x[10] ^= rotl(x[9] + x[8], 18);
      x[12] ^= rotl(x[15] + x[14], 7);
      x[13] ^= rotl(x[12] + x[15], 9);
      x[14] ^= rotl(x[13] + x[12], 13);
      x[15] ^= rotl(x[14] + x[13], 18);
    }
    for (let i = 0; i < 16; i++) block.writeUInt32LE((x[i] + input[i]) >>> 0, i * 4);

    const n = Math.min(64, data.length - pos);
    for (let i = 0; i < n; i++) out[pos + i] = data[pos + i] ^ block[i];

    // 64-bit block counter
    input[8] = input[8] + 1;
    if (input[8] === 0) input[9] = input[9] + 1;
  }

  return out;
}
