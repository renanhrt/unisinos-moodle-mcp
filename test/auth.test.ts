import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client as ClientT } from "@modelcontextprotocol/sdk/client/index.js";

// Pasta de dados isolada ANTES de carregar o servidor (config.ts lê na importação).
const home = mkdtempSync(join(tmpdir(), "moodle-auth-"));
process.env.UNISINOS_MOODLE_HOME = home;
delete process.env.MOODLE_TOKEN;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../src/server.js");
const { resetSession } = await import("../src/moodle/session.js");
const { saveCredentials } = await import("../src/auth/store.js");
const { setLoginImplForTests } = await import("../src/tools/auth.js");

const SITE = "https://www.moodle.unisinos.br";
const TOKEN = "d".repeat(32);
const realFetch = globalThis.fetch;
let tokenValid = true;

before(() => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const fn = new URL(String(url)).searchParams.get("wsfunction");
    const body = new URLSearchParams(String(init?.body));
    const reply = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    if (body.get("wstoken") !== TOKEN || !tokenValid) return reply({ exception: "x", errorcode: "invalidtoken", message: "Invalid token" });
    if (fn === "core_webservice_get_site_info") return reply({ sitename: "Moodle", siteurl: SITE, userid: 7, username: "ana", fullname: "Ana Teste" });
    if (fn === "core_enrol_get_users_courses") return reply([]);
    return reply({ exception: "x", errorcode: "notmocked", message: String(fn) });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  tokenValid = true;
  rmSync(join(home, "credentials.json"), { force: true });
  resetSession();
});

async function connect(): Promise<ClientT> {
  const server = createServer();
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
async function tool(client: ClientT, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError === true, text: r.content[0]!.text };
}

const fakeLogin = async () => {
  const creds = { siteUrl: SITE, token: TOKEN, userid: 7, username: "ana", fullname: "Ana Teste", createdAt: new Date().toISOString() };
  await saveCredentials(creds);
  return creds;
};

test("sem login, as ferramentas mandam usar moodle_login", async () => {
  const client = await connect();
  const r = await tool(client, "moodle_list_courses");
  assert.equal(r.isError, true);
  assert.match(r.text, /moodle_login/);
});

test("login rápido conecta e as ferramentas passam a funcionar", async () => {
  setLoginImplForTests(fakeLogin, 2000);
  const client = await connect();
  const r = await tool(client, "moodle_login");
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /✅ Conectado ao Moodle como Ana Teste \(ana\)/);
  assert.ok(existsSync(join(home, "credentials.json")));
  const me = JSON.parse((await tool(client, "moodle_get_me")).text);
  assert.equal(me.fullname, "Ana Teste");

  const again = await tool(client, "moodle_login");
  assert.match(again.text, /Já está conectado ao Moodle como Ana Teste/);
});

test("login demorado: responde na hora e confirma quando terminar", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  setLoginImplForTests(async () => {
    await gate;
    // mais lento que a espera de uma chamada (50 ms): o login termina só depois de outra tentativa
    await new Promise((r) => setTimeout(r, 200));
    return fakeLogin();
  }, 50);
  const client = await connect();
  const first = await tool(client, "moodle_login");
  assert.equal(first.isError, false);
  assert.match(first.text, /Abri uma janela do navegador/);

  const stillWaiting = await tool(client, "moodle_login");
  assert.match(stillWaiting.text, /Abri uma janela do navegador/);

  finish();
  // Chama de novo até terminar, sem depender da velocidade da máquina (limite: ~10 s).
  let done = await tool(client, "moodle_login");
  for (let i = 0; i < 200 && /Abri uma janela/.test(done.text); i++) done = await tool(client, "moodle_login");
  assert.equal(done.isError, false, done.text);
  assert.match(done.text, /✅ Conectado/);
});

test("erro no login é informado e permite tentar de novo", async () => {
  setLoginImplForTests(async () => {
    throw new Error("O navegador foi fechado antes de concluir o login.");
  }, 2000);
  const client = await connect();
  const r = await tool(client, "moodle_login");
  assert.equal(r.isError, true);
  assert.match(r.text, /não foi concluído: O navegador foi fechado/);

  setLoginImplForTests(fakeLogin, 2000);
  assert.match((await tool(client, "moodle_login")).text, /✅ Conectado/);
});

test("token expirado: login é refeito; logout apaga o acesso", async () => {
  await fakeLogin();
  tokenValid = false;
  setLoginImplForTests(async () => {
    tokenValid = true;
    return fakeLogin();
  }, 2000);
  const client = await connect();
  const expired = await tool(client, "moodle_get_me");
  assert.match(expired.text, /expirou.*moodle_login/);
  assert.match((await tool(client, "moodle_login")).text, /✅ Conectado/);

  const out = await tool(client, "moodle_logout");
  assert.match(out.text, /Desconectado/);
  assert.equal(existsSync(join(home, "credentials.json")), false);
  assert.match((await tool(client, "moodle_get_me")).text, /moodle_login/);
});
