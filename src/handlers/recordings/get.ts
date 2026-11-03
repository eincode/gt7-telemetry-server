import type { Request, Response } from "express";
import * as packetRecorder from "../../replay/recorder";
import { isValidName, listRuns } from "../../replay/storage";

// ?trackId=<id> limits the saved-run list to one track.
export default function handler(req: Request, res: Response) {
  const { trackId } = req.query;
  if (trackId !== undefined && !isValidName(trackId)) {
    res.status(400).json({ error: "invalid trackId" });
    return;
  }
  res.json({ armed: packetRecorder.status(), runs: listRuns(trackId) });
}
