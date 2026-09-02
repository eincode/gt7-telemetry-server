import type { Request, Response } from "express";
import { broadcast } from "../../broadcaster";
import * as session from "../../session";
import type { RosterEntry } from "../../types";
import { MAX_DRIVERS } from "../shared";

export default function handler(req: Request, res: Response) {
  const s = session.getSession();
  if (!s) {
    res.status(400).json({ error: "no active session" });
    return;
  }

  const { id, name, country } = req.body as {
    id?: unknown;
    name?: unknown;
    country?: unknown;
  };
  if (typeof id !== "number" || typeof name !== "string" || name.trim() === "") {
    res
      .status(400)
      .json({ error: "driver must have id (number) and name (string)" });
    return;
  }
  if (s.roster.some((r) => r.id === id)) {
    res.status(409).json({ error: `driver ${id} already in roster` });
    return;
  }
  if (s.roster.length >= MAX_DRIVERS) {
    res.status(400).json({ error: `max ${MAX_DRIVERS} drivers per session` });
    return;
  }

  const entry: RosterEntry = {
    id,
    name,
    country: typeof country === "string" ? country : "",
  };
  session.addDriver(entry);
  broadcast({ type: "roster", session: s, roster: s.roster });
  res.status(201).json({ ok: true, session: s });
}
