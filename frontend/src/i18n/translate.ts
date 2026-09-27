import { en, type Messages } from "./en";
import type { Locale } from "./locale";
import { ru } from "./ru";

export type MessageKey = keyof Messages;

/** The `{name}` placeholders in a message, as a union of names: "a {x} b {y}" → "x" | "y". */
type PlaceholderNames<Template extends string> = Template extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

type ParamsFor<Key extends MessageKey> = Record<PlaceholderNames<(typeof en)[Key]>, string | number>;

/** A message with placeholders must be given exactly those values; one without takes none. */
type ParamsArgument<Key extends MessageKey> = [PlaceholderNames<(typeof en)[Key]>] extends [never]
  ? []
  : [params: ParamsFor<Key>];

/** The keys whose messages take no parameters. */
export type PlainMessageKey = {
  [Key in MessageKey]: [PlaceholderNames<(typeof en)[Key]>] extends [never] ? Key : never;
}[MessageKey];

export type Translate = <Key extends MessageKey>(key: Key, ...params: ParamsArgument<Key>) => string;

type LooseParams = Readonly<Record<string, string | number>>;

/**
 * Fills `{name}` placeholders in one pass. The values are plain text (the
 * result is only ever rendered as React text): they are never interpreted,
 * never re-scanned for placeholders, and only the caller's own properties are
 * looked up. A placeholder without a value is left as written.
 */
export function interpolate(template: string, params: LooseParams | undefined): string {
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

/**
 * A translator over `messages`. A key it lacks falls back to `fallback` (English),
 * and one that nobody has renders as the key itself rather than as nothing.
 * The types make a missing key impossible for the shipped locales; this is
 * the safety net for anything that slips past them.
 */
export function createTranslator(messages: Readonly<Partial<Messages>>, fallback: Messages = en): Translate {
  const translator = (key: MessageKey, params?: LooseParams): string => {
    const template = Object.hasOwn(messages, key) ? messages[key] : undefined;
    const fallbackTemplate = Object.hasOwn(fallback, key) ? fallback[key] : undefined;
    return interpolate(template ?? fallbackTemplate ?? key, params);
  };
  return translator;
}

const TRANSLATORS: Readonly<Record<Locale, Translate>> = {
  en: createTranslator(en),
  ru: createTranslator(ru),
};

export function translatorFor(locale: Locale): Translate {
  return TRANSLATORS[locale];
}
