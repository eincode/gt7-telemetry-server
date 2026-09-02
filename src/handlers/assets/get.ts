import * as fs from "fs";
import * as path from "path";
import type { Request, Response } from "express";

const ASSETS_ROOT = path.join(process.cwd(), "assets");

export default function handler(req: Request, res: Response) {
  const rel = req.params[0] ?? "";
  const segments = rel.split("/").filter(Boolean);
  if (segments.some((seg) => seg === ".." || seg.includes("\0"))) {
    res.status(400).json({ error: "invalid path" });
    return;
  }

  const filePath = path.join(ASSETS_ROOT, ...segments);
  if (!filePath.startsWith(ASSETS_ROOT + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.status(404).json({ error: `asset "${rel}" not found` });
    return;
  }

  res.sendFile(filePath);
}
