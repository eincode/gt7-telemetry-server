import * as fs from "fs";
import * as path from "path";
import type { Request, Response } from "express";
import type { ComputedTrack, Vec3 } from "../../../recorder/types";

const TRACKS_ROOT = path.join(process.cwd(), "tracks");

// Top-down [x, z] projection, rounded to 0.1 m to keep the payload small.
const flat = (p: Vec3): [number, number] => [Math.round(p[0] * 10) / 10, Math.round(p[2] * 10) / 10];

export default function handler(req: Request, res: Response) {
  const id = String(req.params.id ?? "");
  if (!/^[a-z0-9-]+$/.test(id)) {
    res.status(400).json({ error: "invalid track id" });
    return;
  }

  const trackPath = path.join(TRACKS_ROOT, id, "track.json");
  if (!fs.existsSync(trackPath)) {
    res.status(404).json({ error: `track "${id}" not found` });
    return;
  }

  const track = JSON.parse(fs.readFileSync(trackPath, "utf-8")) as ComputedTrack;
  res.json({
    id,
    centerline: track.centerline.map(flat),
    leftEdge: track.leftLine.map(flat),
    rightEdge: track.rightLine.map(flat),
    sectorBoundaries: track.sectorBoundaries.map((b) => flat(b.position)),
    // Edge-to-edge endpoints, for drawing each boundary as a line across the road.
    sectors: track.sectorBoundaries.map((b) => ({ left: flat(b.leftEdge), right: flat(b.rightEdge) })),
  });
}
