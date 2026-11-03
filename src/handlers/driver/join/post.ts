import type { Request, Response } from "express";
import * as drivers from "../../../drivers";
import * as session from "../../../session";

export default function handler(req: Request, res: Response) {
  const s = session.getSession();
  if (!s) {
    res.status(400).json({ error: "no active session" });
    return;
  }

  const { driverId } = req.body as { driverId?: unknown };
  if (typeof driverId !== "number") {
    res.status(400).json({ error: "driverId (number) required" });
    return;
  }

  const entry = s.roster.find((r) => r.id === driverId);
  if (!entry) {
    res.status(404).json({ error: "driver not in roster" });
    return;
  }

  const token = drivers.registerDriver(driverId);
  res.json({ token, driverId, name: entry.name, psnId: entry.psnId });
}
