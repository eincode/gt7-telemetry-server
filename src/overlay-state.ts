import type {
  OverlayState,
  StandingsOverlay,
  SectorOverlay,
  CarTelemetryOverlay,
  DriverShowcaseOverlay,
} from './types';

// ── Singleton state ───────────────────────────────────────────────────────────

let _state: OverlayState = {
  standings:      { visible: false },
  sector:         { visible: false, driverIds: [] },
  carTelemetry:   { visible: false, driverIds: [] },
  driverShowcase: { visible: false, driverId: null },
};

// ── Snapshot (deep-enough copy to prevent external mutation) ──────────────────

export function getOverlayState(): OverlayState {
  return {
    standings:      { ..._state.standings },
    sector:         { ..._state.sector,       driverIds: [..._state.sector.driverIds] },
    carTelemetry:   { ..._state.carTelemetry, driverIds: [..._state.carTelemetry.driverIds] },
    driverShowcase: { ..._state.driverShowcase },
  };
}

// ── Per-overlay setters ───────────────────────────────────────────────────────

export function setStandings(patch: Partial<StandingsOverlay>): OverlayState {
  _state.standings = { ..._state.standings, ...patch };
  return getOverlayState();
}

export function setSector(patch: Partial<SectorOverlay>): OverlayState {
  _state.sector = {
    ..._state.sector,
    ...patch,
    driverIds: patch.driverIds ? [...patch.driverIds] : _state.sector.driverIds,
  };
  return getOverlayState();
}

export function setCarTelemetry(patch: Partial<CarTelemetryOverlay>): OverlayState {
  _state.carTelemetry = {
    ..._state.carTelemetry,
    ...patch,
    driverIds: patch.driverIds ? [...patch.driverIds] : _state.carTelemetry.driverIds,
  };
  return getOverlayState();
}

export function setDriverShowcase(patch: Partial<DriverShowcaseOverlay>): OverlayState {
  _state.driverShowcase = { ..._state.driverShowcase, ...patch };
  return getOverlayState();
}
