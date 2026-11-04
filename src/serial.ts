import fs from "fs";
import type { SerialPort as SerialPortType } from "serialport";

// Serial link to the Arduino Pro Micro that types camera keys on the PS5.
// Protocol: one byte per key tap, 115200 8N1, no framing.

const BAUD_RATE = 115200;
const RETRY_MS = 2000;

// Only the USB-to-serial adapter on the Mac. Never /dev/cu.usbmodem* — that's
// the Arduino's own USB, which is plugged into the PS5.
const AUTO_DETECT = /^cu\.(usbserial|wchusbserial)/;

// serialport ships a native binding; load it lazily so a build without it
// (e.g. the bundled Windows exe) still runs, just without serial.
let SerialPort: typeof SerialPortType | null = null;
try {
  SerialPort = require("serialport").SerialPort;
} catch (err) {
  console.warn(`[serial] serialport unavailable: ${(err as Error).message}`);
}

let port: SerialPortType | null = null;
let currentPath: string | null = null;
let watchdog: NodeJS.Timeout | null = null;
let lastStatus = "";

// Log only when the message changes, so a missing adapter doesn't spam every 2s
function logStatus(message: string) {
  if (message === lastStatus) return;
  lastStatus = message;
  console.log(`[serial] ${message}`);
}

function resolvePath(): string | null {
  if (process.env.SERIAL_PORT) return process.env.SERIAL_PORT;
  if (process.platform !== "darwin") return null;
  try {
    const match = fs
      .readdirSync("/dev")
      .filter((name) => AUTO_DETECT.test(name))
      .sort()[0];
    return match ? `/dev/${match}` : null;
  } catch {
    return null;
  }
}

// Runs every RETRY_MS: reopen if closed, and drop the port if its device node
// vanished without the driver reporting a close (unplugged adapter).
function tick() {
  const p = port;
  if (!p) {
    open();
    return;
  }
  if (p.isOpen && currentPath && !fs.existsSync(currentPath)) {
    port = null;
    logStatus(`${currentPath} disappeared, retrying every 2s`);
    try {
      p.close(() => {});
    } catch {
      // already closed
    }
  }
}

function open() {
  if (!SerialPort || port) return;

  const path = resolvePath();
  if (!path) {
    logStatus(
      process.platform === "darwin"
        ? "no adapter found (/dev/cu.usbserial* or /dev/cu.wchusbserial*), retrying every 2s"
        : "no adapter found; set SERIAL_PORT, retrying every 2s",
    );
    return;
  }

  let p: SerialPortType;
  try {
    p = new SerialPort({
      path,
      baudRate: BAUD_RATE,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      autoOpen: false,
    });
  } catch (err) {
    logStatus(`could not create port ${path}: ${(err as Error).message}`);
    return;
  }

  port = p;
  currentPath = path;

  p.on("error", (err) => {
    console.error(`[serial] error on ${path}: ${err.message}`);
  });

  p.on("close", () => {
    if (port !== p) return;
    port = null;
    logStatus(`port ${path} closed, retrying every 2s`);
  });

  p.open((err) => {
    if (err) {
      if (port === p) port = null;
      logStatus(`could not open ${path}: ${err.message}, retrying every 2s`);
      return;
    }
    logStatus(`connected to ${path} @ ${BAUD_RATE} baud`);
  });
}

export function start(): void {
  if (watchdog) return;
  open();
  watchdog = setInterval(tick, RETRY_MS);
}

export function isConnected(): boolean {
  return port?.isOpen ?? false;
}

export function getPath(): string | null {
  return currentPath;
}

/** Write one key byte. Returns false if the port isn't open. */
export function sendKey(key: string): boolean {
  const p = port;
  if (!p?.isOpen) return false;
  // Catch an unplug immediately rather than waiting for the next tick
  if (currentPath && !fs.existsSync(currentPath)) {
    tick();
    return false;
  }
  p.write(key, (err) => {
    if (err) console.error(`[serial] write failed: ${err.message}`);
  });
  return true;
}
