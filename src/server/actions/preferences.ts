"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { LOCALE_COOKIE, LOCALES } from "@/i18n/config";
import { db } from "../db";
import { definePublicAction } from "./define-action";

/** Switch UI language: cookie for this browser, saved on the user when signed in. */
export const setLocale = definePublicAction({
  name: "preferences.setLocale",
  input: z.object({ locale: z.enum(LOCALES) }),
  async run({ input, user }) {
    (await cookies()).set(LOCALE_COOKIE, input.locale, {
      path: "/",
      sameSite: "lax",
      maxAge: 31_536_000,
    });
    if (user) await db.user.update({ where: { id: user.id }, data: { locale: input.locale } });
    return { locale: input.locale };
  },
});
