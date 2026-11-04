import type { Request, Response } from "express";
import * as serial from "../../serial";

// Keys the Arduino accepts; it ignores everything else
const DIRECTOR_KEYS = "1234567890qwertyghjklzxcv";

export default function handler(req: Request, res: Response) {
  const { key } = (req.body ?? {}) as { key?: unknown };

  if (typeof key !== "string" || key.length !== 1) {
    res
      .status(400)
      .json({ ok: false, error: "key must be a single character string" });
    return;
  }

  const k = key.toLowerCase();
  if (!DIRECTOR_KEYS.includes(k)) {
    res.status(400).json({
      ok: false,
      error: `key "${key}" not allowed; must be one of: ${DIRECTOR_KEYS.split("").join(" ")}`,
    });
    return;
  }

  if (!serial.sendKey(k)) {
    res.status(503).json({ ok: false, error: "serial not connected" });
    return;
  }

  res.json({ ok: true, key: k });
}
