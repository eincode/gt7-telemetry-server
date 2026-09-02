import type { Request, Response } from "express";
import * as sectorTracker from "../../../sector-tracker";
import * as session from "../../../session";
import { loadTrack } from "../../../track";
import { onRaceStart } from "../../shared";

export default function handler(req: Request, res: Response) {
  const s = session.getSession();
  if (!s) {
    res.status(400).json({ error: "no active session" });
    return;
  }

  const { trackId } = req.body as { trackId?: unknown };
  if (typeof trackId !== "string" || trackId.trim() === "") {
    res.status(400).json({ error: "trackId (string) required" });
    return;
  }

  if (!s.isRecording) {
    try {
      loadTrack(trackId.trim());
      onRaceStart(trackId.trim());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    sectorTracker.clearAll();
  }

  session.setTrackId(trackId.trim());
  res.json({ ok: true, trackId: trackId.trim() });
}
