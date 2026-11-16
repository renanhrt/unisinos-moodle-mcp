import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
};

/** Nome do arquivo a partir do pluginfile URL (último trecho do caminho). */
export function filenameFromUrl(fileurl: string): string {
  const last = new URL(fileurl).pathname.split("/").pop() ?? "arquivo";
  try {
    return decodeURIComponent(last) || "arquivo";
  } catch {
    return last || "arquivo";
  }
}

/** Mimetype pelo header (se útil) ou pela extensão. */
export function guessMimetype(filename: string, contentType?: string | null): string {
  const header = contentType?.split(";")[0]?.trim().toLowerCase();
  if (header && header !== "application/octet-stream" && header !== "application/x-forcedownload") return header;
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/** Torna um nome seguro para Windows/macOS/Linux, sem permitir subir de pasta. */
export function safeName(name: string, fallback = "arquivo"): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 150);
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned)) return fallback;
  return cleaned;
}

/**
 * Salva os bytes em baseDir/[folder]/filename. Se já existir um arquivo com o mesmo
 * nome e tamanho, não baixa de novo; se existir com tamanho diferente, cria "nome (2).ext".
 */
export async function saveDownload(
  baseDir: string,
  folder: string | undefined,
  filename: string,
  bytes: Uint8Array,
): Promise<{ path: string; reused: boolean }> {
  const root = resolve(baseDir);
  const dir = folder ? join(root, safeName(folder, "Moodle")) : root;
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error("Pasta de destino inválida.");
  await mkdir(dir, { recursive: true });

  const name = safeName(filename);
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 100; i++) {
    const candidate = join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    const existing = await stat(candidate).catch(() => null);
    if (!existing) {
      await writeFile(candidate, bytes);
      return { path: candidate, reused: false };
    }
    if (existing.size === bytes.byteLength) return { path: candidate, reused: true };
  }
  throw new Error("Muitos arquivos com o mesmo nome na pasta de destino.");
}
