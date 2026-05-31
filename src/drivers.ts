import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import type { DriverPacket, DriverTelemetry } from './types';

export interface DriverState {
  id: number;
  carCode: number;
  token: string;
  ws: WebSocket | null;
  connected: boolean;
  lastSeen: number;
  telemetry: DriverTelemetry | null;
}

const tokenToDriverId = new Map<string, number>();
const drivers = new Map<number, DriverState>();

export function registerDriver(driverId: number): string {
  const token = uuidv4();

  const existing = drivers.get(driverId);
  if (existing?.token) tokenToDriverId.delete(existing.token);

  drivers.set(driverId, {
    id: driverId,
    carCode: 0,   // populated from first telemetry packet
    token,
    ws: null,
    connected: false,
    lastSeen: 0,
    telemetry: null,
  });
  tokenToDriverId.set(token, driverId);
  return token;
}

export function resolveToken(token: string): DriverState | null {
  const id = tokenToDriverId.get(token);
  return id !== undefined ? (drivers.get(id) ?? null) : null;
}

export function connectDriver(state: DriverState, ws: WebSocket): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.close(1001, 'replaced by new connection');
  }
  state.ws = ws;
  state.connected = true;
  state.lastSeen = Date.now();
}

export function connectDriverMock(state: DriverState): void {
  state.connected = true;
  state.lastSeen  = Date.now();
  // ws intentionally remains null — mock drivers have no WebSocket
}

export function disconnectDriver(state: DriverState): void {
  state.ws = null;
  state.connected = false;
}

export function updatePacket(state: DriverState, packet: DriverPacket): void {
  state.lastSeen = Date.now();
  state.carCode  = packet.carCode;   // promote from packet on every update
  state.telemetry = extractTelemetry(packet);
}

function extractTelemetry(p: DriverPacket): DriverTelemetry {
  return {
    lapCount: p.lapCount,
    totalLaps: p.totalLaps,
    dayProgression: p.dayProgression,
    speed: p.speed,
    EngineRPM: p.EngineRPM,
    minAlertRPM: p.minAlertRPM,
    maxAlertRPM: p.maxAlertRPM,
    gears: p.gears,
    currentGear: p.gears & 0x0f,
    suggestedGear: (p.gears >> 4) & 0x0f,
    throttle: p.throttle,
    brake: p.brake,
    fuelLevel: p.fuelLevel,
    fuelCapacity: p.fuelCapacity,
    tyreTemp: p.tyreTemp,
    carCategory: p.carCategory ?? '',
    carCode: p.carCode,
    bestLaptime: p.bestLaptime,
    lastLaptime: p.lastLaptime,
    RaceStartPosition: p.RaceStartPosition,
    position: p.position,
    currentLap: p.currentLap ?? 0,
  };
}

export function getAllDrivers(): DriverState[] {
  return Array.from(drivers.values());
}

export function clearDrivers(): void {
  for (const d of drivers.values()) {
    if (d.ws && d.ws.readyState === WebSocket.OPEN) {
      d.ws.close(1001, 'session reset');
    }
  }
  tokenToDriverId.clear();
  drivers.clear();
}
