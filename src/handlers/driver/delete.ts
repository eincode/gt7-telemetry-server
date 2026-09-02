import type { Request, Response } from "express";
import { broadcast } from "../../broadcaster";
import * as session from "../../session";

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
  if (!s.roster.some((r) => r.id === driverId)) {
    res.status(404).json({ error: "driver not in roster" });
    return;
  }

  session.removeDriver(driverId);
  broadcast({ type: "roster", session: s, roster: s.roster });
  res.json({ ok: true });
}
