import { strFromU8, unzipSync } from "fflate";
import { htmlToText } from "../moodle/format.js";

/**
 * Converte arquivos do Moodle em texto para a IA ler.
 * `parts` são páginas (PDF), slides (PPTX) ou planilhas (XLSX); para os demais há uma parte só.
 */
export type Extracted =
  | { kind: "text"; format: string; parts: { label: string; text: string }[] }
  | { kind: "image"; mimeType: string; base64: string }
  | { kind: "unsupported"; reason: string };

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function extractContent(bytes: Uint8Array, mimetype: string): Promise<Extracted> {
  if (mimetype === "application/pdf") return extractPdf(bytes);
  if (mimetype === DOCX) return { kind: "text", format: "DOCX", parts: [{ label: "Documento", text: docxText(bytes) }] };
  if (mimetype === PPTX) return { kind: "text", format: "PPTX", parts: pptxSlides(bytes) };
  if (mimetype === XLSX) return { kind: "text", format: "XLSX", parts: xlsxSheets(bytes) };
  if (mimetype === "text/html") {
    const html = decodeText(bytes);
    const embeds = htmlEmbeds(html);
    const text = [htmlToText(html), embeds.length ? `[Links e conteúdo incorporado]\n${embeds.join("\n")}` : ""]
      .filter(Boolean)
      .join("\n\n");
    return { kind: "text", format: "HTML", parts: [{ label: "Página", text }] };
  }
  if (mimetype.startsWith("text/") || mimetype === "application/json") {
    return { kind: "text", format: mimetype, parts: [{ label: "Texto", text: decodeText(bytes) }] };
  }
  if (IMAGE_TYPES.has(mimetype)) {
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { kind: "unsupported", reason: "Imagem grande demais para enviar à IA (máx. 4 MB)." };
    return { kind: "image", mimeType: mimetype, base64: Buffer.from(bytes).toString("base64") };
  }
  if (mimetype === "application/msword" || mimetype === "application/vnd.ms-powerpoint" || mimetype === "application/vnd.ms-excel") {
    return { kind: "unsupported", reason: "Formato antigo do Office (.doc/.ppt/.xls) não é lido. Use moodle_download_file e abra no computador." };
  }
  return { kind: "unsupported", reason: `Leitura de ${mimetype} não é suportada. Use moodle_download_file para salvar o arquivo.` };
}

/**
 * Vídeos, iframes e links de uma página HTML. Muitas páginas do Moodle são só um
 * vídeo do YouTube incorporado: sem isso o texto extraído ficaria vazio.
 */
export function htmlEmbeds(html: string, limit = 50): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
  const add = (label: string, url: string | undefined) => {
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url) || out.length >= limit) return;
    seen.add(url);
    out.push(`• ${label}: ${url.replace(/&amp;/g, "&")}`);
  };
  for (const m of html.matchAll(/<(iframe|video|source|embed|audio)\b[^>]*>/gi)) {
    const tag = m[0];
    const kind = /youtube|youtu\.be|vimeo|stream\.aspx|video/i.test(tag) || m[1]!.toLowerCase() === "video" ? "Vídeo" : "Incorporado";
    add(attr(tag, "title") ? `${kind} "${attr(tag, "title")}"` : kind, attr(tag, "src"));
  }
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = htmlToText(m[2], 80) || "Link";
    add(`Link "${label}"`, attr(m[1]!, "href"));
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Arquivos antigos em Latin-1 geram muitos caracteres de substituição em UTF-8.
  const broken = (utf8.match(/�/g) ?? []).length;
  const text = broken > 5 ? new TextDecoder("latin1").decode(bytes) : utf8;
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js pode "consumir" o buffer; passa uma cópia.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const parts = text.map((t, i) => ({ label: `Página ${i + 1}`, text: tidy(t) }));
    if (parts.every((p) => !p.text)) {
      return { kind: "unsupported", reason: "PDF sem texto selecionável (provavelmente escaneado). Use moodle_download_file." };
    }
    return { kind: "text", format: "PDF", parts };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

function tidy(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function unzip(bytes: Uint8Array, filter: (name: string) => boolean): Record<string, string> {
  const files = unzipSync(bytes, { filter: (f) => filter(f.name) });
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

/** Texto de parágrafos OOXML: junta <x:t> de cada <x:p>, com tabulações e quebras. */
function ooxmlParagraphs(xml: string, ns: "w" | "a"): string {
  const paras = xml.split(new RegExp(`</${ns}:p>`));
  const lines = paras.map((p) =>
    decodeXmlEntities(
      p
        // Tabulação/quebra dentro do texto viram "runs" de texto para não se perderem.
        // (Só a forma sem atributos: <w:tab w:pos=…/> em <w:tabs> é definição de régua.)
        .replace(new RegExp(`<${ns}:tab/>`, "g"), `<${ns}:t>\t</${ns}:t>`)
        .replace(new RegExp(`<${ns}:br/>`, "g"), `<${ns}:t>\n</${ns}:t>`)
        .replace(new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>`, "g"), "\u0000$1\u0000")
        .split("\u0000")
        .filter((_, i) => i % 2 === 1)
        .join(""),
    ).trimEnd(),
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function docxText(bytes: Uint8Array): string {
  const files = unzip(bytes, (n) => n === "word/document.xml" || /^word\/(footnotes|endnotes)\.xml$/.test(n));
  const body = files["word/document.xml"];
  if (!body) throw new Error("DOCX sem word/document.xml");
  const notes = ["word/footnotes.xml", "word/endnotes.xml"].map((n) => (files[n] ? ooxmlParagraphs(files[n], "w") : "")).filter(Boolean);
  return [ooxmlParagraphs(body, "w"), ...notes].join("\n\n");
}

export function pptxSlides(bytes: Uint8Array): { label: string; text: string }[] {
  const files = unzip(bytes, (n) => /^ppt\/(slides|notesSlides)\/\w+\d+\.xml$/.test(n));
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  return Object.keys(files)
    .filter((n) => n.startsWith("ppt/slides/"))
    .sort((a, b) => num(a) - num(b))
    .map((n) => {
      const i = num(n);
      const notes = files[`ppt/notesSlides/notesSlide${i}.xml`];
      const notesText = notes ? ooxmlParagraphs(notes, "a").replace(/^\d+$/m, "").trim() : "";
      const text = ooxmlParagraphs(files[n]!, "a");
      return { label: `Slide ${i}`, text: notesText ? `${text}\n\n[Notas do apresentador]\n${notesText}` : text };
    });
}

export function xlsxSheets(bytes: Uint8Array): { label: string; text: string }[] {
  const files = unzip(
    bytes,
    (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  const shared = [...(files["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXmlEntities([...m[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );

  // Nomes das abas: workbook.xml (name + r:id) → rels (Id → Target).
  const rels = new Map(
    [...(files["xl/_rels/workbook.xml.rels"] ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[0])?.[1],
      /Target="([^"]+)"/.exec(m[0])?.[1]?.replace(/^\/?xl\//, ""),
    ]),
  );
  const sheets = [...(files["xl/workbook.xml"] ?? "").matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decodeXmlEntities(/name="([^"]*)"/.exec(m[0])?.[1] ?? "Planilha"),
    path: `xl/${rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1]) ?? ""}`,
  }));

  return sheets
    .filter((s) => files[s.path])
    .map((s) => {
      const rows = [...files[s.path]!.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
        const cells: string[] = [];
        for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1]!;
          const inner = c[2] ?? "";
          const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
          const col = ref ? [...ref].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
          const type = /t="(\w+)"/.exec(attrs)?.[1];
          const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
          let value = "";
          if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
          else if (type === "inlineStr") value = decodeXmlEntities(/<t[^>]*>([^<]*)<\/t>/.exec(inner)?.[1] ?? "");
          else if (v !== undefined) value = decodeXmlEntities(v);
          cells[col] = value.replace(/\t|\n/g, " ");
        }
        return Array.from(cells, (x) => x ?? "").join("\t").trimEnd();
      });
      return { label: `Planilha "${s.name}"`, text: rows.filter(Boolean).join("\n") };
    });
}
