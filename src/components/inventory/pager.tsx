import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Previous/next links that keep the other query parameters. */
export async function Pager({
  basePath,
  params,
  page,
  pages,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  pages: number;
}) {
  if (pages <= 1) return null;
  const t = await getTranslations("common");
  const href = (target: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
    if (target > 1) query.set("page", String(target));
    const qs = query.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const link = cn(buttonVariants({ variant: "outline", size: "sm" }));
  return (
    <nav
      className="flex items-center justify-between gap-3"
      aria-label={t("pageOf", { page, pages })}
    >
      {page > 1 ? (
        <Link href={href(page - 1)} className={link} rel="prev">
          {t("previous")}
        </Link>
      ) : (
        <span />
      )}
      <span className="text-sm text-muted-foreground">{t("pageOf", { page, pages })}</span>
      {page < pages ? (
        <Link href={href(page + 1)} className={link} rel="next">
          {t("next")}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
