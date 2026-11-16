import { TIMEZONE } from "../config.js";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  ordm: "º",
  ordf: "ª",
};

// Acentos usados em português: &aacute; &atilde; &ccedil; &Ecirc; ...
const ACCENTS: Record<string, string> = { acute: "́", grave: "̀", tilde: "̃", circ: "̂", uml: "̈", cedil: "̧" };
for (const [suffix, mark] of Object.entries(ACCENTS)) {
  for (const letter of "aeioucnAEIOUCN") {
    const composed = (letter + mark).normalize("NFC");
    if (composed.length === 1) ENTITIES[letter + suffix] = composed;
  }
}

/** Converte o HTML do Moodle em texto simples e compacto para a IA. */
export function htmlToText(html: string | null | undefined, maxLength?: number): string {
  if (!html) return "";
  let text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (maxLength && text.length > maxLength) text = text.slice(0, maxLength - 1).trimEnd() + "…";
  return text;
}

/** Timestamp Unix do Moodle → data legível no fuso local. 0/ausente → null. */
export function formatDate(unix: number | null | undefined): string | null {
  if (!unix) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(unix * 1000));
}

export function formatBytes(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Remove chaves com valor null/undefined/""/[] para encurtar o JSON devolvido. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
    ),
  ) as Partial<T>;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
