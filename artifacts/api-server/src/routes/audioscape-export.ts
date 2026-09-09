import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Router, type IRouter } from "express";
import { chromium, type Page } from "playwright";
import { logger } from "../lib/logger";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();
const MAX_DURATION_SECONDS = 10 * 60;
const JOB_TTL_MS = 15 * 60 * 1000;
const FRAME_RATE = 30;
const executablePromises = new Map<string, Promise<string>>();

type AudioScapeProject = {
  name?: string;
  config: {
    aspect: "16:9" | "9:16" | "1:1" | "4:5";
    [key: string]: unknown;
  };
  verses: unknown[];
  quality: 720 | 1080;
  fps: 30 | 60;
  audio?: {
    name: string;
    url: string;
    duration: number;
    peaks: number[];
  };
  coverUrl?: string;
  logoUrl?: string;
  bgUrl?: string;
};

type ExportBody = { project?: AudioScapeProject };
type JobState = "queued" | "loading-renderer" | "rendering" | "finalizing" | "completed" | "failed";
type ExportJob = {
  id: string;
  state: JobState;
  progress: number;
  stage: string;
  createdAt: number;
  outputPath?: string;
  root?: string;
  error?: string;
  cleanupTimer?: NodeJS.Timeout;
};

const jobs = new Map<string, ExportJob>();
let exportQueue: Promise<void> = Promise.resolve();

const dimensions: Record<AudioScapeProject["config"]["aspect"], Record<AudioScapeProject["quality"], [number, number]>> = {
  "16:9": { 720: [1280, 720], 1080: [1920, 1080] },
  "9:16": { 720: [720, 1280], 1080: [1080, 1920] },
  "1:1": { 720: [720, 720], 1080: [1080, 1080] },
  "4:5": { 720: [576, 720], 1080: [1080, 1350] },
};

function updateJob(id: string, patch: Partial<ExportJob>) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
}

function parseDataUrl(value: string, label: string) {
  const match = /^data:[^;,]+(?:;[^;,]+)*;base64,(.+)$/s.exec(value);
  if (!match?.[1]) throw new Error(`ملف ${label} غير صالح أو غير مدعوم.`);
  return Buffer.from(match[1], "base64");
}

function validateBody(body: ExportBody) {
  const project = body.project;
  if (!project?.audio?.url) throw new Error("ارفع ملف صوتي أولًا.");
  if (!project.config || !dimensions[project.config.aspect]) throw new Error("أبعاد الفيديو غير صالحة.");
  if (project.quality !== 720 && project.quality !== 1080) throw new Error("الدقة غير صالحة.");
  if (project.fps !== 30 && project.fps !== 60) throw new Error("معدل الإطارات غير صالح.");
  if (!Number.isFinite(project.audio.duration) || project.audio.duration <= 0) {
    throw new Error("تعذر تحديد مدة الصوت.");
  }
  if (project.audio.duration > MAX_DURATION_SECONDS) {
    throw new Error("مدة التصدير لا يمكن أن تتجاوز 10 دقائق.");
  }
  return project;
}

async function resolveExecutable(name: "ffmpeg" | "chromium", envKey: string) {
  const configured = process.env[envKey]?.trim();
  if (configured) return configured;
  const existing = executablePromises.get(name);
  if (existing) return existing;
  const lookup = execFileAsync("which", [name]).then(({ stdout }) => {
    const executable = stdout.trim();
    if (!executable) throw new Error(`${name} executable was not found.`);
    return executable;
  });
  executablePromises.set(name, lookup);
  return lookup;
}

function renderUrl() {
  const configured = process.env.AUDIOSCAPE_RENDER_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    const domain = process.env.REPLIT_DOMAINS?.split(",").map((value) => value.trim()).find(Boolean);
    if (domain) return /^https?:\/\//i.test(domain) ? domain.replace(/\/+$/, "") : `https://${domain}`;
  }
  return "http://127.0.0.1:20795";
}

async function waitForFrame(page: Page, time: number) {
  await page.evaluate((nextTime) => {
    const setter = (globalThis as Record<string, unknown>).__AUDIOSCAPE_EXPORT_SET_TIME__;
    if (typeof setter !== "function") throw new Error("Export renderer is not ready.");
    setter(nextTime);
  }, time);
  await page.waitForFunction(
    (expected) => {
      const rendered = (globalThis as Record<string, unknown>).__AUDIOSCAPE_EXPORT_RENDERED_TIME__;
      return typeof rendered === "number" && Math.abs(rendered - expected) < 0.0001;
    },
    time,
    { timeout: 10_000 },
  );
}

function startFfmpeg(ffmpegPath: string, root: string, outputPath: string, audioPath: string, width: number, height: number, duration: number, fps: number) {
  const args = [
    "-y",
    "-framerate", String(fps),
    "-start_number", "0",
    "-i", path.join(root, "frame-%06d.png"),
    "-i", audioPath,
    "-t", duration.toFixed(3),
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-s", `${width}x${height}`,
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ];
  const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg exited with ${code}`)));
  });
  return { child, done };
}

async function renderExport(body: ExportBody, onProgress: (progress: number, stage: string, state: JobState) => void) {
  const project = validateBody(body);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "audioscape-export-"));
  const [width, height] = dimensions[project.config.aspect][project.quality];
  const duration = project.audio!.duration;
  const outputPath = path.join(root, "audioscape-export.mp4");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let ffmpeg: ReturnType<typeof startFfmpeg> | undefined;
  let completed = false;

  try {
    onProgress(0.04, "Preparing export", "queued");
    const audioPath = path.join(root, "audio-source");
    await fs.writeFile(audioPath, parseDataUrl(project.audio!.url, "الصوت"));

    onProgress(0.12, "Loading renderer", "loading-renderer");
    browser = await chromium.launch({
      headless: true,
      executablePath: await resolveExecutable("chromium", "CHROMIUM_PATH"),
      args: ["--font-render-hinting=none", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.addInitScript((payload: { project: AudioScapeProject }) => {
      (globalThis as Record<string, unknown>).__AUDIOSCAPE_EXPORT_PAYLOAD__ = payload;
    }, { project });
    await page.goto(`${renderUrl()}/export?export=1`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForSelector("[data-export-canvas='true']", { state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => (globalThis as Record<string, unknown>).__AUDIOSCAPE_EXPORT_READY__ === true, undefined, { timeout: 30_000 });

    onProgress(0.18, "Rendering video", "rendering");
    const frameCount = Math.ceil(duration * FRAME_RATE);
    for (let frame = 0; frame < frameCount; frame += 1) {
      await waitForFrame(page, frame / FRAME_RATE);
      await page.screenshot({
        path: path.join(root, `frame-${String(frame).padStart(6, "0")}.png`),
        type: "png",
        omitBackground: false,
        animations: "disabled",
      });
      onProgress(0.18 + ((frame + 1) / frameCount) * 0.7, "Rendering video", "rendering");
    }
    await browser.close();
    browser = undefined;

    onProgress(0.92, "Finalizing MP4", "finalizing");
    const ffmpegPath = await resolveExecutable("ffmpeg", "FFMPEG_PATH");
    ffmpeg = startFfmpeg(ffmpegPath, root, outputPath, audioPath, width, height, duration, FRAME_RATE);
    await ffmpeg.done;
    await fs.stat(outputPath);
    completed = true;
    onProgress(1, "Export completed", "completed");
    return { outputPath, root };
  } finally {
    await browser?.close().catch(() => undefined);
    if (!completed) {
      ffmpeg?.child.kill("SIGKILL");
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

function scheduleCleanup(jobId: string, delay = JOB_TTL_MS) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    const current = jobs.get(jobId);
    if (current?.root) void fs.rm(current.root, { recursive: true, force: true });
    jobs.delete(jobId);
  }, delay);
}

async function runJob(jobId: string, body: ExportBody) {
  try {
    const result = await renderExport(body, (progress, stage, state) => updateJob(jobId, { progress, stage, state }));
    const job = jobs.get(jobId);
    if (!job) {
      await fs.rm(result.root, { recursive: true, force: true });
      return;
    }
    Object.assign(job, { outputPath: result.outputPath, root: result.root, state: "completed" as const, progress: 1 });
    scheduleCleanup(jobId);
  } catch (error) {
    logger.error({ err: error, jobId }, "AudioScape export failed");
    updateJob(jobId, { state: "failed", progress: 0, stage: "Export failed", error: error instanceof Error ? error.message : "تعذر تصدير الفيديو." });
    scheduleCleanup(jobId, 5 * 60 * 1000);
  }
}

router.post("/audioscape-export/jobs", (req, res): void => {
  try {
    validateBody(req.body as ExportBody);
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "بيانات التصدير غير صالحة." });
    return;
  }
  const job: ExportJob = {
    id: randomUUID(),
    state: "queued",
    progress: 0,
    stage: "Preparing export",
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  const queued = exportQueue.then(() => runJob(job.id, req.body as ExportBody));
  exportQueue = queued.catch(() => undefined);
  res.status(202).json({ jobId: job.id });
});

router.get("/audioscape-export/jobs/:jobId", (req, res): void => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ message: "انتهت صلاحية عملية التصدير. ابدأ تصديرًا جديدًا." });
    return;
  }
  res.json({
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    stage: job.stage,
    error: job.error,
  });
});

router.get("/audioscape-export/jobs/:jobId/download", async (req, res): Promise<void> => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ message: "انتهت صلاحية عملية التصدير. ابدأ تصديرًا جديدًا." });
    return;
  }
  if (job.state !== "completed" || !job.outputPath) {
    res.status(409).json({ message: "الفيديو لم يكتمل تجهيزه بعد." });
    return;
  }
  try {
    const stat = await fs.stat(job.outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", 'attachment; filename="audioscape-export.mp4"');
    res.sendFile(job.outputPath, (error) => {
      if (error) logger.error({ err: error, jobId: job.id }, "Failed to send AudioScape export");
      scheduleCleanup(job.id, 30_000);
    });
  } catch (error) {
    logger.error({ err: error, jobId: job.id }, "AudioScape export file unavailable");
    res.status(500).json({ message: error instanceof Error ? error.message : "ملف الفيديو غير متاح." });
  }
});

export default router;