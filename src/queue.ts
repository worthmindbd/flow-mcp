import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  duration?: 4 | 6 | 8 | 10;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  chain_from?: string;
  reference_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  progress?: string;
  note?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job) => Promise<string[]>;

// Flow is driven like a careful person would: one generation at a time, with a
// randomised pause between them.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;

// How many generations may START in any rolling hour (FLOW_MCP_MAX_PER_HOUR, default 0 = no cap). Flow's soft block
// is mainly a volume response, so this is the blunt lever that keeps a long batch from looking like a machine: 20-30
// is a sensible ceiling. The queue waits for a free slot rather than failing, and says so in `pacing`.
const MAX_PER_HOUR = Number(process.env.FLOW_MCP_MAX_PER_HOUR ?? 0);
const HOUR_MS = 3_600_000;

export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  private starts: number[] = []; // start times inside the last hour, for MAX_PER_HOUR
  pausedReason: string | null = null;

  constructor(private runner: JobRunner) {}

  add(params: SceneParams): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: "queued",
      params,
      files: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    void this.work();
    return job;
  }

  // True from the moment work is in the queue until it drains: a job mid-run, and also the pacing pause before the
  // next one. Page-driving tools must refuse during the pause too - a grid scan started then collides with the
  // generation that is about to begin (and flow_status would open the account panel underneath it).
  get busy(): boolean {
    return this.working || this.list().some((j) => j.status === "running");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  // Puts a failed or cancelled job back in line with the same settings and file name.
  retry(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
      job.finishedAt = undefined;
      void this.work();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
    }
    return job;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished) {
          const pause = PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
          const remaining = this.lastFinished + pause - Date.now();
          if (remaining > 0) {
            this.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pausedReason = null;
          }
        }
        if (job.status !== "queued") continue;
        // Volume is what Flow's risk score reacts to, so the hourly cap is applied right before a generation starts.
        // The queue waits for the slot instead of failing: the work is still what the user asked for, just slower.
        if (MAX_PER_HOUR > 0) {
          const now = Date.now();
          this.starts = this.starts.filter((t) => now - t < HOUR_MS);
          if (this.starts.length >= MAX_PER_HOUR) {
            const wait = this.starts[0] + HOUR_MS - now;
            this.pausedReason = `hourly cap: ${MAX_PER_HOUR} generations an hour, next slot in ${Math.ceil(wait / 1000)}s`;
            await new Promise((r) => setTimeout(r, wait));
            this.pausedReason = null;
            continue;
          }
        }
        job.status = "running";
        job.attempts++;
        this.starts.push(Date.now());
        try {
          job.files = await this.runner(job);
          job.status = "done";
          job.error = undefined;
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          // Only retried automatically when Flow itself refused the generation: the driver says so in words
          // ("Nothing was charged"), which is what makes a second attempt safe. Timeouts are never retried - the
          // generation may still be running and charging - and neither is a soft block, which retrying only feeds.
          const retryable = /nothing was charged/i.test(job.error) && !/unusual activity/i.test(job.error);
          job.status = retryable && job.attempts <= (job.params.retries ?? 1) ? "queued" : "failed";
        }
        job.finishedAt = new Date().toISOString();
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }
}
