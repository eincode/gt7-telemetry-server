import type { Request, Response } from "express";
import * as overlayState from "../../../overlay-state";

export default function handler(req: Request, res: Response) {
  const { visible, driverIds } = req.body as {
    visible?: unknown;
    driverIds?: unknown;
  };
  if (visible !== undefined && typeof visible !== "boolean") {
    res.status(400).json({ error: "visible must be a boolean" });
    return;
  }
  if (driverIds !== undefined) {
    if (
      !Array.isArray(driverIds) ||
      driverIds.length > 2 ||
      !(driverIds as unknown[]).every((id) => typeof id === "number")
    ) {
      res
        .status(400)
        .json({ error: "driverIds must be an array of 0–2 numbers" });
      return;
    }
  }
  const patch: Parameters<typeof overlayState.setSector>[0] = {};
  if (visible !== undefined) patch.visible = visible as boolean;
  if (driverIds !== undefined) patch.driverIds = driverIds as number[];
  res.json({ ok: true, overlayState: overlayState.setSector(patch) });
}
