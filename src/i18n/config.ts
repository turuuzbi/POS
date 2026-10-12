/** Supported UI languages. Mongolian is the default. */
export const LOCALES = ["mn", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "mn";
export const LOCALE_COOKIE = "NEXT_LOCALE";
/** All business dates/times render in the shop's timezone. */
export const DEFAULT_TIME_ZONE = "Asia/Ulaanbaatar";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(...candidates: unknown[]): Locale {
  return (candidates.find(isLocale) as Locale | undefined) ?? DEFAULT_LOCALE;
}
