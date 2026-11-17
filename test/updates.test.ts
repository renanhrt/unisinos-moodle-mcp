import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetSession } from "../src/moodle/session.js";

const SITE = "https://www.moodle.unisinos.br";
const NOW = Math.floor(Date.now() / 1000);
const H = 3600;
const DAY = 86_400;
const realFetch = globalThis.fetch;
const FULL = "2026/2 - Álgebra Linear e Geometria Analítica - GR10001-00001-100001 - 10BSEMI - MARIA DA SILVA SOUZA - Unisinos São Leopoldo - Sede";

let log: { fn: string; body: URLSearchParams }[];
let brokenCmid: number | null;

const MODULES = [
  { id: 10, name: "Slides aula 5", modname: "resource", instance: 100, url: `${SITE}/mod/resource/view.php?id=10` },
  { id: 11, name: "Fórum de Avisos", modname: "forum", instance: 110, url: `${SITE}/mod/forum/view.php?id=11` },
  { id: 12, name: "EXERCÍCIO 2", modname: "quiz", instance: 120, url: `${SITE}/mod/quiz/view.php?id=12` },
  { id: 13, name: "Trabalho 1", modname: "assign", instance: 130, url: `${SITE}/mod/assign/view.php?id=13` },
  { id: 14, name: "Aviso", modname: "label", instance: 140 },
];

before(() => {
  process.env.MOODLE_TOKEN = "e".repeat(32);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const fn = new URL(String(url)).searchParams.get("wsfunction")!;
    const body = new URLSearchParams(String(init?.body));
    log.push({ fn, body });
    const reply = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const tocheck = () => [...body.entries()].filter(([k]) => /^tocheck\[\d+\]\[id\]$/.test(k)).map(([, v]) => Number(v));
    switch (fn) {
      case "core_webservice_get_site_info":
        return reply({ sitename: "M", siteurl: SITE, userid: 7, username: "a", fullname: "A" });
      case "core_enrol_get_users_courses":
        return reply([{ id: 501, shortname: "x", fullname: FULL }]);
      case "core_course_get_contents":
        return reply([{ id: 1, name: "Semana 1", modules: MODULES }]);
      case "core_course_check_updates": {
        const ids = tocheck();
        if (ids.includes(12) || (brokenCmid !== null && ids.includes(brokenCmid))) {
          return reply({ exception: "dml_read_exception", errorcode: "dmlreadexception", message: "Error reading from database" });
        }
        return reply({
          instances: ids.map((id) => ({
            contextlevel: "module",
            id,
            updates: id === 10 ? [{ name: "contentfiles" }, { name: "configuration" }] : id === 11 ? [{ name: "discussions" }] : [],
          })),
          warnings: [],
        });
      }
      case "message_popup_get_popup_notifications":
        return reply({
          unreadcount: 2,
          notifications: [
            { id: 5, subject: `${FULL} content change`, smallmessage: `Questionário EXERCÍCIO 2 has been changed in the course ${FULL}.Change your notification preferences`, timecreated: NOW - 2 * H, read: false, component: "moodle", eventtype: "coursecontentupdated" },
            { id: 4, subject: "Antiga", smallmessage: "Antiga", timecreated: NOW - 5 * DAY, read: true, component: "moodle", eventtype: "coursecontentupdated" },
          ],
        });
      case "core_calendar_get_calendar_events":
        return reply({
          events: [
            { id: 3, name: "Trabalho 1 vence", courseid: 501, modulename: "assign", instance: 130, eventtype: "due", timestart: NOW + 2 * DAY, timeduration: 0, description: "<p>enunciado</p>" },
            { id: 2, name: "Encontro síncrono", courseid: 501, modulename: "", instance: 0, eventtype: "course", timestart: NOW + DAY, timeduration: 2 * H, location: "Sala virtual", description: "<p>Aula ao vivo pelo Teams</p>" },
            { id: 1, name: "Abertura do Exercício 1", courseid: 501, modulename: "quiz", instance: 120, eventtype: "open", timestart: NOW - DAY, timeduration: 0 },
            { id: 4, name: "Estudar", courseid: 0, modulename: "", eventtype: "user", timestart: NOW + 3 * DAY, timeduration: 0 },
          ],
          warnings: [],
        });
      case "core_message_mark_all_notifications_as_read":
        return reply(true);
      case "core_message_mark_notification_read":
        return reply({ notificationid: Number(body.get("notificationid")), warnings: [] });
      case "core_message_mark_all_conversation_messages_as_read":
        return reply(null);
      case "message_popup_get_unread_popup_notification_count":
        return reply(0);
      default:
        return reply({ exception: "x", errorcode: "notmocked", message: fn });
    }
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.MOODLE_TOKEN;
});

beforeEach(() => {
  resetSession();
  log = [];
  brokenCmid = null;
});

async function connect() {
  const server = createServer();
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError === true, text: r.content[0]!.text, json: () => JSON.parse(r.content[0]!.text) };
}
const checkedIds = () => log.filter((l) => l.fn === "core_course_check_updates").flatMap((l) => [...l.body.entries()].filter(([k]) => /\[id\]$/.test(k)).map(([, v]) => Number(v)));

test("novidades: atividades alteradas + notificações; questionários e rótulos não são verificados", async () => {
  const client = await connect();
  const r = (await tool(client, "moodle_whats_new", { days: 1 })).json();
  assert.equal(r.courses[0].course, "Álgebra Linear e Geometria Analítica");
  assert.deepEqual(r.courses[0].changes, [
    { activity: "Slides aula 5", type: "resource", cmid: 10, what: ["arquivos novos ou alterados", "descrição ou configuração alterada"], url: `${SITE}/mod/resource/view.php?id=10` },
    { activity: "Fórum de Avisos", type: "forum", cmid: 11, what: ["tópicos novos ou atualizados"], url: `${SITE}/mod/forum/view.php?id=11` },
  ]);
  assert.ok(!checkedIds().includes(12), "quiz nunca vai para check_updates");
  assert.ok(!checkedIds().includes(14), "rótulo não é verificado");
  assert.deepEqual(r.notifications.map((n: { text: string }) => n.text), ["Questionário EXERCÍCIO 2 has been changed in the course Álgebra Linear e Geometria Analítica"]);
  assert.match(r.note, /Questionários não entram/);
  assert.doesNotMatch(r.note, /Também não foi possível/);
});

test("novidades: atividade que quebra a API é isolada e pulada, sem perder as outras", async () => {
  brokenCmid = 13;
  const client = await connect();
  const r = (await tool(client, "moodle_whats_new", { days: 1 })).json();
  assert.equal(r.courses[0].changes.length, 2);
  assert.match(r.note, /Também não foi possível verificar: Trabalho 1 \(Álgebra Linear e Geometria Analítica\)/);
});

test("novidades: muitas mudanças só de configuração viram um resumo", async () => {
  const extra = Array.from({ length: 8 }, (_, i) => ({ id: 200 + i, name: `Leitura ${i + 1}`, modname: "url", instance: 300 + i }));
  MODULES.push(...extra);
  const realFetchInner = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const fn = new URL(String(url)).searchParams.get("wsfunction");
    if (fn === "core_course_check_updates") {
      const body = new URLSearchParams(String(init?.body));
      const ids = [...body.entries()].filter(([k]) => /\[id\]$/.test(k)).map(([, v]) => Number(v));
      return new Response(
        JSON.stringify({
          instances: ids.map((id) => ({ contextlevel: "module", id, updates: id >= 200 ? [{ name: "configuration" }] : id === 10 ? [{ name: "contentfiles" }] : [] })),
          warnings: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return realFetchInner(url, init);
  }) as typeof fetch;
  try {
    const client = await connect();
    const r = (await tool(client, "moodle_whats_new", { days: 1 })).json();
    assert.deepEqual(r.courses[0].changes.map((c: { activity: string }) => c.activity), ["Slides aula 5"]);
    assert.match(r.courses[0].alsoChangedSettings, /^8 atividades tiveram só a descrição ou configuração alterada.*ex\.: Leitura 1; Leitura 2; Leitura 3; Leitura 4; Leitura 5$/);
  } finally {
    globalThis.fetch = realFetchInner;
    MODULES.splice(MODULES.length - extra.length, extra.length);
  }
});

test("calendário: ordenado, com tipo, disciplina, horário, local e link", async () => {
  const client = await connect();
  const ev = (await tool(client, "moodle_calendar", { days: 7, pastDays: 2 })).json();
  assert.deepEqual(ev.map((e: { event: string }) => e.event), ["Abertura do Exercício 1", "Encontro síncrono", "Trabalho 1 vence", "Estudar"]);
  assert.equal(ev[0].past, true);
  assert.equal(ev[0].type, "abre");
  assert.equal(ev[0].url, `${SITE}/mod/quiz/view.php?id=12`);
  assert.equal(ev[1].type, "evento da disciplina");
  assert.match(ev[1].time, /^\d\d:\d\d–\d\d:\d\d$/);
  assert.equal(ev[1].location, "Sala virtual");
  assert.equal(ev[1].description, "Aula ao vivo pelo Teams");
  assert.equal(ev[1].course, "Álgebra Linear e Geometria Analítica");
  assert.equal(ev[2].description, undefined, "eventos de atividade não repetem o enunciado");
  assert.equal(ev[3].type, "evento pessoal");
  assert.equal(ev[3].course, undefined);
  const call = log.find((l) => l.fn === "core_calendar_get_calendar_events")!.body;
  assert.equal(call.get("events[courseids][0]"), "501");
  assert.ok(Number(call.get("options[timestart]")) < NOW - DAY);
});

test("marcar como lido: tudo, ids e conversa; sem alvo dá erro", async () => {
  const client = await connect();
  const none = await tool(client, "moodle_mark_read", {});
  assert.equal(none.isError, true);
  assert.match(none.text, /Diga o que marcar/);

  const all = (await tool(client, "moodle_mark_read", { allNotifications: true, conversationId: 900 })).json();
  assert.equal(all.marked, "todas as notificações e a conversa 900");
  assert.equal(all.unreadNotificationsNow, 0);
  assert.equal(log.find((l) => l.fn === "core_message_mark_all_conversation_messages_as_read")!.body.get("conversationid"), "900");

  log = [];
  const some = (await tool(client, "moodle_mark_read", { notificationIds: [5, 6] })).json();
  assert.equal(some.marked, "2 notificação(ões)");
  assert.deepEqual(log.filter((l) => l.fn === "core_message_mark_notification_read").map((l) => l.body.get("notificationid")), ["5", "6"]);

  const list = (await tool(client, "moodle_list_notifications", {})).json();
  assert.equal(list.notifications[0].id, 5);
});
