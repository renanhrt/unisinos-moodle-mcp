import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CREDENTIALS_FILE, MOODLE_URL } from "../config.js";

export interface StoredCredentials {
  siteUrl: string;
  token: string;
  userid: number;
  fullname: string;
  username: string;
  createdAt: string;
}

/**
 * Lê as credenciais. MOODLE_TOKEN no ambiente tem prioridade (útil para testes);
 * senão usa o arquivo salvo por `npm run login`.
 */
export async function loadCredentials(): Promise<Pick<StoredCredentials, "siteUrl" | "token"> | null> {
  if (process.env.MOODLE_TOKEN) return { siteUrl: MOODLE_URL, token: process.env.MOODLE_TOKEN };
  try {
    const data = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")) as StoredCredentials;
    if (!data.token || !data.siteUrl) return null;
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await mkdir(dirname(CREDENTIALS_FILE), { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function deleteCredentials(): Promise<void> {
  await rm(CREDENTIALS_FILE, { force: true });
}
