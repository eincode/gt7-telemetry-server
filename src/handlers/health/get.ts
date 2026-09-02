import type { Request, Response } from "express";
import { clientCount } from "../../broadcaster";
import * as drivers from "../../drivers";
import * as session from "../../session";

export default function handler(_req: Request, res: Response) {
  const all = drivers.getAllDrivers();
  res.json({
    ok: true,
    session: session.getSession() !== null,
    drivers: {
      total: all.length,
      connected: all.filter((d) => d.connected).length,
    },
    overlayClients: clientCount(),
  });
}
