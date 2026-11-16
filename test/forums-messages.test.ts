import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetSession } from "../src/moodle/session.js";

const SITE = "https://www.moodle.unisinos.br";
const ME = 7;
const NOW = Math.floor(Date.now() / 1000);
const realFetch = globalThis.fetch;

let calls: { fn: string; body: URLSearchParams }[];
let canReply: boolean;
let canAddDiscussion: boolean;
let memberInfo: Record<string, unknown>;
let hasConversationWith42: boolean;

function post(id: number, author: { id: number; fullname: string }, extra: Record<string, unknown> = {}) {
  return {
    id,
    subject: id === 1 ? "Aviso da prova" : "Re: Aviso da prova",
    message: id === 1 ? "<p>A prova é <b>sexta</b>.</p>" : "<p>Obrigado!</p>",
    author,
    discussionid: 10,
    hasparent: id !== 1,
    parentid: id === 1 ? null : 1,
    timecreated: NOW - (10 - id) * 60,
    isdeleted: false,
    isprivatereply: false,
    capabilities: { reply: canReply, delete: author.id === ME, edit: author.id === ME },
    attachments: id === 1 ? [{ filename: "edital.pdf", url: `${SITE}/pluginfile.php/5/mod_forum/attachment/1/edital.pdf` }] : [],
    ...extra,
  };
}
const PROF = { id: 99, fullname: "Prof. Oliveira" };
const EU = { id: ME, fullname: "Aluno Teste" };

before(() => {
  process.env.MOODLE_TOKEN = "b".repeat(32);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const fn = new URL(String(url)).searchParams.get("wsfunction")!;
    const body = new URLSearchParams(String(init?.body));
    calls.push({ fn, body });
    const reply = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const ex = (errorcode: string) => reply({ exception: "moodle_exception", errorcode, message: errorcode });
    switch (fn) {
      case "core_webservice_get_site_info":
        return reply({ sitename: "M", siteurl: SITE, userid: ME, username: "a", fullname: "Aluno Teste" });
      case "core_enrol_get_users_courses":
        return reply([{ id: 1, shortname: "x", fullname: "2026/2 - Algoritmos e Programação: Fundamentos - GR10003-00003-100003 - 10ASEMI - Pedro Oliveira" }]);
      case "mod_forum_get_forums_by_courses":
        return reply([
          { id: 300, course: 1, cmid: 30, type: "news", name: "Fórum de Avisos", numdiscussions: 2, cancreatediscussions: false },
          { id: 301, course: 1, cmid: 31, type: "general", name: "Dúvidas", numdiscussions: 0, cancreatediscussions: true },
        ]);
      case "mod_forum_can_add_discussion":
        return reply({ status: canAddDiscussion });
      case "mod_forum_get_forum_discussions":
        return reply({ discussions: [{ id: 1, discussion: 10, name: "Aviso da prova", subject: "Aviso da prova", message: "<p>A prova é sexta.</p>", userfullname: "Prof. Oliveira", created: NOW - 600, timemodified: NOW - 60, numreplies: 1, numunread: 1, pinned: true, locked: false, canreply: canReply }] });
      case "mod_forum_get_discussion_posts":
        return reply({ posts: [post(1, PROF), post(2, EU), post(3, PROF, { isdeleted: true })] });
      case "mod_forum_get_discussion_post": {
        const id = Number(body.get("postid"));
        return reply({ post: post(id, id === 2 ? EU : PROF) });
      }
      case "mod_forum_add_discussion_post":
        return reply({ postid: 555, warnings: [] });
      case "mod_forum_add_discussion":
        return reply({ discussionid: 777, warnings: [] });
      case "mod_forum_delete_post":
        return reply({ status: true, warnings: [] });
      case "message_popup_get_popup_notifications":
        return reply({
          unreadcount: 1,
          notifications: [
            { id: 1, subject: "Nova nota", smallmessage: "Sua nota foi publicada", contexturl: `${SITE}/grade`, timecreated: NOW - 60, read: false, component: "moodle", eventtype: "gradenotifications" },
            { id: 2, subject: "Conteúdo novo", smallmessage: "Aula 5", timecreated: NOW - 3600, read: true, component: "moodle", eventtype: "coursecontentupdated" },
          ],
        });
      case "core_message_get_conversations":
        return reply({
          conversations: [
            { id: 900, type: 1, membercount: 2, unreadcount: 2, members: [{ id: 42, fullname: "Colega Ana" }], messages: [{ id: 3, useridfrom: 42, text: "<p>Oi!</p>", timecreated: NOW }] },
            { id: 901, type: 3, membercount: 1, members: [], messages: [] },
          ],
        });
      case "core_message_get_conversation_messages":
        return reply({
          id: 900,
          members: [{ id: 42, fullname: "Colega Ana" }, { id: ME, fullname: "Aluno Teste" }],
          messages: [
            { id: 3, useridfrom: 42, text: "<p>Oi!</p>", timecreated: NOW },
            { id: 2, useridfrom: ME, text: "<p>Tudo bem?</p>", timecreated: NOW - 60 },
          ],
        });
      case "core_message_get_conversation":
        return reply({ id: Number(body.get("conversationid")), type: 1, membercount: 2, members: [{ id: 42, fullname: "Colega Ana" }, { id: ME, fullname: "Aluno Teste" }], messages: [] });
      case "core_message_get_self_conversation":
        return reply({ id: 901, type: 3 });
      case "core_message_get_member_info":
        return reply([memberInfo]);
      case "core_message_get_conversation_between_users":
        return hasConversationWith42 ? reply({ id: 900 }) : ex("errorconversationdoesnotexist");
      case "core_message_send_messages_to_conversation":
        return reply([{ id: 1234, useridfrom: ME, text: body.get("messages[0][text]"), timecreated: NOW }]);
      case "core_message_send_instant_messages":
        return reply([{ msgid: 4321, conversationid: 950 }]);
      case "core_message_message_search_users":
        return reply({ contacts: [], noncontacts: [{ id: 99, fullname: "Prof. Oliveira", conversations: [] }] });
      default:
        return ex(`notmocked:${fn}`);
    }
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.MOODLE_TOKEN;
});

beforeEach(() => {
  resetSession();
  calls = [];
  canReply = true;
  canAddDiscussion = true;
  memberInfo = { id: 42, fullname: "Colega Ana", canmessage: true, requirescontact: false, isblocked: false, isdeleted: false };
  hasConversationWith42 = true;
});

async function connect() {
  const server = createServer();
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0]!.text;
  return { isError: r.isError === true, text, code: /Código de confirmação: ([A-F0-9]{8})/.exec(text)?.[1], json: () => JSON.parse(text) };
}

const wrote = (fn: string) => calls.filter((c) => c.fn === fn);

// ---------- leitura ----------

test("fóruns, tópicos e posts", async () => {
  const client = await connect();
  const forums = (await tool(client, "moodle_list_forums", {})).json();
  assert.equal(forums[0].type, "Avisos (só professores postam)");
  assert.equal(forums[0].course, "Algoritmos e Programação: Fundamentos");
  assert.equal(forums[1].canCreateDiscussion, true);

  const [d] = (await tool(client, "moodle_list_discussions", { forumId: 300 })).json();
  assert.equal(d.discussionId, 10);
  assert.equal(d.pinned, true);

  const posts = (await tool(client, "moodle_read_discussion", { discussionId: 10 })).json();
  assert.equal(posts.length, 2, "post apagado não aparece");
  assert.equal(posts[0].text, "A prova é sexta.");
  assert.equal(posts[0].attachments[0].fileurl, `${SITE}/pluginfile.php/5/mod_forum/attachment/1/edital.pdf`);
  assert.equal(posts[1].replyTo, 1);
  assert.equal(posts[1].canDelete, true);
});

test("notificações, conversas e mensagens", async () => {
  const client = await connect();
  const n = (await tool(client, "moodle_list_notifications", { unreadOnly: true })).json();
  assert.equal(n.unread, 1);
  assert.deepEqual(n.notifications.map((x: { type: string }) => x.type), ["nota"]);

  const convs = (await tool(client, "moodle_list_conversations", {})).json();
  assert.equal(convs[0].with, "Colega Ana");
  assert.equal(convs[0].unread, 2);
  assert.match(convs[0].lastMessage, /^Colega Ana .*: Oi!$/);
  assert.equal(convs[1].with, "Anotações pessoais (só você vê)");

  const msgs = (await tool(client, "moodle_read_conversation", { conversationId: 900 })).json();
  assert.deepEqual(msgs.map((m: { from: string; text: string }) => `${m.from}: ${m.text}`), ["você: Tudo bem?", "Colega Ana: Oi!"]);

  const people = (await tool(client, "moodle_search_people", { query: "Oliveira" })).json();
  assert.deepEqual(people, [{ userId: 99, name: "Prof. Oliveira" }]);
});

// ---------- fórum: escrita ----------

test("responder no fórum: prévia não publica; confirmação publica com HTML escapado", async () => {
  const client = await connect();
  const prev = await tool(client, "moodle_reply_forum", { postId: 1, message: "Vou levar <calculadora>\nok?" });
  assert.equal(prev.isError, false, prev.text);
  assert.match(prev.text, /Respondendo a: Prof\. Oliveira — "Aviso da prova"/);
  assert.match(prev.text, /Assunto: Re: Aviso da prova/);
  assert.equal(wrote("mod_forum_add_discussion_post").length, 0);

  const done = await tool(client, "moodle_reply_forum", { postId: 1, message: "Vou levar <calculadora>\nok?", confirmationCode: prev.code });
  assert.match(done.text, /✅ Resposta publicada \(postId 555\)/);
  const [c] = wrote("mod_forum_add_discussion_post");
  assert.equal(c!.body.get("message"), "<p>Vou levar &lt;calculadora&gt;<br>ok?</p>");
  assert.equal(c!.body.get("subject"), "Re: Aviso da prova");

  const changed = await tool(client, "moodle_reply_forum", { postId: 1, message: "outro texto", confirmationCode: prev.code });
  assert.equal(changed.isError, true);
});

test("responder sem permissão (Avisos) é bloqueado sem código", async () => {
  canReply = false;
  const client = await connect();
  const r = await tool(client, "moodle_reply_forum", { postId: 1, message: "oi" });
  assert.equal(r.isError, true);
  assert.equal(r.code, undefined);
  assert.match(r.text, /não tem permissão para responder/);
});

test("criar tópico respeita mod_forum_can_add_discussion", async () => {
  const client = await connect();
  canAddDiscussion = false;
  const blocked = await tool(client, "moodle_create_discussion", { forumId: 300, subject: "Dúvida", message: "x" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /não pode criar tópicos em "Fórum de Avisos"/);

  canAddDiscussion = true;
  const prev = await tool(client, "moodle_create_discussion", { forumId: 301, subject: "Dúvida", message: "x" });
  const done = await tool(client, "moodle_create_discussion", { forumId: 301, subject: "Dúvida", message: "x", confirmationCode: prev.code });
  assert.match(done.text, /discussionId 777/);
});

test("apagar post: só os próprios; primeiro post avisa que apaga o tópico", async () => {
  const client = await connect();
  const other = await tool(client, "moodle_delete_forum_post", { postId: 1 });
  assert.equal(other.isError, true);
  assert.match(other.text, /próprio aluno/);

  const prev = await tool(client, "moodle_delete_forum_post", { postId: 2 });
  assert.equal(prev.isError, false, prev.text);
  const done = await tool(client, "moodle_delete_forum_post", { postId: 2, confirmationCode: prev.code });
  assert.match(done.text, /✅ Mensagem 2 apagada/);
  assert.equal(wrote("mod_forum_delete_post")[0]!.body.get("postid"), "2");
});

// ---------- mensagens: escrita ----------

test("enviar mensagem para conversa existente", async () => {
  const client = await connect();
  const prev = await tool(client, "moodle_send_message", { conversationId: 900, text: "Oi Ana" });
  assert.match(prev.text, /Para: Colega Ana/);
  assert.equal(wrote("core_message_send_messages_to_conversation").length, 0);
  const done = await tool(client, "moodle_send_message", { conversationId: 900, text: "Oi Ana", confirmationCode: prev.code });
  assert.match(done.text, /✅ Mensagem enviada para Colega Ana \(conversationId 900\)/);
  assert.equal(wrote("core_message_send_messages_to_conversation")[0]!.body.get("messages[0][text]"), "<p>Oi Ana</p>");
});

test("enviar para pessoa sem conversa usa send_instant_messages", async () => {
  hasConversationWith42 = false;
  const client = await connect();
  const prev = await tool(client, "moodle_send_message", { toUserId: 42, text: "Oi" });
  const done = await tool(client, "moodle_send_message", { toUserId: 42, text: "Oi", confirmationCode: prev.code });
  assert.match(done.text, /conversationId 950/);
  assert.equal(wrote("core_message_send_instant_messages")[0]!.body.get("messages[0][touserid]"), "42");
});

test("enviar para si mesmo vai para as anotações pessoais", async () => {
  const client = await connect();
  const prev = await tool(client, "moodle_send_message", { toUserId: ME, text: "lembrete" });
  assert.match(prev.text, /Para: Anotações pessoais/);
  await tool(client, "moodle_send_message", { toUserId: ME, text: "lembrete", confirmationCode: prev.code });
  assert.equal(wrote("core_message_send_messages_to_conversation")[0]!.body.get("conversationid"), "901");
});

test("mensagem bloqueada, destino ambíguo e código de outro tipo", async () => {
  const client = await connect();
  memberInfo = { ...memberInfo, canmessage: false, requirescontact: true };
  const blocked = await tool(client, "moodle_send_message", { toUserId: 42, text: "Oi" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /só aceita mensagens de contatos/);

  const both = await tool(client, "moodle_send_message", { toUserId: 42, conversationId: 900, text: "Oi" });
  assert.match(both.text, /exatamente um destino/);
  const none = await tool(client, "moodle_send_message", { text: "Oi" });
  assert.match(none.text, /exatamente um destino/);

  const forumCode = (await tool(client, "moodle_reply_forum", { postId: 1, message: "Oi" })).code;
  const crossed = await tool(client, "moodle_send_message", { conversationId: 900, text: "Oi", confirmationCode: forumCode });
  assert.equal(crossed.isError, true);
  assert.equal(wrote("core_message_send_messages_to_conversation").length, 0);
});
