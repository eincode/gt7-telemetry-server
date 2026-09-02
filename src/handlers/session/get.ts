import type { Request, Response } from "express";
import * as session from "../../session";

export default function handler(_req: Request, res: Response) {
  const s = session.getSession();
  if (!s) {
    res.status(404).json({ error: "no active session" });
    return;
  }
  res.json({ session: s });
}
