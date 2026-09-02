import type { Request, Response } from "express";
import * as drivers from "../../drivers";
import * as sectorTracker from "../../sector-tracker";
import * as session from "../../session";
import { clearTrack } from "../../track";

export default function handler(_req: Request, res: Response) {
  drivers.clearDrivers();
  sectorTracker.clearAll();
  session.endSession();
  clearTrack();
  res.json({ ok: true });
}
