import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Shell } from "@/components/Shell";
import { TemplateThumb } from "@/components/TemplateThumb";
import { store } from "@/lib/db";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "@/lib/templates";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/templates")({
  head: () => ({
    meta: [
      { title: "قوالب المشغل · استوديو مشغل القرآن" },
      {
        name: "description",
        content: "تصفح قوالب مشغلات القرآن بمقاسات 9:16 و16:9 وافتح أي واحد في المحرر.",
      },
      { property: "og:title", content: "قوالب المشغل · استوديو مشغل القرآن" },
      { property: "og:description", content: "قوالب مشغل صوتي متحركة وقابلة للتعديل بالكامل." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TemplatesPage,
});

function TemplatesPage() {
  const [cat, setCat] = useState<string>("الكل");
  const [asp, setAsp] = useState<string>("الكل");
  const [favs, setFavs] = useState<string[]>([]);

  useEffect(() => {
    store.favTemplates().then(setFavs);
  }, []);

  const toggleFav = async (id: string) => {
    const next = favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id];
    setFavs(next);
    await store.saveFavTemplates(next);
  };

  const list = TEMPLATES.filter((t) => (cat === "الكل" || t.category === cat) && (asp === "الكل" || t.config.aspect === asp));

  return (
    <Shell>
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="القوالب" subtitle={`${TEMPLATES.length} تصميم مشغل جاهز — اختر واحد وابدأ.`} />

        <div className="mb-5 flex flex-wrap gap-2">
          {["الكل", ...TEMPLATE_CATEGORIES].map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={cn(
                "rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground",
                cat === c && "border-primary/60 bg-primary/15 text-foreground",
              )}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="mb-5 flex flex-wrap gap-2">
          {["الكل", "9:16", "16:9", "1:1", "4:5"].map((a) => (
            <button
              key={a}
              onClick={() => setAsp(a)}
              className={cn(
                "rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground",
                asp === a && "border-primary/60 bg-primary/15 text-foreground",
              )}
            >
              {a}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {list.map((t) => (
            <div key={t.id} className="glass overflow-hidden rounded-2xl p-2">
              <div className="overflow-hidden rounded-xl bg-black/40">
                <TemplateThumb config={t.config} />
              </div>
              <div className="flex items-center gap-1 px-1 pt-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {t.category} · {t.config.aspect}
                  </p>
                </div>
                <button
                  aria-label="تفضيل القالب"
                  onClick={() => toggleFav(t.id)}
                  className="grid size-8 place-items-center rounded-lg hover:bg-sidebar-accent"
                >
                  <Heart
                    className={cn("size-4", favs.includes(t.id) ? "fill-primary text-primary" : "text-muted-foreground")}
                  />
                </button>
              </div>
              <Button asChild size="sm" className="mt-2 mb-1 w-full">
                <Link to="/editor" search={{ template: t.id, project: undefined }}>
                  استخدم القالب
                </Link>
              </Button>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
