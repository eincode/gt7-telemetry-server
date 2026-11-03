import type { Request, Response } from "express";
import * as replay from "../../../replay/player";

export default function handler(_req: Request, res: Response) {
  res.json({ ok: true, stopped: replay.stop() });
}
