/**
 * Runs `fn` with a default locale for Number/Date `toLocaleString(undefined, ...)`, as if the
 * user's browser were set to that locale.
 */
export function withLocale<T>(locale: string, fn: () => T): T {
  const num = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    return num.call(this, locales ?? locale, options);
  };
  try {
    return fn();
  } finally {
    Number.prototype.toLocaleString = num;
  }
}
