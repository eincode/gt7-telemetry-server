import type WebSocket from "ws";
import type { DriverState } from "../../drivers";
import { decryptPacket, detectVersion } from "../../gt7/decrypt";
import { parsePacket } from "../../gt7/parse";
import { ingestPacket } from "../../ingest";

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

// ── Drop diagnostics ──────────────────────────────────────────────────────────
// Rejected frames are otherwise silent, so a misbehaving client looks exactly
// like one that sends nothing. Drops are counted per socket and summarised at
// most once per LOG_INTERVAL_MS.

const LOG_INTERVAL_MS = 5000;

interface DropStats {
  ok: number;
  text: number;
  badSize: number;
  badMagic: number;
  sizes: Set<number>;
  sample: string | null;
  loggedAt: number;
}

const stats = new WeakMap<WebSocket, DropStats>();

function drop(
  ws: WebSocket,
  state: DriverState,
  reason: "text" | "badSize" | "badMagic",
  raw: Buffer,
) {
  let s = stats.get(ws);
  if (!s) {
    s = { ok: 0, text: 0, badSize: 0, badMagic: 0, sizes: new Set(), sample: null, loggedAt: 0 };
    stats.set(ws, s);
  }
  s[reason]++;
  if (s.sizes.size < 8) s.sizes.add(raw.length);
  s.sample ??=
    reason === "text"
      ? JSON.stringify(raw.toString("utf8", 0, 80))
      : raw.subarray(0, 16).toString("hex");

  const now = Date.now();
  if (now - s.loggedAt < LOG_INTERVAL_MS) return;
  console.warn(
    `[driver] id=${state.id} dropped frames — text=${s.text} badSize=${s.badSize} ` +
      `badMagic=${s.badMagic} (accepted=${s.ok}); sizes=[${[...s.sizes].join(",")}] ` +
      `first=${s.sample}`,
  );
  s.ok = s.text = s.badSize = s.badMagic = 0;
  s.sizes.clear();
  s.sample = null;
  s.loggedAt = now;
}

// ── Receive rate ──────────────────────────────────────────────────────────────
// Driver packets are taken at ~20 Hz, the rate the client sends at. GT7 emits
// 60 Hz, so a client that forwards everything has two of every three packets
// dropped here. The gap sits between two and three GT7 packet intervals (33 /
// 50 ms) so arrival jitter on a 20 Hz stream doesn't knock out a packet.
const MIN_PACKET_GAP_MS = 42;
const lastAcceptedAt = new WeakMap<WebSocket, number>();

// Each binary frame is one encrypted GT7 UDP datagram, forwarded unchanged
// by the driver client. Text frames and anything that doesn't decrypt to a
// valid packet are dropped.
export default function handler(
  ws: WebSocket,
  state: DriverState,
  data: WebSocket.RawData,
  isBinary: boolean,
) {
  const raw = toBuffer(data);
  if (!isBinary) return drop(ws, state, "text", raw);
  if (!detectVersion(raw.length)) return drop(ws, state, "badSize", raw);

  const now = Date.now();
  if (now - (lastAcceptedAt.get(ws) ?? 0) < MIN_PACKET_GAP_MS) return;

  const plaintext = decryptPacket(raw);
  if (!plaintext) return drop(ws, state, "badMagic", raw);

  lastAcceptedAt.set(ws, now);
  const s = stats.get(ws);
  if (s) s.ok++;
  ingestPacket(state, parsePacket(plaintext, raw));
}
