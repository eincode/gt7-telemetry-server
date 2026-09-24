import { DriverProgress } from "../../v2/driver-progress";
import { TrackRuler } from "../../v2/track-ruler";

export type DriverID = string;
export type TrackID = string;

export interface Driver {
  id: DriverID;
  name: string;
  gameUsername: string;
  photoInBase64: string;
  isConnected: boolean;
}

interface QualifyingResult {
  driverId: DriverID;
  carName: string;
  bestLapTimeInMs: number;
}

interface RaceResult {
  driverID: DriverID;
  carName: string;
  bestLapTimeInMs: number;
  totalTimeInMs: number;
}

export enum SessionMode {
  IDLE = "idle",
  FREE_PRACTICE = "free-practice",
  QUALIFYING = "qualifying",
  POST_QUALIFYING = "post-qualifying",
  ENDURANCE = "endurance",
  RACE = "race",
  POST_RACE = "post-race",
}

export type SessionState =
  | {
      mode: SessionMode.IDLE;
    }
  | {
      mode: SessionMode.FREE_PRACTICE;
      trackId: TrackID;
      trackRuler: TrackRuler;
      drivers: Map<DriverID, Driver>;
      practiceTrackState: QualifyingState;
    }
  | {
      mode: SessionMode.QUALIFYING;
      trackId: TrackID;
      trackRuler: TrackRuler;
      drivers: Map<DriverID, Driver>;
      qualifyingTrackState: QualifyingState;
    }
  | {
      mode: SessionMode.POST_QUALIFYING;
      trackId: TrackID;
      trackRuler: TrackRuler;
      standings: DriverID[];
      drivers: Map<DriverID, Driver>;
      results: Map<DriverID, QualifyingResult>;
    }
  | {
      mode: SessionMode.ENDURANCE;
      trackId: TrackID;
      trackRuler: TrackRuler;
      drivers: Map<DriverID, Driver>;
      enduranceTrackState: EnduranceState;
    }
  | {
      mode: SessionMode.RACE;
      trackId: TrackID;
      trackRuler: TrackRuler;
      drivers: Map<DriverID, Driver>;
      raceTrackState: RaceState;
    }
  | {
      mode: SessionMode.POST_RACE;
      trackId: TrackID;
      trackRuler: TrackRuler;
      drivers: Map<DriverID, Driver>;
      standings: DriverID[];
      results: Map<DriverID, RaceResult>;
    };

export interface QualifyingDriverState {
  carName: string;
  position: number;
  isOutlap: boolean;
  currentSectorIndex: number;
  currentLapTimeInMs: number;
  bestLapTimeInMs: number;
  bestLapSectorTimesInMs: number[];
  currentLapSectorTimesInMs: number[];
  currentSectorTimeInMs: number;
  driverProgress: DriverProgress;
}

export type QualifyingState = {
  standings: DriverID[];
  driverStates: Map<DriverID, QualifyingDriverState>;
};

interface RaceDriverState {
  carName: string;
  position: number;
  gapToFrontInMs: number;
  gapToLeaderInMs: number;
  currentSectorIndex: number;
  currentLapCount: number;
  bestLaptimeInMs: number;
  currentLaptimeInMs: number;
  currentSectorTimeInMs: number;
  bestLapSectorTimesInMs: number[];
  currentLapSectorTimesInMs: number[];
  totalTimeInMs: number;
  driverProgress: DriverProgress;
}

type EnduranceState = Omit<RaceState, "totalLap">;

export interface RaceState {
  currentLap: number;
  totalLap: number;
  isFinished: boolean;
  driverStates: Map<DriverID, RaceDriverState>;
  standings: DriverID[];
}

interface TyreTemp {
  fL: number;
  fR: number;
  rL: number;
  rR: number;
}

export interface DriverTelemetry {
  throttlePercent: number;
  brakePercent: number;
  steeringWheelAngle: number;
  tyreTemp: TyreTemp;
  rpm: number;
  minAlertRpm: number;
  maxAlertRpm: number;
  speed: number;
}
