import { MoodleClient, MoodleError } from "../moodle/client.js";
import type { SiteInfo } from "./login.js";
import { loadCredentials } from "./store.js";

const creds = await loadCredentials();
if (!creds) {
  console.error("Nenhum login salvo. Rode `npm run login`.");
  process.exit(1);
}

try {
  const client = new MoodleClient({ baseUrl: creds.siteUrl, token: creds.token });
  const info = await client.call<SiteInfo>("core_webservice_get_site_info");
  console.log(`${info.fullname} (${info.username}) em ${info.sitename}`);
  console.log(`Moodle ${info.release ?? "?"} · ${info.functions?.length ?? 0} funções liberadas para este token`);
} catch (err) {
  if (err instanceof MoodleError && err.isAuthError) {
    console.error("Token inválido ou expirado. Rode `npm run login` de novo.");
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}
