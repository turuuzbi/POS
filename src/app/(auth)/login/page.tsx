import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { readDeviceToken } from "@/server/auth/device";
import { getCurrentUser } from "@/server/auth/session";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("loginTitle") };
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getCurrentUser()) redirect("/");
  const t = await getTranslations("auth");
  const { next } = await searchParams;
  const paired = (await readDeviceToken()) !== null;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <h1 className="text-2xl leading-none font-semibold">{t("loginTitle")}</h1>
        <CardDescription>{t("loginSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm next={typeof next === "string" ? next : undefined} />
      </CardContent>
      {paired ? (
        <CardFooter>
          <Button variant="link" asChild className="px-0">
            <Link href="/pin">{t("usePin")}</Link>
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
