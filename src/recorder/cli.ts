#!/usr/bin/env tsx
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { connectOverlay } from './overlay-client';
import { createRecorder } from './recorder';
import { computeTrack } from './track-processor';
import { startMonitor } from './monitor';
import { startSectorTester } from './sector-tester';
import type { LineKind, ComputedTrack } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRACKS_ROOT = path.join(process.cwd(), 'tracks');
const LINES: LineKind[] = ['left', 'right', 'ideal'];
const LINE_FILES: Record<LineKind, string> = {
  left:  'left-edge.json',
  right: 'right-edge.json',
  ideal: 'ideal-line.json',
};

function trackDir(trackId: string): string {
  return path.join(TRACKS_ROOT, trackId);
}

function die(msg: string): never {
  process.stderr.write(`\x1b[31mError:\x1b[0m ${msg}\n`);
  process.exit(1);
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name('record')
  .description('GT7 track line recorder')
  .version('0.1.0');

// ── record ────────────────────────────────────────────────────────────────────

program
  .command('record')
  .description('Record one edge/line for a track (exactly 1 lap)')
  .requiredOption('--track <id>', 'track identifier, e.g. trial-mountain')
  .requiredOption('--line <type>', 'line to record: left | right | ideal')
  .requiredOption('--driver <id>', 'driver ID (number)', parseInt)
  .option('--url <url>', 'relay overlay WebSocket URL', 'ws://localhost:3000/overlay')
  .action((opts: { track: string; line: string; driver: number; url: string }) => {
    if (!(['left', 'right', 'ideal'] as string[]).includes(opts.line)) {
      die(`--line must be left, right, or ideal (got "${opts.line}")`);
    }
    const line = opts.line as LineKind;
    const outputDir = trackDir(opts.track);

    process.stdout.write(`\x1b[1mGT7 Track Recorder\x1b[0m\n`);
    process.stdout.write(`  Track  : \x1b[33m${opts.track}\x1b[0m\n`);
    process.stdout.write(`  Line   : \x1b[33m${line}\x1b[0m\n`);
    process.stdout.write(`  Driver : \x1b[33m${opts.driver}\x1b[0m\n`);
    process.stdout.write(`  Server : \x1b[2m${opts.url}\x1b[0m\n\n`);
    process.stdout.write(`Connecting...\n`);

    const recorder = createRecorder({ trackId: opts.track, line, driverId: opts.driver, outputDir });

    recorder.onDone((file) => {
      process.stdout.write(`\n\x1b[32mDone!\x1b[0m ${file.sampleCount} samples recorded.\n`);
      ws.close();
      process.exit(0);
    });

    recorder.onDiscard(() => {
      // recorder already printed the discard message; nothing extra needed
    });

    const ws = connectOverlay(
      opts.url,
      (msg) => recorder.handleState(msg),
      (err) => {
        recorder.destroy();
        die(`Connection failed: ${err.message}\n  Is the relay server running at ${opts.url}?`);
      },
      () => {
        recorder.destroy();
        process.stderr.write('\n\x1b[31mServer disconnected.\x1b[0m\n');
        process.exit(1);
      },
    );

    ws.once('open', () => {
      process.stdout.write(`\x1b[32mConnected.\x1b[0m Waiting for driver ${opts.driver}...\n\n`);
    });
  });

// ── process ───────────────────────────────────────────────────────────────────

program
  .command('process')
  .description('Compute track geometry and place sector boundaries from all 3 recorded lines + sector times')
  .requiredOption('--track <id>', 'track identifier')
  .requiredOption(
    '--times <ms1,ms2,...>',
    'sector times in ms from the ideal-line recording lap (e.g. 28451,15023,18204)',
  )
  .action((opts: { track: string; times: string }) => {
    const times = opts.times.split(',').map((s) => parseInt(s.trim(), 10));
    if (times.some((t) => isNaN(t) || t <= 0)) {
      die('--times must be comma-separated positive integers (milliseconds)');
    }
    if (times.length < 2) {
      die('--times needs at least 2 values (one per sector)');
    }
    const outputDir = trackDir(opts.track);
    const totalMs   = times.reduce((a, b) => a + b, 0);

    try {
      const track     = computeTrack({ trackId: opts.track, sectorTimesMs: times, outputDir });
      const trackPath = path.join(outputDir, 'track.json');
      process.stdout.write(`\x1b[32m✓ Track processed:\x1b[0m ${trackPath}\n`);
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
      die((err as Error).message);
    }
  });

// ── info ──────────────────────────────────────────────────────────────────────

program
  .command('info')
  .description('Show recording status for a track')
  .requiredOption('--track <id>', 'track identifier')
  .action((opts: { track: string }) => {
    const outputDir = trackDir(opts.track);
    process.stdout.write(`\x1b[1mTrack: ${opts.track}\x1b[0m\n\n`);

    let allPresent = true;
    for (const line of LINES) {
      const p = path.join(outputDir, LINE_FILES[line]);
      const exists = fs.existsSync(p);
      if (!exists) allPresent = false;
      process.stdout.write(`  ${exists ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${LINE_FILES[line]}\n`);
    }

    const trackPath = path.join(outputDir, 'track.json');
    if (fs.existsSync(trackPath)) {
      const track = JSON.parse(fs.readFileSync(trackPath, 'utf-8')) as ComputedTrack;
      const totalMs = track.sectorTimesMs?.reduce((a, b) => a + b, 0) ?? 0;
      process.stdout.write(`\n  \x1b[32m✓\x1b[0m track.json\n`);
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
      process.stdout.write(
        `\n  \x1b[33m○\x1b[0m Not processed yet — run: yarn record process --track ${opts.track} --times <ms1,ms2,...>\n`,
      );
    } else {
      process.stdout.write(
        `\n  Record all 3 lines first, then run: yarn record process --track ${opts.track} --times <ms1,ms2,...>\n`,
      );
    }
    process.stdout.write('\n');
  });

// ── test-sectors ──────────────────────────────────────────────────────────────

program
  .command('test-sectors')
  .description('Drive and compare tool-computed sector crossings against game-displayed times')
  .requiredOption('--track <id>', 'track identifier')
  .requiredOption('--driver <id>', 'driver ID to watch', parseInt)
  .option('--url <url>', 'relay overlay WebSocket URL', 'ws://localhost:3000/overlay')
  .action((opts: { track: string; driver: number; url: string }) => {
    const outputDir = trackDir(opts.track);
    const trackPath = path.join(outputDir, 'track.json');

    if (!fs.existsSync(trackPath)) {
      die(`No track.json found — run: yarn record process --track ${opts.track} --times <ms1,ms2,...>`);
    }

    const track = JSON.parse(fs.readFileSync(trackPath, 'utf-8')) as ComputedTrack;

    process.stdout.write(`\x1b[1mGT7 Sector Tester\x1b[0m\n`);
    process.stdout.write(`  Track  : \x1b[33m${opts.track}\x1b[0m  (${track.sectorCount} sectors)\n`);
    process.stdout.write(`  Driver : \x1b[33m${opts.driver}\x1b[0m\n`);
    process.stdout.write(`  Server : \x1b[2m${opts.url}\x1b[0m\n\n`);
    process.stdout.write(`Connecting...\n`);

    startSectorTester({ url: opts.url, track, driverId: opts.driver });
  });

// ── monitor ───────────────────────────────────────────────────────────────────

program
  .command('monitor')
  .description('Live packet viewer — inspect telemetry arriving from drivers')
  .option('--url <url>', 'relay overlay WebSocket URL', 'ws://localhost:3000/overlay')
  .option('--driver <id>', 'show only this driver ID', parseInt)
  .option('--raw', 'dump raw JSON instead of formatted view', false)
  .action((opts: { url: string; driver?: number; raw: boolean }) => {
    startMonitor({ url: opts.url, raw: opts.raw, driverId: opts.driver });
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all recorded tracks')
  .action(() => {
    if (!fs.existsSync(TRACKS_ROOT)) {
      process.stdout.write('No tracks recorded yet.\n');
      return;
    }
    const entries = fs.readdirSync(TRACKS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    if (entries.length === 0) {
      process.stdout.write('No tracks recorded yet.\n');
      return;
    }

    process.stdout.write('\x1b[1mRecorded tracks:\x1b[0m\n\n');
    for (const id of entries) {
      const dir = path.join(TRACKS_ROOT, id);
      const lines = LINES.filter((l) => fs.existsSync(path.join(dir, LINE_FILES[l]))).length;
      const trackPath = path.join(dir, 'track.json');
      let status: string;
      if (fs.existsSync(trackPath)) {
        status = '\x1b[32mprocessed\x1b[0m';
      } else {
        status = lines === 3
          ? '\x1b[33mready to process\x1b[0m'
          : `\x1b[2m${lines}/3 lines recorded\x1b[0m`;
      }
      process.stdout.write(`  ${id.padEnd(24)} ${status}\n`);
    }
    process.stdout.write('\n');
  });

// ── Parse ─────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: Error) => {
  die(err.message);
});
