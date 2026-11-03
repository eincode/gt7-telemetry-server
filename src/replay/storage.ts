import * as fs from "fs";
import * as path from "path";
import type { RunMeta, RunRecording } from "./types";

const RECORDINGS_ROOT = path.join(process.cwd(), "recordings");
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_BYTES = 16 * 1024;

// Labels and track ids become file paths — keep them to a safe charset.
export function isValidName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

function runPath(trackId: string, label: string): string {
  if (!isValidName(trackId) || !isValidName(label)) {
    throw new Error("trackId and label may only contain letters, digits, - and _");
  }
  return path.join(RECORDINGS_ROOT, trackId, `${label}.json`);
}

export function saveRun(run: RunRecording): string {
  const file = runPath(run.trackId, run.label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Compact JSON: a 5-lap run is ~30k packets, indentation would double the size.
  fs.writeFileSync(file, JSON.stringify(run));
  return file;
}

export function loadRun(trackId: string, label: string): RunRecording {
  const file = runPath(trackId, label);
  if (!fs.existsSync(file)) {
    throw new Error(`no recording "${label}" for track "${trackId}"`);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as RunRecording;
}

// Parse only the header: everything before the trailing `packets` array.
function readMeta(file: string): RunMeta | null {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    const head = buf.toString("utf-8", 0, n);
    const i = head.indexOf(',"packets":');
    return i < 0 ? null : (JSON.parse(head.slice(0, i) + "}") as RunMeta);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function listRuns(trackId?: string): Record<string, RunMeta[]> {
  const out: Record<string, RunMeta[]> = {};
  if (!fs.existsSync(RECORDINGS_ROOT)) return out;

  const trackIds = trackId
    ? [trackId]
    : fs
        .readdirSync(RECORDINGS_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

  for (const id of trackIds) {
    if (!isValidName(id)) continue;
    const dir = path.join(RECORDINGS_ROOT, id);
    if (!fs.existsSync(dir)) continue;
    const metas = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readMeta(path.join(dir, f)))
      .filter((m): m is RunMeta => m !== null)
      .sort((a, b) => a.label.localeCompare(b.label));
    if (metas.length > 0) out[id] = metas;
  }
  return out;
}
