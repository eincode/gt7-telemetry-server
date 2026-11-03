import type { Request, Response } from "express";
import * as packetRecorder from "../../../replay/recorder";

// Body { driverId } cancels one driver; an empty body cancels all.
export default function handler(req: Request, res: Response) {
  const { driverId } = (req.body ?? {}) as { driverId?: unknown };
  if (driverId === undefined) {
    res.json({ ok: true, cancelled: packetRecorder.cancelAll() });
    return;
  }
  if (typeof driverId !== "number") {
    res.status(400).json({ error: "driverId must be a number" });
    return;
  }
  if (!packetRecorder.cancel(driverId)) {
    res.status(404).json({ error: "driver is not armed" });
    return;
  }
  res.json({ ok: true, cancelled: 1 });
}
