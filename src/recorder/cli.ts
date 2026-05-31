#!/usr/bin/env tsx
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { connectOverlay } from './overlay-client';
import { createRecorder } from './recorder';
import { computeTrack } from './track-processor';
import { startMonitor } from './monitor';
import { startSectorTester } from './sector-tester';
import type { LineKind, ComputedTrack } from './types';

// ── Constants ──────────────────────────────────────────────────────────────────

const TRACKS_ROOT = path.join(process.cwd(), 'tracks');
const LINES: LineKind[] = ['left', 'right', 'ideal'];
const LINE_FILES: Record<LineKind, string> = {
  left:  'left-edge.json',
  right: 'right-edge.json',
  ideal: 'ideal-line.json',
};
const DEFAULT_URL = 'ws://localhost:3000/overlay';

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
};

// ── readline helpers ──────────────────────────────────────────────────────────

// ── readline / line-queue ─────────────────────────────────────────────────────
//
// Line-queue pattern: buffer every incoming line immediately on the 'line'
// event. ask() dequeues synchronously when lines are buffered (piped input)
// or waits for the next keypress (interactive terminal). This avoids the
// piped-stdin race where readline fires 'close' before async continuations run.

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const lineQueue: string[]                     = [];
const lineWaiters: Array<(l: string) => void> = [];

rl.on('line', (line) => {
  if (lineWaiters.length > 0) {
    lineWaiters.shift()!(line);
  } else {
    lineQueue.push(line);
  }
});

function nextLine(prompt: string): Promise<string> {
  process.stdout.write(`  ${prompt}: `);
  return new Promise((resolve) => {
    if (lineQueue.length > 0) {
      const line = lineQueue.shift()!;
      process.stdout.write(line + '\n');   // echo for piped input (no TTY auto-echo)
      resolve(line);
    } else {
      lineWaiters.push(resolve);
    }
  });
}

function ask(prompt: string, defaultValue = ''): Promise<string> {
  const hint = defaultValue ? C.dim(` [${defaultValue}]`) : '';
  return nextLine(`${prompt}${hint}`).then((a) => a.trim() || defaultValue);
}

function choose(title: string, options: string[]): Promise<number> {
  process.stdout.write(`\n  ${C.bold(title)}\n`);
  options.forEach((opt, i) => {
    process.stdout.write(`    ${C.cyan(String(i + 1))}  ${opt}\n`);
  });
  process.stdout.write('\n');

  const tryRead = (): Promise<number> =>
    nextLine(`Choice [1-${options.length}]`).then((answer) => {
      const n = parseInt(answer.trim(), 10);
      if (n >= 1 && n <= options.length) return n - 1;
      process.stdout.write(C.red(`  Please enter a number between 1 and ${options.length}.\n`));
      return tryRead();
    });

  return tryRead();
}

// ── Server session helpers ────────────────────────────────────────────────────

function wsToHttpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/overlay$/, '');
}

async function fetchRecordingSession(wsUrl = DEFAULT_URL): Promise<{ trackId: string } | null> {
  try {
    const res  = await fetch(`${wsToHttpBase(wsUrl)}/session`);
    if (!res.ok) return null;
    const data = await res.json() as { session?: { trackId?: string; isRecording?: boolean } };
    const s = data.session;
    return s?.isRecording && s.trackId ? { trackId: s.trackId } : null;
  } catch {
    return null;
  }
}

// ── Track helpers ─────────────────────────────────────────────────────────────

function getTracksOnDisk(): string[] {
  if (!fs.existsSync(TRACKS_ROOT)) return [];
  return fs.readdirSync(TRACKS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function getProcessedTracks(): string[] {
  return getTracksOnDisk().filter((id) =>
    fs.existsSync(path.join(TRACKS_ROOT, id, 'track.json')),
  );
}

function trackDir(trackId: string): string {
  return path.join(TRACKS_ROOT, trackId);
}

// Pick a track from existing list or type a new one.
// Pass `processedOnly: true` to restrict to tracks that have track.json.
async function pickTrack(opts: { processedOnly?: boolean } = {}): Promise<string> {
  const tracks = opts.processedOnly ? getProcessedTracks() : getTracksOnDisk();

  if (tracks.length === 0) {
    if (opts.processedOnly) {
      process.stdout.write(C.yellow('\n  No processed tracks found — run "Process track" first.\n\n'));
      rl.close();
      process.exit(1);
    }
    return ask('Track ID');
  }

  const labels  = tracks.map((id) => {
    const dir    = path.join(TRACKS_ROOT, id);
    const linesN = LINES.filter((l) => fs.existsSync(path.join(dir, LINE_FILES[l]))).length;
    const processed = fs.existsSync(path.join(dir, 'track.json'));
    const badge  = processed ? C.green('✓ processed') : C.dim(`${linesN}/3 lines`);
    return `${id.padEnd(28)} ${badge}`;
  });

  if (!opts.processedOnly) {
    labels.push('Enter a new track ID…');
  }

  const idx = await choose('Select track', labels);

  if (!opts.processedOnly && idx === tracks.length) {
    return ask('Track ID');
  }
  return tracks[idx];
}

// ── Action: record ────────────────────────────────────────────────────────────

async function runRecord(): Promise<void> {
  process.stdout.write(`\n${C.bold('── Record a line')} ${C.dim('────────────────────────────────')}\n`);

  // If the web recorder started a session, pick up its track ID automatically
  const activeSession = await fetchRecordingSession();
  let trackId: string;
  if (activeSession) {
    process.stdout.write(`\n  ${C.green('✓')} Active recording session — track: ${C.yellow(activeSession.trackId)}\n`);
    trackId = activeSession.trackId;
  } else {
    trackId = await pickTrack();
  }

  const lineIdx = await choose('Line type', [
    `left   ${C.dim('— hug the left edge for one lap')}`,
    `right  ${C.dim('— hug the right edge for one lap')}`,
    `ideal  ${C.dim('— drive your racing line (note the sector times!)')}`,
  ]);
  const line = LINES[lineIdx];

  const driverStr = await ask('Driver ID');
  const driverId  = parseInt(driverStr, 10);
  if (isNaN(driverId) || driverId < 0) {
    process.stderr.write(C.red('  Driver ID must be a non-negative integer.\n'));
    return;
  }

  const url = await ask('Server URL', DEFAULT_URL);

  const outputDir = trackDir(trackId);
  process.stdout.write(`\n${C.bold('GT7 Track Recorder')}\n`);
  process.stdout.write(`  Track  : ${C.yellow(trackId)}\n`);
  process.stdout.write(`  Line   : ${C.yellow(line)}\n`);
  process.stdout.write(`  Driver : ${C.yellow(String(driverId))}\n`);
  process.stdout.write(`  Server : ${C.dim(url)}\n\n`);
  process.stdout.write(`Connecting…\n`);

  const recorder = createRecorder({ trackId, line, driverId, outputDir });

  await new Promise<void>((resolve) => {
    let ws: ReturnType<typeof connectOverlay>;

    recorder.onDone((file) => {
      process.stdout.write(`\n${C.green('Done!')} ${file.sampleCount} samples recorded.\n`);
      ws.close();
      resolve();
    });

    recorder.onDiscard(() => resolve());

    ws = connectOverlay(
      url,
      (msg) => recorder.handleState(msg),
      (err) => {
        recorder.destroy();
        process.stderr.write(C.red(`Connection failed: ${err.message}\n`));
        process.stderr.write(C.dim(`  Is the relay server running at ${url}?\n`));
        resolve();
      },
      () => {
        recorder.destroy();
        process.stderr.write(C.red('\nServer disconnected.\n'));
        resolve();
      },
    );

    ws.once('open', () => {
      process.stdout.write(`${C.green('Connected.')} Waiting for driver ${driverId}…\n\n`);
    });
  });
}

// ── Action: process ────────────────────────────────────────────────────────────

async function runProcess(): Promise<void> {
  process.stdout.write(`\n${C.bold('── Process track')} ${C.dim('───────────────────────────────')}\n`);

  const trackId = await pickTrack();

  process.stdout.write(C.dim('\n  Enter the sector times shown by the game at the end of your\n'));
  process.stdout.write(C.dim('  ideal-line recording lap, in seconds, comma-separated.\n'));
  process.stdout.write(C.dim('  Example: 28.451,15.023,18.204\n\n'));

  const timesStr = await ask('Sector times (seconds)');
  const timesMs  = timesStr
    .split(',')
    .map((s) => Math.round(parseFloat(s.trim()) * 1000));

  if (timesMs.length < 2 || timesMs.some((t) => isNaN(t) || t <= 0)) {
    process.stderr.write(C.red('  Need at least 2 valid positive sector times.\n'));
    return;
  }

  const outputDir = trackDir(trackId);
  const totalMs   = timesMs.reduce((a, b) => a + b, 0);

  try {
    const track = computeTrack({ trackId, sectorTimesMs: timesMs, outputDir });
    const trackPath = path.join(outputDir, 'track.json');
    process.stdout.write(`\n${C.green('✓ Track processed:')} ${trackPath}\n`);
    process.stdout.write(`  Arc length : ${track.arcLengthM.toFixed(1)} m\n`);
    process.stdout.write(`  Sectors    : ${track.sectorCount}\n`);
    process.stdout.write(`  Lap time   : ${(totalMs / 1000).toFixed(3)}s\n`);
    process.stdout.write(`  Boundaries :\n`);
    for (const b of track.sectorBoundaries) {
      process.stdout.write(
        `    ${(b.arcFraction * 100).toFixed(2).padStart(6)}%  (${b.position.map((v) => v.toFixed(1)).join(', ')})\n`,
      );
    }
  } catch (err) {
    process.stderr.write(C.red(`\n${(err as Error).message}\n`));
  }
}

// ── Action: test sectors ──────────────────────────────────────────────────────

async function runTestSectors(): Promise<void> {
  process.stdout.write(`\n${C.bold('── Test sectors')} ${C.dim('────────────────────────────────')}\n`);

  const trackId = await pickTrack({ processedOnly: true });

  const driverStr = await ask('Driver ID');
  const driverId  = parseInt(driverStr, 10);
  if (isNaN(driverId) || driverId < 0) {
    process.stderr.write(C.red('  Driver ID must be a non-negative integer.\n'));
    return;
  }

  const url = await ask('Server URL', DEFAULT_URL);

  const trackPath = path.join(trackDir(trackId), 'track.json');
  const track     = JSON.parse(fs.readFileSync(trackPath, 'utf-8')) as ComputedTrack;

  process.stdout.write(`\n${C.bold('GT7 Sector Tester')}\n`);
  process.stdout.write(`  Track  : ${C.yellow(trackId)}  (${track.sectorCount} sectors)\n`);
  process.stdout.write(`  Driver : ${C.yellow(String(driverId))}\n`);
  process.stdout.write(`  Server : ${C.dim(url)}\n\n`);
  process.stdout.write(`Connecting…\n`);

  rl.close();

  startSectorTester({ url, track, driverId });
}

// ── Action: track info ────────────────────────────────────────────────────────

async function runInfo(): Promise<void> {
  process.stdout.write(`\n${C.bold('── Track info')} ${C.dim('──────────────────────────────────')}\n`);

  const trackId  = await pickTrack();

  const outputDir = trackDir(trackId);
  process.stdout.write(`\n${C.bold(`Track: ${trackId}`)}\n\n`);

  let allPresent = true;
  for (const line of LINES) {
    const p      = path.join(outputDir, LINE_FILES[line]);
    const exists = fs.existsSync(p);
    if (!exists) allPresent = false;
    process.stdout.write(`  ${exists ? C.green('✓') : C.red('✗')} ${LINE_FILES[line]}\n`);
  }

  const trackPath = path.join(outputDir, 'track.json');
  if (fs.existsSync(trackPath)) {
    const track   = JSON.parse(fs.readFileSync(trackPath, 'utf-8')) as ComputedTrack;
    const totalMs = track.sectorTimesMs?.reduce((a, b) => a + b, 0) ?? 0;
    process.stdout.write(`\n  ${C.green('✓')} track.json\n`);
    process.stdout.write(`    Sectors    : ${track.sectorCount}\n`);
    process.stdout.write(`    Arc length : ${track.arcLengthM.toFixed(1)} m\n`);
    if (track.sectorTimesMs?.length) {
      process.stdout.write(
        `    Lap time   : ${(totalMs / 1000).toFixed(3)}s` +
        `  (${track.sectorTimesMs.map((t, i) => `S${i + 1}: ${(t / 1000).toFixed(3)}`).join('  ')})\n`,
      );
    }
    process.stdout.write(`    Computed   : ${track.computedAt}\n`);
  } else if (allPresent) {
    process.stdout.write(`\n  ${C.yellow('○')} All lines recorded — run "Process track" to compute boundaries.\n`);
  } else {
    process.stdout.write(`\n  Record all 3 lines first, then run "Process track".\n`);
  }
  process.stdout.write('\n');
}

// ── Action: list tracks ───────────────────────────────────────────────────────

function runList(): void {
  const tracks = getTracksOnDisk();

  if (tracks.length === 0) {
    process.stdout.write('\n  No tracks recorded yet.\n\n');
    return;
  }

  process.stdout.write(`\n${C.bold('Recorded tracks:')}\n\n`);
  for (const id of tracks) {
    const dir    = path.join(TRACKS_ROOT, id);
    const linesN = LINES.filter((l) => fs.existsSync(path.join(dir, LINE_FILES[l]))).length;
    const processed = fs.existsSync(path.join(dir, 'track.json'));
    const status = processed
      ? C.green('processed')
      : linesN === 3
        ? C.yellow('ready to process')
        : C.dim(`${linesN}/3 lines recorded`);
    process.stdout.write(`  ${id.padEnd(28)} ${status}\n`);
  }
  process.stdout.write('\n');
}

// ── Action: monitor ───────────────────────────────────────────────────────────

async function runMonitor(): Promise<void> {
  process.stdout.write(`\n${C.bold('── Monitor telemetry')} ${C.dim('───────────────────────────────')}\n\n`);

  const driverStr = await ask('Driver ID to watch (leave blank for all)', '');
  const driverId  = driverStr ? parseInt(driverStr, 10) : undefined;
  if (driverStr && (isNaN(driverId!) || driverId! < 0)) {
    process.stderr.write(C.red('  Driver ID must be a non-negative integer.\n'));
    return;
  }

  const rawChoice = await choose('Output format', [
    `Formatted view ${C.dim('— readable live dashboard')}`,
    `Raw JSON       ${C.dim('— full packet dump')}`,
  ]);
  const raw = rawChoice === 1;

  const url = await ask('Server URL', DEFAULT_URL);

  rl.close();  // close before handing off to long-running monitor
  startMonitor({ url, raw, driverId });
}

// ── Main menu ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write('\n');
  process.stdout.write(C.bold('  GT7 Track Recorder\n'));
  process.stdout.write(C.dim('  ─────────────────────────────────────────\n'));

  while (true) {
    const action = await choose('What would you like to do?', [
      'Record a line',
      'Process track',
      'Test sectors',
      'Track info',
      'List tracks',
      'Monitor telemetry',
      'Exit',
    ]);

    switch (action) {
      case 0: await runRecord();      break;  // returns → loops back
      case 1: await runProcess();     break;  // returns → loops back
      case 2: await runTestSectors(); break;  // hands off → process.exit()
      case 3: await runInfo();        break;  // returns → loops back
      case 4: runList();              break;  // returns → loops back
      case 5: await runMonitor();     break;  // hands off → process.exit()
      case 6:
        process.stdout.write('\nBye!\n');
        rl.close();
        return;
    }
  }
}

main().catch((err: Error) => {
  process.stderr.write(C.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
