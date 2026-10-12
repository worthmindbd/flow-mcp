import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";

// Flow's "unusual activity" soft block: it refuses EVERY generation, videos and free images alike, and says nothing
// was charged. Ten attempts in a row changed nothing on 2026-10-12, and it was still refusing after a 10-minute wait,
// so retrying is not a fix - only time and a lower volume are. The wait is remembered here and enforced everywhere a
// generation starts, so no queue or agent can walk back into it. Volume is the main trigger, so the rate cap in
// queue.ts (FLOW_MCP_MAX_PER_HOUR) is the other half of the answer.
//
// FLOW_MCP_SOFT_BLOCK_HOURS=0 turns the wait off: generation is still refused by Flow, it just may be attempted again
// sooner. Nothing else about a block is charged: downloading, cutting and narration keep working throughout.
const raw = process.env.FLOW_MCP_SOFT_BLOCK_HOURS;
const hours = raw === undefined || raw === "" ? 6 : Number(raw);
export const COOLDOWN_MS = Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 0;

const FILE = join(HOME_DIR, "soft-block.json");

interface SoftBlock {
  seen: string;
  until: string;
  reason: string;
}

export function noteSoftBlock(reason: string): void {
  if (!COOLDOWN_MS) return;
  const now = Date.now();
  const record: SoftBlock = {
    seen: new Date(now).toISOString(),
    until: new Date(now + COOLDOWN_MS).toISOString(),
    reason: reason.replace(/\s+/g, " ").trim().slice(0, 400),
  };
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(record, null, 2));
  } catch {
    // Remembering is a courtesy; the job's own error already says what happened.
  }
}

// Still inside the wait? An expired file is simply ignored, so nothing has to clean it up.
export function activeSoftBlock(): SoftBlock | undefined {
  if (!COOLDOWN_MS || !existsSync(FILE)) return undefined;
  try {
    const record = JSON.parse(readFileSync(FILE, "utf8")) as SoftBlock;
    return Date.parse(record.until) > Date.now() ? record : undefined;
  } catch {
    return undefined;
  }
}

const inWords = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

export function assertNotGenerating(): void {
  const block = activeSoftBlock();
  if (!block) return;
  throw new Error(
    `Flow is soft-blocked on this account: it refused a generation with "unusual activity" at ${new Date(block.seen).toLocaleString()} and warned that nothing was charged. ` +
      `That is Flow's own bot management, not a prompt problem, and the main trigger is volume - so generating again before ${new Date(block.until).toLocaleString()} (about ${inWords(Date.parse(block.until) - Date.now())} from now) risks deepening it. ` +
      `Downloading media you already made, cutting films, narration and assembly all still work. The word it used: "${block.reason}". ` +
      `To try sooner anyway, delete ${FILE} (or run with FLOW_MCP_SOFT_BLOCK_HOURS=0) and lower the volume instead.`,
  );
}