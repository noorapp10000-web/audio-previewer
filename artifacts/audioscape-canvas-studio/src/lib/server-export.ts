import type { Project } from "./types";

type ExportStatus = {
  jobId: string;
  state: "queued" | "loading-renderer" | "rendering" | "finalizing" | "completed" | "failed";
  progress: number;
  stage: string;
  error?: string;
};

export async function exportProjectOnServer(
  project: Project,
  onProgress: (progress: number, stage: string) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!project.audio) throw new Error("ارفع ملف صوتي أولًا.");
  onProgress(0.01, "جاري تجهيز التصدير");

  const response = await fetch("/api/audioscape-export/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project }),
    signal,
  });
  const created = (await response.json().catch(() => null)) as { jobId?: string; message?: string } | null;
  if (!response.ok || !created?.jobId) {
    throw new Error(created?.message ?? "تعذّر بدء عملية التصدير.");
  }

  let status: ExportStatus;
  for (;;) {
    const statusResponse = await fetch(`/api/audioscape-export/jobs/${encodeURIComponent(created.jobId)}`, { signal });
    const payload = (await statusResponse.json().catch(() => null)) as ExportStatus | { message?: string } | null;
    if (!statusResponse.ok || !payload || !("state" in payload)) {
      const message = payload && typeof payload === "object" && "message" in payload
        ? (payload as { message?: string }).message
        : undefined;
      throw new Error(message ?? "تعذّر متابعة التصدير.");
    }
    status = payload;
    onProgress(status.progress, status.stage);
    if (status.state === "completed") break;
    if (status.state === "failed") throw new Error(status.error ?? "فشل التصدير على السيرفر.");
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const downloadResponse = await fetch(
    `/api/audioscape-export/jobs/${encodeURIComponent(created.jobId)}/download`,
    { signal },
  );
  if (!downloadResponse.ok) {
    const error = (await downloadResponse.json().catch(() => null)) as { message?: string } | null;
    throw new Error(error?.message ?? "تعذّر تنزيل ملف MP4.");
  }
  onProgress(0.98, "جاري تنزيل MP4");
  const blob = await downloadResponse.blob();
  onProgress(1, "اكتمل التصدير");
  return blob;
}