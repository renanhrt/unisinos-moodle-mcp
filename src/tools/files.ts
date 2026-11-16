import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { downloadDir } from "../config.js";
import { extractContent, type Extracted } from "../extract/index.js";
import type { MoodleClient } from "../moodle/client.js";
import { filenameFromUrl, guessMimetype, saveDownload } from "../moodle/files.js";
import { formatBytes } from "../moodle/format.js";
import { getSession } from "../moodle/session.js";
import { describeError, runTool } from "./helpers.js";

const FILEURL_DESC =
  "fileurl de um arquivo do Moodle, como devolvido por moodle_get_course_contents, moodle_list_assignments ou moodle_get_assignment_status";

/** Cache pequeno do texto extraído, para paginar (offset) sem baixar de novo. */
const cache = new Map<string, { filename: string; mimetype: string; size: number; content: Extracted }>();
const CACHE_LIMIT = 8;

async function fetchAndExtract(client: MoodleClient, fileurl: string) {
  const key = client.checkFileUrl(fileurl).toString();
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const { bytes, contentType } = await client.downloadFile(fileurl);
  const filename = filenameFromUrl(fileurl);
  const mimetype = guessMimetype(filename, contentType);
  const entry = { filename, mimetype, size: bytes.byteLength, content: await extractContent(bytes, mimetype) };
  cache.set(key, entry);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return entry;
}

/** "1-3,5" → {1,2,3,5}. Vazio/undefined → null (todas). */
export function parseRanges(spec: string | undefined, max: number): Set<number> | null {
  if (!spec?.trim()) return null;
  const out = new Set<number>();
  for (const piece of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(piece);
    if (!m) throw new Error(`Intervalo inválido: "${piece.trim()}". Use algo como "1-3,5".`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(max, Math.max(a, b)); i++) out.add(i);
  }
  return out;
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    "moodle_read_file",
    {
      title: "Ler arquivo do Moodle",
      description:
        "Baixa um arquivo do Moodle e devolve o conteúdo como texto para leitura/resumo: PDF (por página), PPTX (por slide, com notas), " +
        "DOCX, XLSX (por aba), HTML e texto. Imagens voltam como imagem. Textos longos vêm em partes: use offset para continuar.",
      inputSchema: {
        fileurl: z.string().url().describe(FILEURL_DESC),
        parts: z
          .string()
          .optional()
          .describe('páginas/slides/abas a ler, ex.: "1-5" ou "2,4,7" (padrão: todas)'),
        offset: z.number().int().min(0).default(0).describe("posição (em caracteres) para continuar a leitura"),
        maxChars: z.number().int().min(1000).max(100_000).default(30_000).describe("máximo de caracteres nesta resposta"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ fileurl, parts, offset, maxChars }): Promise<CallToolResult> => {
      try {
        const { client } = await getSession();
        const file = await fetchAndExtract(client, fileurl);
        const { content } = file;

        if (content.kind === "unsupported") {
          return { isError: true, content: [{ type: "text", text: `${file.filename}: ${content.reason}` }] };
        }
        if (content.kind === "image") {
          return {
            content: [
              { type: "text", text: `${file.filename} (${content.mimeType}, ${formatBytes(file.size)})` },
              { type: "image", data: content.base64, mimeType: content.mimeType },
            ],
          };
        }

        const wanted = parseRanges(parts, content.parts.length);
        const selected = content.parts.filter((_, i) => !wanted || wanted.has(i + 1));
        const multi = content.parts.length > 1;
        const full = selected
          .map((p) => (multi ? `--- ${p.label} ---\n${p.text || "(sem texto)"}` : p.text))
          .join("\n\n");

        const chunk = full.slice(offset, offset + maxChars);
        const end = offset + chunk.length;
        const header = [
          `Arquivo: ${file.filename} (${content.format}, ${formatBytes(file.size)}${multi ? `, ${content.parts.length} partes` : ""})`,
          `Caracteres ${offset}–${end} de ${full.length}.` +
            (end < full.length ? ` Para continuar, chame moodle_read_file com offset=${end}.` : " Fim do conteúdo."),
        ].join("\n");
        return { content: [{ type: "text", text: `${header}\n\n${chunk}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: describeError(err) }] };
      }
    },
  );

  server.registerTool(
    "moodle_download_file",
    {
      title: "Baixar arquivo do Moodle",
      description:
        `Salva um arquivo do Moodle no computador do aluno (padrão: ~/Downloads/Moodle Unisinos). ` +
        "Use folder para organizar por disciplina. Não baixa de novo se o arquivo igual já existir.",
      inputSchema: {
        fileurl: z.string().url().describe(FILEURL_DESC),
        folder: z.string().max(120).optional().describe("subpasta, ex.: o nome curto da disciplina"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ fileurl, folder }) =>
      runTool(async ({ client }) => {
        const { bytes, contentType } = await client.downloadFile(fileurl);
        const filename = filenameFromUrl(fileurl);
        const { path, reused } = await saveDownload(downloadDir(), folder, filename, bytes);
        return {
          saved: path,
          size: formatBytes(bytes.byteLength),
          mimetype: guessMimetype(filename, contentType),
          note: reused ? "já existia um arquivo idêntico; nada foi sobrescrito" : undefined,
        };
      }),
  );
}
