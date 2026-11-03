import type { Request, Response } from "express";
import * as replay from "../../../replay/player";
import { isValidName } from "../../../replay/storage";
import { MAX_DRIVERS } from "../../shared";

export default function handler(req: Request, res: Response) {
  if (process.env.MOCK === "true") {
    res.status(409).json({ error: "replay is unavailable while MOCK=true" });
    return;
  }

  const { trackId, runs, staggerMs = replay.DEFAULT_STAGGER_MS } = req.body as {
    trackId?: unknown;
    runs?: unknown;
    staggerMs?: unknown;
  };
  if (!isValidName(trackId)) {
    res.status(400).json({ error: "trackId (string) required" });
    return;
  }
  if (
    !Array.isArray(runs) ||
    runs.length === 0 ||
    !runs.every((r) => isValidName(r))
  ) {
    res.status(400).json({ error: "runs must be a non-empty array of recording labels" });
    return;
  }
  if (new Set(runs).size !== runs.length) {
    res.status(400).json({ error: "runs must not repeat a label" });
    return;
  }
  if (runs.length > MAX_DRIVERS) {
    res.status(400).json({ error: `max ${MAX_DRIVERS} drivers per session` });
    return;
  }
  if (typeof staggerMs !== "number" || staggerMs < 0 || staggerMs > 10_000) {
    res.status(400).json({ error: "staggerMs must be a number between 0 and 10000" });
    return;
  }

  try {
    const session = replay.start(trackId, runs as string[], staggerMs);
    res.status(201).json({ session, replay: replay.status() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}
