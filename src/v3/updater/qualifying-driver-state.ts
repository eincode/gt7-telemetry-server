// export function getQualifyingDriverState(
//   telemetry: DriverTelemetry,
//   previous: QualifyingDriverState,
//   trackRuler: TrackRuler,
// ): QualifyingDriverState {
//   previous.driverProgress.update(
//     {
//       currentLap: telemetry.currentLap,
//       lapCount: telemetry.lapCount,
//       position: telemetry.position,
//       speed: telemetry.speed,
//       totalLaps: telemetry.totalLaps,
//     },
//     performance.now() / 1000,
//     "qualifying",
//   );
//   return {
//     carName: String(telemetry.carCode), // temporary,
//     position: telemetry.RaceStartPosition,
//     isOutlap: telemetry.lapCount <= 1,
//     currentSectorIndex: 0, // temporary
//     currentSectorTimeInMs: 0, // temporary
//     currentLapTimeInMs: telemetry.currentLap,
//     bestLapTimeInMs: telemetry.bestLaptime,
//   };
// }
