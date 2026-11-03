import type { Request, Response } from "express";
import * as replay from "../../../replay/player";
import * as packetRecorder from "../../../replay/recorder";
import { isValidName } from "../../../replay/storage";
import * as session from "../../../session";

export default function handler(req: Request, res: Response) {
  const s = session.getSession();
  if (!s) {
    res.status(400).json({ error: "no active session" });
    return;
  }
  if (replay.isRunning()) {
    res.status(409).json({ error: "a replay is running — stop it first" });
    return;
  }
  if (!isValidName(s.trackId)) {
    res.status(400).json({ error: "session has no usable trackId" });
    return;
  }

  const { driverId, label } = req.body as { driverId?: unknown; label?: unknown };
  if (typeof driverId !== "number") {
    res.status(400).json({ error: "driverId (number) required" });
    return;
  }
  if (!s.roster.some((r) => r.id === driverId)) {
    res.status(404).json({ error: "driver not in roster" });
    return;
  }
  if (!isValidName(label)) {
    res.status(400).json({
      error: "label required: letters, digits, - and _ only (e.g. \"RS\")",
    });
    return;
  }

  res.status(201).json({ armed: packetRecorder.arm(driverId, label, s.trackId) });
}
