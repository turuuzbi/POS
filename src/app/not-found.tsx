import { SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { Button } from "@/components/ui/button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("states");
  return { title: t("notFoundTitle") };
}

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-4">
      <EmptyState
        icon={SearchX}
        title={t("states.notFoundTitle")}
        description={t("states.notFoundDescription")}
        action={
          <Button asChild>
            <Link href="/">{t("common.goHome")}</Link>
          </Button>
        }
        className="w-full max-w-lg"
        headingLevel={1}
      />
    </main>
  );
}
