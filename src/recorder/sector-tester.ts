import * as readline from 'readline';
import type { StateBroadcast } from '../types';
import type { ComputedTrack, Vec3, SectorBoundary } from './types';
import { connectOverlay } from './overlay-client';

// ── Vec3 math ─────────────────────────────────────────────────────────────────

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function signedDist(carPos: Vec3, b: SectorBoundary): number {
  return dot3(sub3(carPos, b.position), b.normal);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms < 0) return '--:--.---';
  const m   = Math.floor(ms / 60000);
  const s   = Math.floor((ms % 60000) / 1000);
  const mil = ms % 1000;
  const sss = `${String(s).padStart(2, '0')}.${String(mil).padStart(3, '0')}`;
  return m > 0 ? `${m}:${sss}` : sss;
}

function fmtDelta(ms: number): string {
  const sign = ms >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}

function bar(fraction: number, width = 28): string {
  const filled = Math.min(width, Math.round(Math.max(0, Math.min(1, fraction)) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── ANSI ──────────────────────────────────────────────────────────────────────

const C = {
  clear:  '\x1b[2J\x1b[H',
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface LapResult {
  lapNum: number;
  toolSectorMs: number[];
  gameSectorMs: number[];   // user-entered seconds → converted to ms
}

export interface SectorTesterOpts {
  url: string;
  track: ComputedTrack;
  driverId: number;
}

// ── Main entry ────────────────────────────────────────────────────────────────

export function startSectorTester(opts: SectorTesterOpts): void {
  const { track, driverId } = opts;
  const { sectorCount, sectorBoundaries } = track;

  // ── Mutable state ──────────────────────────────────────────────────────────
  let lapNum          = 0;
  let currentSector   = 0;
  let sectorStartLapT = 0;
  let lapSectors: number[] = [];   // ms for each completed sector in current lap
  let prevLapCount: number | null = null;
  let prevSign: number | null = null;
  let prevLapT: number | null = null;
  let currentLapT     = 0;
  let bestLaptimeRef  = 0;
  const lapHistory: LapResult[] = [];
  let inputMode = false;

  // ── Render ─────────────────────────────────────────────────────────────────

  function render(): void {
    if (inputMode) return;

    const cols = Math.max(72, process.stdout.columns ?? 80);
    const div  = C.dim('─'.repeat(cols));
    let out    = C.clear;

    out += C.bold('GT7 Sector Tester');
    out += `  ${C.dim(track.id)}  ${C.dim('(' + sectorCount + ' sectors)')}\n`;
    out += div + '\n\n';

    if (lapNum === 0) {
      out += C.dim('  Waiting for first lap...\n');
    } else {
      const ref     = bestLaptimeRef > 0 ? bestLaptimeRef : 120_000;
      const lapFrac = Math.min(1, currentLapT / ref);

      out += `  Lap ${C.cyan(String(lapNum))}  ${C.dim('[' + bar(lapFrac) + ']')}  ${C.cyan(fmtMs(currentLapT))}\n\n`;

      out += `  ${'Sector'.padEnd(8)} ${'Tool time'.padStart(11)}  Status\n`;
      out += `  ${'──────'.padEnd(8)} ${'──────────'.padStart(11)}  ──────────\n`;

      for (let s = 0; s < sectorCount; s++) {
        if (s < lapSectors.length) {
          out += `  S${s + 1}      ${fmtMs(lapSectors[s]).padStart(11)}  ${C.green('✓')}\n`;
        } else if (s === currentSector) {
          const elapsed = currentLapT - sectorStartLapT;
          out += `  S${s + 1}      ${C.cyan(fmtMs(elapsed).padStart(11))}  ${C.yellow('▶ current')}\n`;
        } else {
          out += `  S${s + 1}      ${'--:--.---'.padStart(11)}\n`;
        }
      }
    }

    out += '\n' + div + '\n';

    if (lapHistory.length > 0) {
      out += '\n' + C.bold('  Completed laps:') + '\n\n';

      let hdr = `  ${'Lap'.padEnd(5)}`;
      for (let s = 0; s < sectorCount; s++) {
        hdr += ` ${'S' + (s + 1) + ' Tool'.padEnd(12)} ${'S' + (s + 1) + ' Game'.padEnd(12)} ${'Δ'.padEnd(10)}`;
      }
      out += hdr + '\n';
      out += '  ' + C.dim('─'.repeat(Math.max(0, cols - 2))) + '\n';

      for (const lap of lapHistory.slice(-6)) {
        let row = `  ${String(lap.lapNum).padEnd(5)}`;
        for (let s = 0; s < sectorCount; s++) {
          const tool  = lap.toolSectorMs[s];
          const game  = lap.gameSectorMs[s];
          const delta = game != null ? tool - game : null;

          const toolStr  = tool != null ? fmtMs(tool) : '---------';
          const gameStr  = game != null ? fmtMs(game) : '   ---   ';
          const deltaStr = delta != null
            ? (delta > 0 ? C.red(fmtDelta(delta)) : delta < 0 ? C.green(fmtDelta(delta)) : C.dim('+0.000s'))
            : '   ---   ';

          row += ` ${toolStr.padEnd(12)} ${gameStr.padEnd(12)} ${deltaStr.padEnd(10)}`;
        }
        out += row + '\n';
      }
    }

    out += '\n' + C.dim('  Ctrl+C to exit  •  After each lap, enter game sector times when prompted');

    process.stdout.write(out);
  }

  // ── Prompt for game times after a completed lap ────────────────────────────

  function promptGameTimes(finishedNum: number, toolSectors: number[]): void {
    inputMode = true;

    process.stdout.write('\n\n');
    process.stdout.write(C.bold(`  Lap ${finishedNum} complete!`) + '\n');
    process.stdout.write(`  Tool: ${toolSectors.map(fmtMs).join('  ')}`);
    process.stdout.write(`  (total ${fmtMs(toolSectors.reduce((a, b) => a + b, 0))})\n\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      C.dim('  Game sector times in seconds (e.g. 28.451,15.023,18.204), or Enter to skip: '),
      (answer) => {
        rl.close();

        let gameSectorMs: number[] = [];
        if (answer.trim()) {
          gameSectorMs = answer
            .trim()
            .split(',')
            .map((s) => Math.round(parseFloat(s.trim()) * 1000))
            .filter((n) => !isNaN(n) && n > 0);
        }

        lapHistory.push({ lapNum: finishedNum, toolSectorMs: [...toolSectors], gameSectorMs });
        inputMode = false;
      },
    );
  }

  // ── WebSocket message handler ──────────────────────────────────────────────

  connectOverlay(
    opts.url,
    (msg: StateBroadcast) => {
      const d = msg.drivers[driverId];
      if (!d?.telemetry) return;

      const t      = d.telemetry;
      const carPos = t.position as Vec3;
      currentLapT  = t.currentLap;

      if (t.bestLaptime > 0) bestLaptimeRef = t.bestLaptime;

      // ── Lap change ─────────────────────────────────────────────────────────
      if (prevLapCount !== null && t.lapCount > prevLapCount) {
        // Finalize last sector using the game's total lap time
        if (t.lastLaptime > 0 && t.lastLaptime < 600_000) {
          const lastSectorMs = t.lastLaptime - sectorStartLapT;
          if (lastSectorMs > 0) lapSectors.push(lastSectorMs);
        }

        const finishedNum     = lapNum;
        const finishedSectors = [...lapSectors];

        lapNum++;
        currentSector   = 0;
        sectorStartLapT = 0;
        lapSectors      = [];
        prevSign        = null;
        prevLapT        = null;

        if (finishedSectors.length === sectorCount) {
          promptGameTimes(finishedNum, finishedSectors);
        } else if (finishedSectors.length > 0) {
          // Partial lap (connected mid-lap) — record without prompting
          lapHistory.push({ lapNum: finishedNum, toolSectorMs: finishedSectors, gameSectorMs: [] });
        }
      } else if (prevLapCount === null) {
        lapNum = t.lapCount > 0 ? t.lapCount : 1;
      }
      prevLapCount = t.lapCount;

      // ── Sector crossing ────────────────────────────────────────────────────
      if (!inputMode && currentSector < sectorBoundaries.length) {
        const boundary = sectorBoundaries[currentSector];
        const sd       = signedDist(carPos, boundary);

        if (prevSign === null) {
          prevSign = sd;
          prevLapT = currentLapT;
        } else if (prevSign < 0 && sd >= 0) {
          // Interpolate the exact crossing moment within the inter-packet interval.
          // At prevLapT the signed distance was prevSign (<0); now it's sd (≥0).
          // The zero crossing happened at fraction f = |prevSign| / (|prevSign| + sd).
          const f           = Math.abs(prevSign) / (Math.abs(prevSign) + sd);
          const crossingLapT = (prevLapT ?? currentLapT) + f * (currentLapT - (prevLapT ?? currentLapT));

          lapSectors.push(crossingLapT - sectorStartLapT);
          sectorStartLapT = crossingLapT;
          currentSector++;
          prevSign = null;
          prevLapT = null;
        } else {
          prevSign = sd;
          prevLapT = currentLapT;
        }
      }

      render();
    },
    (err) => {
      process.stderr.write(C.red(`\nConnection error: ${err.message}\n`));
      process.stderr.write(C.dim(`Is the relay server running at ${opts.url}?\n`));
      process.exit(1);
    },
    () => {
      process.stderr.write(C.red('\nServer disconnected.\n'));
      process.exit(1);
    },
  );

  // ── Shutdown summary ───────────────────────────────────────────────────────

  process.on('SIGINT', () => {
    const cols = Math.max(72, process.stdout.columns ?? 80);
    process.stdout.write('\n\n' + '─'.repeat(cols) + '\n');
    process.stdout.write(C.bold('Session summary\n\n'));

    if (lapHistory.length === 0) {
      process.stdout.write('  No complete laps recorded.\n');
    } else {
      for (const lap of lapHistory) {
        const total = lap.toolSectorMs.reduce((a, b) => a + b, 0);
        process.stdout.write(`  Lap ${lap.lapNum}  (total: ${fmtMs(total)})\n`);
        for (let s = 0; s < lap.toolSectorMs.length; s++) {
          const tool  = lap.toolSectorMs[s];
          const game  = lap.gameSectorMs[s];
          const delta = game != null ? tool - game : null;
          const deltaStr = delta != null ? `  Δ ${fmtDelta(delta)}` : '';
          process.stdout.write(
            `    S${s + 1}  tool: ${fmtMs(tool)}  game: ${game != null ? fmtMs(game) : '   ---   '}${deltaStr}\n`,
          );
        }
        process.stdout.write('\n');
      }
    }

    process.stdout.write('Sector tester stopped.\n');
    process.exit(0);
  });
}
