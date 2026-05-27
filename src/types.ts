// Full incoming packet from a driver client (JSON-encoded)
export interface DriverPacket {
  // PacketA
  magic: number;
  position: [number, number, number];
  worldVelocity: [number, number, number];
  rotation: [number, number, number];
  orientationRelativeToNorth: number;
  angularVelocity: [number, number, number];
  bodyHeight: number;
  EngineRPM: number;
  iv: [number, number, number, number];
  fuelLevel: number;
  fuelCapacity: number;
  speed: number;
  boost: number;
  oilPressure: number;
  waterTemp: number;
  oilTemp: number;
  tyreTemp: [number, number, number, number];
  packetId: number;
  lapCount: number;
  totalLaps: number;
  bestLaptime: number;
  lastLaptime: number;
  dayProgression: number;
  RaceStartPosition: number;
  preRaceNumCars: number;
  minAlertRPM: number;
  maxAlertRPM: number;
  calcMaxSpeed: number;
  flags: number;
  gears: number;
  throttle: number;
  brake: number;
  roadPlane: [number, number, number];
  roadPlaneDistance: number;
  wheelRPS: [number, number, number, number];
  tyreRadius: [number, number, number, number];
  suspHeight: [number, number, number, number];
  clutch: number;
  clutchEngagement: number;
  RPMFromClutchToGearbox: number;
  transmissionTopSpeed: number;
  gearRatios: [number, number, number, number, number, number, number, number];
  carCode: number;
  // PacketB
  wheelRotation?: number;
  steeringAngularVelocity?: number;
  sway?: number;
  heave?: number;
  surge?: number;
  // PacketTilda
  throttleFiltered?: number;
  brakeFiltered?: number;
  torqueVectors?: [number, number, number, number];
  energyRecovery?: number;
  // PacketC
  surfaceType?: string;
  currentLap?: number;
  wheelSteeringAngle?: [number, number];
  wheelBase?: number;
  carCategory?: string;
}

export interface RosterEntry {
  id: number;
  carCode: number;
  name: string;
  country: string;
  flag: string;
  car: string;
  carShort: string;
  team: string;
  category: string;
}

export type SectorStatus = 'purple' | 'green' | 'red' | 'neutral';

export interface Derived {
  rank: number;
  gapToLeader: number;
  gapToAhead: number;
  sectors: number[];           // per-sector ms for the last completed lap
  sectorStatus: SectorStatus[];
  arcFraction: number;         // 0–1 position along the ideal line, for rank & visualization
  pitted: boolean;
}

export interface RaceState {
  trackId: string | null;
  sectorCount: number;
  lap: number;
  totalLaps: number;
  dayProgression: number;
  order: number[]; // driver IDs sorted by rank (index 0 = rank 1)
}

export interface Session {
  id: string;
  roster: RosterEntry[];
  status: 'waiting' | 'racing' | 'finished';
  createdAt: number;
}

// Curated telemetry fields sent to overlay per driver
export interface DriverTelemetry {
  // Standings header
  lapCount: number;
  totalLaps: number;
  dayProgression: number;
  // Car compare
  speed: number;
  EngineRPM: number;
  minAlertRPM: number;
  maxAlertRPM: number;
  gears: number;
  currentGear: number;   // decoded from gears byte
  suggestedGear: number; // decoded from gears byte
  throttle: number;
  brake: number;
  fuelLevel: number;
  fuelCapacity: number;
  tyreTemp: [number, number, number, number];
  carCategory: string;
  carCode: number;
  // Sector compare / Showcase
  bestLaptime: number;
  lastLaptime: number;
  RaceStartPosition: number;
  // Used for position tracking
  position: [number, number, number];
  currentLap: number;
}

// Per-driver payload sent to overlay
export interface DriverBroadcast {
  id: number;
  connected: boolean;
  lastSeen: number;
  telemetry: DriverTelemetry | null;
  derived: Derived;
}

export interface StateBroadcast {
  type: 'state';
  drivers: Record<number, DriverBroadcast>;
  raceState: RaceState;
}

export interface RosterBroadcast {
  type: 'roster';
  session: Session;
  roster: RosterEntry[];
}

export type OverlayMessage = StateBroadcast | RosterBroadcast;
