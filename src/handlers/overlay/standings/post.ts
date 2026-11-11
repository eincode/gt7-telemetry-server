import type { Request, Response } from "express";
import * as overlayState from "../../../overlay-state";
import type { StandingsSource } from "../../../types";

const SOURCES: readonly StandingsSource[] = ["game", "inferred"];

export default function handler(req: Request, res: Response) {
  const { visible, source } = req.body as { visible?: unknown; source?: unknown };
  if (visible !== undefined && typeof visible !== "boolean") {
    res.status(400).json({ error: "visible must be a boolean" });
    return;
  }
  if (source !== undefined && !SOURCES.includes(source as StandingsSource)) {
    res.status(400).json({ error: `source must be one of: ${SOURCES.join(", ")}` });
    return;
  }
  const patch: Parameters<typeof overlayState.setStandings>[0] = {};
  if (visible !== undefined) patch.visible = visible as boolean;
  if (source !== undefined) patch.source = source as StandingsSource;
  res.json({ ok: true, overlayState: overlayState.setStandings(patch) });
}
