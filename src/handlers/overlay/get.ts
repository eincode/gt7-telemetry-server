import type { Request, Response } from "express";
import * as overlayState from "../../overlay-state";

export default function handler(_req: Request, res: Response) {
  res.json(overlayState.getOverlayState());
}
