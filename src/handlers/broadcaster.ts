import { broadcast, clientCount } from "../broadcaster";
import * as drivers from "../drivers";
import * as overlayState from "../overlay-state";
import { buildDriverBroadcasts, buildRaceState } from "../processor";
import * as session from "../session";
import { StandingsRow } from "../v2/gap-engine";
import { getGapEngine } from "./shared";

export function startBroadcastLoop(broadcastHz: number) {
  let standingsV2: StandingsRow[] = [];
  setInterval(() => {
    const all = drivers.getAllDrivers();
    const gapEngine = getGapEngine();

    const driverMap = new Map(
      all.map((driver) => [
        String(driver.id),
        driver.telemetry?.RaceStartPosition ?? 999,
      ]),
    );

    standingsV2 = gapEngine?.standings(driverMap) ?? [];
  }, 100);
  setInterval(
    () => {
      if (clientCount() === 0) return;
      const all = drivers.getAllDrivers();
      // if (all.length === 0) return;
      const mode = session.getSession()?.mode ?? "practice";
      // Moved onPacket calculation to driverWss onMessage
      // const timestamp = performance.now() / 1000;
      // const gapEngine = getGapEngine();
      // all.forEach((driver) => {
      //   if (!driver.telemetry) return;
      //   gapEngine?.onPacket(
      //     String(driver.id),
      //     {
      //       position: driver.telemetry?.position,
      //       speed: driver.telemetry?.speed,
      //       lapCount: driver.telemetry?.lapCount,
      //       currentLap: driver.telemetry.currentLap,
      //       totalLaps: driver.telemetry.totalLaps,
      //     },
      //     timestamp,
      //     mode,
      //   );
      // });
      // const driverMap = new Map(
      //   all.map((driver) => [
      //     String(driver.id),
      //     driver.telemetry?.RaceStartPosition ?? 999,
      //   ]),
      // );

      broadcast({
        type: "state",
        drivers: buildDriverBroadcasts(all, mode),
        raceState: buildRaceState(all, mode),
        overlayState: overlayState.getOverlayState(),
        standingsV2,
      });
    },
    Math.round(1000 / broadcastHz),
  );
}
