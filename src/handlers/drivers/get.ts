import type { Request, Response } from "express";
import * as drivers from "../../drivers";
import * as session from "../../session";

export default function handler(_req: Request, res: Response) {
  const s = session.getSession();
  if (!s) {
    res.json({ drivers: [] });
    return;
  }

  const stateMap = new Map(drivers.getAllDrivers().map((d) => [d.id, d]));
  res.json({
    drivers: s.roster.map((entry) => {
      const d = stateMap.get(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        country: entry.country,
        carCode: d?.telemetry?.carCode ?? 0,
        connected: d?.connected ?? false,
        lastSeen: d?.lastSeen ?? 0,
      };
    }),
  });
}
