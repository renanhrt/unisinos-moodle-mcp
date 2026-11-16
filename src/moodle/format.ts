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
  // símbolos comuns em enunciados de matemática
  middot: "·",
  times: "×",
  divide: "÷",
  plusmn: "±",
  minus: "−",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  equiv: "≡",
  infin: "∞",
  deg: "°",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  radic: "√",
  sum: "∑",
  prod: "∏",
  int: "∫",
  part: "∂",
  nabla: "∇",
  forall: "∀",
  exist: "∃",
  empty: "∅",
  isin: "∈",
  notin: "∉",
  cap: "∩",
  cup: "∪",
  sub: "⊂",
  sube: "⊆",
  sup: "⊃",
  supe: "⊇",
  perp: "⊥",
  rarr: "→",
  larr: "←",
  harr: "↔",
  rArr: "⇒",
  lArr: "⇐",
  hArr: "⇔",
};

// Letras gregas: &alpha; &Delta; …
for (const [i, name] of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigmaf", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega"].entries()) {
  ENTITIES[name] = String.fromCodePoint(0x3b1 + i);
  if (name !== "sigmaf") ENTITIES[name[0]!.toUpperCase() + name.slice(1)] = String.fromCodePoint(0x391 + i);
}

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
    .replace(/\r\n?/g, "\n")
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

export interface UnisinosCourseName {
  semester: string;
  name: string;
  code: string;
  schedule?: string;
  group?: string;
  teacher?: string;
  campus?: string;
}

const LOWER_WORDS = new Set(["de", "da", "do", "das", "dos", "e"]);

function titleCaseIfShouting(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && LOWER_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Separa o nome longo das disciplinas da Unisinos:
 * "2026/2 - Álgebra Linear - GR10001-00001-100001 - 10BSEMI - PROFESSOR - Unisinos São Leopoldo - Sede"
 * "2026/2 - Projeto ... - GR10002-00002-100002 - QUI - 19:30 - 20SSEMI - Professora"
 * Devolve null se o nome não seguir esse padrão.
 */
export function parseUnisinosCourseName(fullname: string): UnisinosCourseName | null {
  const parts = fullname.split(" - ").map((p) => p.trim());
  if (!/^\d{4}\/\d$/.test(parts[0] ?? "")) return null;
  const codeIdx = parts.findIndex((p) => /^[A-Z]{2}\d+-\d+-\d+$/.test(p));
  if (codeIdx < 2) return null;

  const rest = parts.slice(codeIdx + 1);
  const groupIdx = rest.findIndex((p) => /^\d+[A-Z]+$/.test(p));
  const schedule = groupIdx > 0 ? rest.slice(0, groupIdx).join(" ") : undefined;
  const afterGroup = groupIdx >= 0 ? rest.slice(groupIdx + 1) : rest;

  return compact({
    semester: parts[0]!,
    name: parts.slice(1, codeIdx).join(" - "),
    code: parts[codeIdx]!,
    schedule,
    group: groupIdx >= 0 ? rest[groupIdx] : undefined,
    teacher: afterGroup[0] ? titleCaseIfShouting(afterGroup[0]) : undefined,
    campus: afterGroup.length > 1 ? afterGroup.slice(1).join(" - ") : undefined,
  }) as UnisinosCourseName;
}

/**
 * Troca, dentro de um texto, o nome longo das disciplinas pelo nome curto. Funciona mesmo
 * quando o Moodle cortou o nome no meio (comum em notificações).
 */
export function shortenCourseNamesIn(text: string, fullnames: string[]): string {
  let out = text;
  for (const full of fullnames) {
    const p = parseUnisinosCourseName(full);
    if (!p) continue;
    const prefix = `${p.semester} - ${p.name} - ${p.code}`;
    let idx: number;
    while ((idx = out.indexOf(prefix)) !== -1) {
      let i = idx;
      let j = 0;
      while (i < out.length && j < full.length && out[i] === full[j]) {
        i++;
        j++;
      }
      // não deixa sobrar " - " ou espaço solto do nome cortado
      const rest = out.slice(i).replace(/^\s*-?\s*$/, "");
      out = out.slice(0, idx) + p.name + (rest && !/^\s/.test(rest) ? " " : "") + rest;
    }
  }
  return out.trim();
}

/** Nome curto da disciplina (sem semestre, código, turma etc.). */
export function shortCourseName(fullname: string | undefined): string | undefined {
  if (!fullname) return fullname;
  return parseUnisinosCourseName(fullname)?.name ?? fullname;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
