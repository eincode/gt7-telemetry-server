import type { Request, Response } from "express";
import { broadcast } from "../../broadcaster";
import * as drivers from "../../drivers";
import * as sectorTracker from "../../sector-tracker";
import * as session from "../../session";
import { loadTrack } from "../../track";
import type { RosterEntry, SessionMode } from "../../types";
import { MAX_DRIVERS, VALID_MODES, onRaceStart } from "../shared";

export default function handler(req: Request, res: Response) {
  const {
    roster,
    mode = "practice",
    trackId,
    isRecording = false,
  } = req.body as {
    roster?: RosterEntry[];
    mode?: unknown;
    trackId?: unknown;
    isRecording?: unknown;
  };

  if (typeof trackId !== "string" || trackId.trim() === "") {
    res.status(400).json({ error: "trackId (string) required" });
    return;
  }
  if (!Array.isArray(roster) || roster.length === 0) {
    res.status(400).json({ error: "roster array required" });
    return;
  }
  if (roster.length > MAX_DRIVERS) {
    res.status(400).json({ error: `max ${MAX_DRIVERS} drivers per session` });
    return;
  }
  for (const entry of roster) {
    if (typeof entry.id !== "number" || typeof entry.name !== "string") {
      res.status(400).json({
        error: "each roster entry must have id (number) and name (string)",
      });
      return;
    }
  }
  if (!VALID_MODES.includes(mode as SessionMode)) {
    res
      .status(400)
      .json({ error: `mode must be one of: ${VALID_MODES.join(", ")}` });
    return;
  }

  // Only load track when this is not a recording session — the track may not exist yet
  if (!isRecording) {
    try {
      loadTrack(trackId.trim());
      onRaceStart(trackId.trim());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

  drivers.clearDrivers();
  sectorTracker.clearAll();
  const normalizedRoster: RosterEntry[] = roster.map((entry) => ({
    id: entry.id,
    name: entry.name,
    country: typeof entry.country === "string" ? entry.country : "",
    psnId: typeof entry.psnId === "string" ? entry.psnId.trim() : "",
  }));
  const s = session.createSession(
    normalizedRoster,
    mode as SessionMode,
    trackId.trim(),
    isRecording === true,
  );
  broadcast({ type: "roster", session: s, roster: s.roster });
  res.status(201).json({ session: s });
}
