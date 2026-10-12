import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_TIME_ZONE, LOCALE_COOKIE, resolveLocale } from "./config";

/**
 * Locale comes from a cookie (no locale segment in URLs: this is an app, not
 * a website). The cookie is set from the user's saved preference at sign-in
 * and by the language switcher.
 */
export default getRequestConfig(async () => {
  const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return {
    locale,
    timeZone: DEFAULT_TIME_ZONE,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
