import type { SiteInfo } from "../auth/login.js";
import { loadCredentials } from "../auth/store.js";
import { MOODLE_LANG } from "../config.js";
import { MoodleClient } from "./client.js";

export class NotLoggedInError extends Error {
  constructor() {
    super("Nenhum login do Moodle encontrado. Rode `npm run login` no projeto unisinos-moodle-mcp.");
    this.name = "NotLoggedInError";
  }
}

export interface Session {
  client: MoodleClient;
  site: SiteInfo;
}

let cached: Promise<Session> | null = null;

/** Cliente autenticado + dados do usuário, carregados uma vez por processo. */
export function getSession(): Promise<Session> {
  if (!cached) {
    cached = (async () => {
      const creds = await loadCredentials();
      if (!creds) throw new NotLoggedInError();
      const client = new MoodleClient({ baseUrl: creds.siteUrl, token: creds.token, lang: MOODLE_LANG });
      const site = await client.call<SiteInfo>("core_webservice_get_site_info");
      return { client, site };
    })();
    // Se falhar (token expirado, rede), tenta de novo na próxima chamada.
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

/** Esquece a sessão (ex.: depois de um erro de token), relendo as credenciais na próxima chamada. */
export function resetSession(): void {
  cached = null;
}
