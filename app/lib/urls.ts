/** Public site (one-pager + waitlist) and app hosts. Empty means same origin, as in local dev. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "";
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";
export const WAITLIST_URL = SITE_URL ? `${SITE_URL}/` : "/landing";
