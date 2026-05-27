import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { LineKind, PositionSample, RecordingFile, RecorderPhase } from './types';
import type { StateBroadcast } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecorderOpts {
  trackId: string;
  line: LineKind;
  driverId: number;
  outputDir: string;
}

interface RecorderHandle {
  handleState: (msg: StateBroadcast) => void;
  onDone: (cb: (file: RecordingFile) => void) => void;
  onDiscard: (cb: () => void) => void;
  destroy: () => void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createRecorder(opts: RecorderOpts): RecorderHandle {
  let phase: RecorderPhase = 'waiting';
  let lapCountBaseline: number | null = null;
  let samples: PositionSample[] = [];
  let recordingStartWall = 0;

  let doneCb: ((file: RecordingFile) => void) | null = null;
  let discardCb: (() => void) | null = null;
  let rl: readline.Interface | null = null;

  function setupReadline(): void {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      if (phase === 'recording' && line.trim().toLowerCase() === 'd') {
        phase = 'waiting';
        samples = [];
        lapCountBaseline = null;
        rl?.close();
        rl = null;
        process.stdout.write('\n\x1b[33mLap discarded.\x1b[0m Waiting for next lap...\n');
        discardCb?.();
      }
    });
  }

  function finalize(): void {
    rl?.close();
    rl = null;

    const durationMs = Date.now() - recordingStartWall;
    const filename = opts.line === 'ideal' ? 'ideal-line.json' : `${opts.line}-edge.json`;
    const file: RecordingFile = {
      trackId: opts.trackId,
      line: opts.line,
      recordedAt: new Date().toISOString(),
      durationMs,
      sampleCount: samples.length,
      samples,
    };

    fs.mkdirSync(opts.outputDir, { recursive: true });
    const outPath = path.join(opts.outputDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(file, null, 2));
    process.stdout.write(`\n\x1b[32m✓ Lap saved:\x1b[0m ${outPath}\n`);
    process.stdout.write(`  ${file.sampleCount} samples over ${(durationMs / 1000).toFixed(1)}s\n`);

    doneCb?.(file);
  }

  function handleState(msg: StateBroadcast): void {
    if (phase === 'done') return;

    const driver = msg.drivers[opts.driverId];
    if (!driver) {
      if (phase === 'waiting' && lapCountBaseline === null) {
        process.stdout.write(`\r\x1b[33mWaiting for driver ${opts.driverId} to appear...\x1b[0m`);
      }
      return;
    }
    if (!driver.connected || !driver.telemetry) return;

    const { position, lapCount, currentLap } = driver.telemetry;
    if (!position) return;

    const [x, y, z] = position;

    // ── waiting: set baseline on first frame, start recording when lapCount increases ──
    if (phase === 'waiting') {
      if (lapCountBaseline === null) {
        lapCountBaseline = lapCount;
        process.stdout.write(`\r\x1b[33mWaiting for new lap to begin...\x1b[0m  [d + Enter to discard once recording]\n`);
        return;
      }
      if (lapCount > lapCountBaseline) {
        phase = 'recording';
        samples = [{ t: 0, lapT: currentLap, x, y, z }];
        recordingStartWall = Date.now();
        lapCountBaseline = lapCount;
        process.stdout.write(`\x1b[32m▶ Recording started\x1b[0m  (lap ${lapCount})  Type 'd' + Enter to discard.\n`);
        setupReadline();
      }
      return;
    }

    // ── recording: collect samples, stop when lap turns over ──
    if (phase === 'recording') {
      samples.push({ t: Date.now() - recordingStartWall, lapT: currentLap, x, y, z });

      process.stdout.write(
        `\r  Samples: \x1b[36m${samples.length}\x1b[0m  ` +
        `Lap time: \x1b[36m${(currentLap / 1000).toFixed(1)}s\x1b[0m     `,
      );

      if (lapCount > lapCountBaseline!) {
        phase = 'done';
        finalize();
      }
    }
  }

  return {
    handleState,
    onDone:    (cb) => { doneCb = cb; },
    onDiscard: (cb) => { discardCb = cb; },
    destroy:   () => { rl?.close(); rl = null; },
  };
}
