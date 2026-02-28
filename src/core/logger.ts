import { appendFileSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getDataDir } from "./types.js";

const MAX_LOG_SIZE = 1_000_000; // 1MB
const TRUNCATE_TO = 500_000; // 500KB

function getLogPath(): string {
  return join(getDataDir(), "engram.log");
}

export function log(level: "info" | "warn" | "error", message: string): void {
  const logPath = getLogPath();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

  try {
    mkdirSync(dirname(logPath), { recursive: true });

    // Rotate if needed
    try {
      const stats = statSync(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        const content = readFileSync(logPath);
        writeFileSync(logPath, content.subarray(content.length - TRUNCATE_TO));
      }
    } catch {
      // File doesn't exist yet, that's fine
    }

    appendFileSync(logPath, line);
  } catch {
    // Last resort: write to stderr (visible in claude --debug)
    process.stderr.write(`[engram] ${line}`);
  }
}
