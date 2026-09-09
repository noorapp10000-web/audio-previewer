import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ASPECTS, type Project } from "@/lib/types";
import { drawFrame } from "@/lib/render";

declare global {
  interface Window {
    __AUDIOSCAPE_EXPORT_PAYLOAD__?: { project: Project };
    __AUDIOSCAPE_EXPORT_SET_TIME__?: (time: number) => void;
    __AUDIOSCAPE_EXPORT_RENDERED_TIME__?: number;
    __AUDIOSCAPE_EXPORT_READY__?: boolean;
  }
}

export const Route = createFileRoute("/export")({
  component: ExportPage,
});

function loadImage(url?: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function ExportPage() {
  const project = window.__AUDIOSCAPE_EXPORT_PAYLOAD__?.project;
  const [time, setTime] = useState(0);
  const [images, setImages] = useState<{
    cover: HTMLImageElement | null;
    logo: HTMLImageElement | null;
    bg: HTMLImageElement | null;
  }>({ cover: null, logo: null, bg: null });
  const canvasSize = useMemo(() => {
    const base = project ? ASPECTS[project.config.aspect] : ASPECTS["16:9"];
    const scale = (project?.quality ?? 1080) / 1080;
    return {
      width: Math.round((base.w * scale) / 2) * 2,
      height: Math.round((base.h * scale) / 2) * 2,
    };
  }, [project]);

  useEffect(() => {
    if (!project) return;
    let active = true;
    void Promise.all([
      loadImage(project.coverUrl),
      loadImage(project.logoUrl),
      loadImage(project.bgUrl),
    ]).then(([cover, logo, bg]) => {
      if (!active) return;
      setImages({ cover, logo, bg });
      window.__AUDIOSCAPE_EXPORT_READY__ = true;
    });
    window.__AUDIOSCAPE_EXPORT_SET_TIME__ = setTime;
    return () => {
      active = false;
      delete window.__AUDIOSCAPE_EXPORT_SET_TIME__;
    };
  }, [project]);

  useLayoutEffect(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-export-canvas='true']");
    if (!canvas || !project) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    drawFrame(ctx, project.config, {
      W: canvasSize.width,
      H: canvasSize.height,
      time,
      duration: project.audio?.duration ?? 0,
      peaks: project.audio?.peaks ?? [],
      cover: images.cover,
      logo: images.logo,
      bg: images.bg,
      verses: project.verses,
      playing: true,
    });
    window.__AUDIOSCAPE_EXPORT_RENDERED_TIME__ = time;
  }, [canvasSize, images, project, time]);

  if (!project) {
    return <div data-export-root="true" />;
  }

  return (
    <main
      data-export-root="true"
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "transparent",
      }}
    >
      <canvas
        data-export-canvas="true"
        width={canvasSize.width}
        height={canvasSize.height}
        style={{ display: "block", width: "100vw", height: "100vh" }}
      />
    </main>
  );
}