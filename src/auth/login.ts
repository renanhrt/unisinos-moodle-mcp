import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { BROWSER_PROFILE_DIR, MOODLE_SERVICE, MOODLE_URL } from "../config.js";
import { MoodleClient } from "../moodle/client.js";
import { buildLaunchUrl, decodeLaunchToken, findLaunchToken, newPassport } from "./launch-token.js";
import { saveCredentials, type StoredCredentials } from "./store.js";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Tenta Edge (sempre presente no Windows), depois Chrome, depois o Chromium do Playwright. */
async function openBrowser(): Promise<BrowserContext> {
  await mkdir(BROWSER_PROFILE_DIR, { recursive: true });
  const preferred = process.env.MOODLE_BROWSER_CHANNEL;
  const channels = preferred ? [preferred] : ["msedge", "chrome", undefined];
  let lastError: unknown;
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
        headless: false,
        channel,
        viewport: null,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    "Não consegui abrir um navegador (Edge, Chrome ou Chromium). " +
      "Instale o Chromium com `npx playwright-core install chromium` ou defina MOODLE_BROWSER_CHANNEL.\n" +
      String(lastError),
  );
}

/**
 * Espera o Moodle devolver `moodlemobile://token=...`. O token pode chegar:
 *  - no header Location de um redirect (caso comum);
 *  - como tentativa de navegação para o esquema moodlemobile://;
 *  - num link da página de confirmação do launch.php.
 */
function waitForLaunchToken(context: BrowserContext, page: Page): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done || !value) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error("Tempo esgotado (5 min) esperando o login."));
      }
    }, LOGIN_TIMEOUT_MS);

    context.on("response", (res) => {
      const status = res.status();
      if (status >= 300 && status < 400) finish(findLaunchToken(res.headers()["location"]));
    });
    context.on("request", (req) => finish(findLaunchToken(req.url())));
    context.on("requestfailed", (req) => finish(findLaunchToken(req.url())));

    const scanPage = async (p: Page) => {
      try {
        if (!p.url().includes("/admin/tool/mobile/launch.php")) return;
        finish(findLaunchToken(await p.content()));
      } catch {
        /* página navegou no meio da leitura */
      }
    };
    const watch = (p: Page) => {
      p.on("load", () => void scanPage(p));
      p.on("domcontentloaded", () => void scanPage(p));
    };
    watch(page);
    context.on("page", watch);

    page.on("close", () => {
      if (!done && context.pages().length === 0) {
        done = true;
        clearTimeout(timer);
        reject(new Error("O navegador foi fechado antes de concluir o login."));
      }
    });
  });
}

export interface SiteInfo {
  sitename: string;
  siteurl: string;
  userid: number;
  username: string;
  fullname: string;
  release?: string;
  functions?: { name: string; version: string }[];
}

/** Abre o navegador, espera o login SSO e salva o token validado. */
export async function login(log: (msg: string) => void = console.error): Promise<StoredCredentials> {
  const passport = newPassport();
  const launchUrl = buildLaunchUrl(MOODLE_URL, MOODLE_SERVICE, passport);

  log("Abrindo o navegador. Faça login com sua conta Microsoft da Unisinos.");
  log("Se aparecer uma página pedindo para abrir o app, clique no botão para continuar.");
  const context = await openBrowser();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const tokenPromise = waitForLaunchToken(context, page);
    await page.goto(launchUrl).catch(() => {
      /* o próprio redirect para moodlemobile:// pode abortar a navegação */
    });
    const encoded = await tokenPromise;

    const { token } = decodeLaunchToken(encoded, MOODLE_URL, passport);
    const client = new MoodleClient({ baseUrl: MOODLE_URL, token });
    const info = await client.call<SiteInfo>("core_webservice_get_site_info");

    const creds: StoredCredentials = {
      siteUrl: MOODLE_URL,
      token,
      userid: info.userid,
      fullname: info.fullname,
      username: info.username,
      createdAt: new Date().toISOString(),
    };
    await saveCredentials(creds);
    return creds;
  } finally {
    await context.close().catch(() => {});
  }
}
