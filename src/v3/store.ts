import { createStore } from "zustand/vanilla";
import {
  Driver,
  DriverID,
  DriverTelemetry,
  SessionMode,
  SessionState,
} from "./state/session-state";

type State = {
  session: SessionState;
  driverTelemetries: Map<DriverID, DriverTelemetry>;
};

type Action = {
  // createSession: (trackId: TrackID, drivers: Driver[]) => void;
  addDriver: (driver: Driver) => void;
};

const store = createStore<State & Action>((set, get) => ({
  session: { mode: SessionMode.IDLE },
  driverTelemetries: new Map(),
  // createSession: (trackId, drivers) => {
  //   if (get().session.mode !== SessionMode.IDLE) {
  //     console.warn("Operation createSession is not allowed");
  //     return;
  //   }
  //   set(() => ({
  //     session: {
  //       mode: SessionMode.FREE_PRACTICE,
  //       drivers: new Map(drivers.map((driver) => [driver.id, driver])),
  //       trackId,
  //       practiceTrackState: {
  //         standings: drivers.map((driver) => driver.id),
  //         driverStates: new Map(),
  //       },
  //     },
  //   }));
  // },
  addDriver: (driver) => {
    const session = get().session;
    if (session.mode === SessionMode.IDLE) {
      console.warn("Operation addDriver is not allowed");
      return;
    }
    const newMap = new Map(session.drivers);
    newMap.set(driver.id, driver);
    set(() => ({
      session: {
        ...get().session,
        drivers: newMap,
      },
    }));
  },
}));

export { store };
