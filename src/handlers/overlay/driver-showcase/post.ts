import type { Request, Response } from "express";
import * as overlayState from "../../../overlay-state";

export default function handler(req: Request, res: Response) {
  const { visible, driverId } = req.body as {
    visible?: unknown;
    driverId?: unknown;
  };
  if (visible !== undefined && typeof visible !== "boolean") {
    res.status(400).json({ error: "visible must be a boolean" });
    return;
  }
  if (
    driverId !== undefined &&
    driverId !== null &&
    typeof driverId !== "number"
  ) {
    res.status(400).json({ error: "driverId must be a number or null" });
    return;
  }
  const patch: Parameters<typeof overlayState.setDriverShowcase>[0] = {};
  if (visible !== undefined) patch.visible = visible as boolean;
  if (driverId !== undefined) patch.driverId = driverId as number | null;
  res.json({ ok: true, overlayState: overlayState.setDriverShowcase(patch) });
}
