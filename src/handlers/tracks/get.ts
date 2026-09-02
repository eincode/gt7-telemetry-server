import * as fs from "fs";
import * as path from "path";
import type { Request, Response } from "express";

const TRACKS_JSON_PATH = path.join(process.cwd(), "assets", "tracks.json");

export default function handler(_req: Request, res: Response) {
  if (!fs.existsSync(TRACKS_JSON_PATH)) {
    res.status(500).json({ error: "assets/tracks.json not found" });
    return;
  }
  const tracks = JSON.parse(fs.readFileSync(TRACKS_JSON_PATH, "utf-8"));
  res.json(tracks);
}
