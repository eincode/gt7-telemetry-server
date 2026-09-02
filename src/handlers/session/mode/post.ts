import type { Request, Response } from "express";
import * as session from "../../../session";
import type { SessionMode } from "../../../types";
import { VALID_MODES } from "../../shared";

export default function handler(req: Request, res: Response) {
  const s = session.getSession();
  if (!s) {
    res.status(400).json({ error: "no active session" });
    return;
  }

  const { mode } = req.body as { mode?: unknown };
  if (!VALID_MODES.includes(mode as SessionMode)) {
    res
      .status(400)
      .json({ error: `mode must be one of: ${VALID_MODES.join(", ")}` });
    return;
  }

  session.setMode(mode as SessionMode);
  res.json({ ok: true, mode });
}
