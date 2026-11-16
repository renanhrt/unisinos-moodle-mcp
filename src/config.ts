import { homedir } from "node:os";
import { join } from "node:path";

/** URL raiz do Moodle (sem barra no final). Pode ser trocada por MOODLE_URL. */
export const MOODLE_URL = (process.env.MOODLE_URL ?? "https://www.moodle.unisinos.br").replace(/\/+$/, "");

/** Serviço de Web Services usado pelo app oficial do Moodle. */
export const MOODLE_SERVICE = process.env.MOODLE_SERVICE ?? "moodle_mobile_app";

/** Idioma das mensagens devolvidas pelo Moodle (ex.: "Adicionar envio"). */
export const MOODLE_LANG = process.env.MOODLE_LANG ?? "pt_br";

/** Fuso usado para mostrar datas. */
export const TIMEZONE = process.env.MOODLE_TIMEZONE ?? "America/Sao_Paulo";

/**
 * Pasta de dados local, fora do repositório: guarda o token e o perfil do navegador
 * usado no login. Pode ser trocada por UNISINOS_MOODLE_HOME.
 */
export const DATA_DIR = process.env.UNISINOS_MOODLE_HOME ?? join(homedir(), ".unisinos-moodle-mcp");

export const CREDENTIALS_FILE = join(DATA_DIR, "credentials.json");
export const BROWSER_PROFILE_DIR = join(DATA_DIR, "browser-profile");
