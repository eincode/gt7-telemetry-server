import type { StateBroadcast, RosterBroadcast, DriverBroadcast } from '../types';
import { connectOverlay } from './overlay-client';

// ── Options ───────────────────────────────────────────────────────────────────

export interface MonitorOpts {
  url: string;
  raw: boolean;
  driverId?: number;  // if set, normal mode shows only this driver; raw mode filters to this driver
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const C = {
  clear:  '\x1b[2J\x1b[H',
  reset:  '\x1b[0m',
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// ── Formatting ────────────────────────────────────────────────────────────────

function bar(value: number, max: number, width = 10): string {
  const filled = max > 0 ? Math.min(width, Math.round((Math.max(0, value) / max) * width)) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtLap(ms: number): string {
  if (ms < 0) return '--:--.---';
  const m   = Math.floor(ms / 60000);
  const s   = Math.floor((ms % 60000) / 1000);
  const mil = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(mil).padStart(3, '0')}`;
}

function fmtAge(lastSeen: number, now: number): string {
  if (lastSeen === 0) return 'never';
  const d = now - lastSeen;
  return d < 1000 ? `${d}ms` : `${(d / 1000).toFixed(1)}s`;
}

function fmtUptime(startMs: number, now: number): string {
  const s = Math.floor((now - startMs) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Normal-mode render ────────────────────────────────────────────────────────

function renderDriver(d: DriverBroadcast, name: string, now: number): string {
  const age     = fmtAge(d.lastSeen, now);
  const liveStr = d.connected
    ? C.green('● LIVE') + C.dim(`  ${age} ago`)
    : C.red('○ OFFLINE') + C.dim(`  last seen ${age} ago`);

  let out = '';
  out += `  ${C.bold(`#${d.id}`)}  ${name.padEnd(32)} ${liveStr}\n`;

  if (!d.telemetry) {
    out += C.dim('  No telemetry yet\n');
    return out;
  }

  const t          = d.telemetry;
  const speedKmh   = (t.speed * 3.6).toFixed(1);
  const thrPct     = Math.round((t.throttle / 255) * 100);
  const brkPct     = Math.round((t.brake    / 255) * 100);
  const rpmBar     = bar(t.EngineRPM, t.maxAlertRPM, 12);
  const [fl, fr, rl, rr] = t.tyreTemp;

  out += `  Speed  ${C.cyan(speedKmh.padStart(7))} km/h   `;
  out += `Gear   ${C.cyan(String(t.currentGear))}  sugg ${C.dim(String(t.suggestedGear))}   `;
  out += `Lap    ${C.cyan(`${t.lapCount}`)}/${t.totalLaps}\n`;

  out += `  RPM    ${C.cyan(String(t.EngineRPM).padStart(7))}       `;
  out += `Fuel   ${C.cyan(t.fuelLevel.toFixed(1))}/${t.fuelCapacity.toFixed(0)} L      `;
  out += `Best   ${C.cyan(fmtLap(t.bestLaptime))}\n`;

  out += `  RPM    ${C.dim('[' + rpmBar + ']')}  `;
  out += `${t.EngineRPM < t.minAlertRPM ? '' : C.yellow('SHIFT')}`.padEnd(5) + '   ';
  out += `Last   ${C.cyan(fmtLap(t.lastLaptime))}\n`;

  out += `  Thr    ${bar(t.throttle, 255)} ${String(thrPct).padStart(3)}%   `;
  out += `Brk    ${bar(t.brake,    255)} ${String(brkPct).padStart(3)}%   `;
  out += `curLap ${C.cyan((t.currentLap / 1000).toFixed(1) + 's')}\n`;

  out += `  Tyres  FL:${C.cyan(fl.toFixed(0) + '°')} `;
  out += `FR:${C.cyan(fr.toFixed(0) + '°')} `;
  out += `RL:${C.cyan(rl.toFixed(0) + '°')} `;
  out += `RR:${C.cyan(rr.toFixed(0) + '°')}\n`;

  out += `  Pos    x:${C.dim(t.position[0].toFixed(1))}  `;
  out += `y:${C.dim(t.position[1].toFixed(1))}  `;
  out += `z:${C.dim(t.position[2].toFixed(1))}\n`;

  return out;
}

function redraw(
  url: string,
  state: StateBroadcast | null,
  roster: RosterBroadcast | null,
  msgRate: number,
  connectedAt: number,
  filterDriverId: number | undefined,
): void {
  const now  = Date.now();
  const cols = Math.max(60, process.stdout.columns ?? 80);
  const div  = C.dim('─'.repeat(cols));

  let out = C.clear;

  // ── Header ─────────────────────────────────────────────────────────────────
  out += C.bold('GT7 Telemetry Monitor');
  out += `  ${C.dim(url)}  ${C.cyan(msgRate + ' msg/s')}  ${C.dim(fmtUptime(connectedAt, now) + ' connected')}\n`;

  if (roster) {
    const s = roster.session;
    out += `Session: ${C.yellow(s.status)}  •  ${s.roster.length} driver(s) in roster\n`;
  } else {
    out += C.dim('Waiting for session...\n');
  }
  out += '\n';

  if (!state) {
    out += C.dim('No state received yet...\n');
    out += '\n' + C.dim('Press Ctrl+C to exit');
    process.stdout.write(out);
    return;
  }

  // ── Drivers ────────────────────────────────────────────────────────────────
  const all = Object.values(state.drivers).sort((a, b) => a.id - b.id);
  const drivers = filterDriverId !== undefined
    ? all.filter((d) => d.id === filterDriverId)
    : all;

  if (drivers.length === 0) {
    out += C.dim('No drivers registered in this session.\n');
  }

  for (const d of drivers) {
    const entry = roster?.roster.find((r) => r.id === d.id);
    const name  = entry
      ? `${entry.name}  ${C.dim('[' + entry.country + ']')}`
      : `Driver ${d.id}`;
    out += div + '\n';
    out += renderDriver(d, name, now);
  }
  out += div + '\n';
  out += '\n' + C.dim('Ctrl+C to exit') +
    (filterDriverId !== undefined ? C.dim(`  •  showing driver ${filterDriverId} only`) : '');

  process.stdout.write(out);
}

// ── Main entry ────────────────────────────────────────────────────────────────

export function startMonitor(opts: MonitorOpts): void {
  let lastState:  StateBroadcast  | null = null;
  let lastRoster: RosterBroadcast | null = null;
  let msgCount    = 0;
  let msgRate     = 0;
  const connectedAt = Date.now();

  // ── Raw mode ───────────────────────────────────────────────────────────────
  if (opts.raw) {
    process.stdout.write(C.bold('GT7 Telemetry Monitor') + C.dim(' — raw mode') + '\n');
    process.stdout.write(C.dim(`Connecting to ${opts.url}...\n\n`));

    connectOverlay(
      opts.url,
      (msg) => {
        const now = new Date().toISOString();
        let payload: unknown = msg;

        if (opts.driverId !== undefined && msg.type === 'state') {
          const d = msg.drivers[opts.driverId];
          payload = {
            type: 'state',
            driver: d ?? null,
            raceState: msg.raceState,
          };
        }

        process.stdout.write(
          C.dim(now) + '\n' +
          JSON.stringify(payload, null, 2) + '\n' +
          C.dim('─'.repeat(60)) + '\n',
        );
      },
      (err) => {
        process.stderr.write(C.red(`Connection error: ${err.message}\n`));
        process.exit(1);
      },
      () => {
        process.stderr.write(C.red('\nServer disconnected.\n'));
        process.exit(1);
      },
    );
    return;
  }

  // ── Normal mode ───────────────────────────────────────────────────────────
  process.stdout.write(`Connecting to ${opts.url}...\n`);

  const ws = connectOverlay(
    opts.url,
    (msg) => {
      lastState = msg;
      msgCount++;
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

  // Intercept roster messages before they reach onState
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'roster') lastRoster = msg as RosterBroadcast;
    } catch { /* handled by connectOverlay */ }
  });

  ws.once('open', () => {
    process.stdout.write(C.green('Connected.\n'));

    // Msg-rate counter — ticks every second
    const rateInterval = setInterval(() => {
      msgRate  = msgCount;
      msgCount = 0;
    }, 1000);

    // Redraw at 10 fps
    const drawInterval = setInterval(() => {
      redraw(opts.url, lastState, lastRoster, msgRate, connectedAt, opts.driverId);
    }, 100);

    // Clean shutdown
    process.on('SIGINT', () => {
      clearInterval(rateInterval);
      clearInterval(drawInterval);
      ws.close();
      process.stdout.write('\n\nMonitor stopped.\n');
      process.exit(0);
    });
  });
}
