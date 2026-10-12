import { SearchX } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { Button } from "@/components/ui/button";

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
      />
    </main>
  );
}
