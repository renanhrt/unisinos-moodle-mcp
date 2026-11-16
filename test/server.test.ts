import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetSession } from "../src/moodle/session.js";

// Respostas falsas do Moodle, por wsfunction.
let responses: Record<string, unknown> = {};
// Arquivos falsos servidos em webservice/pluginfile.php, por caminho.
let files: Record<string, { body: string; type: string }> = {};
const calls: { fn: string; body: URLSearchParams }[] = [];
const realFetch = globalThis.fetch;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const SITE = "https://www.moodle.unisinos.br";
const SITE_INFO = { sitename: "Moodle Unisinos", siteurl: SITE, userid: 7, username: "aluno", fullname: "Aluno Teste", release: "4.3" };

before(() => {
  process.env.MOODLE_TOKEN = "f".repeat(32);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.startsWith("/webservice/pluginfile.php/")) {
      calls.push({ fn: "pluginfile", body: u.searchParams });
      const f = files[u.pathname];
      return f
        ? new Response(f.body, { headers: { "content-type": f.type } })
        : new Response(JSON.stringify({ error: "Arquivo não encontrado", errorcode: "filenotfound" }), { headers: { "content-type": "application/json" } });
    }
    const fn = u.searchParams.get("wsfunction")!;
    calls.push({ fn, body: new URLSearchParams(String(init?.body)) });
    const body = fn in responses ? responses[fn] : { exception: "x", errorcode: "notmocked", message: `sem mock: ${fn}` };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.MOODLE_TOKEN;
});

beforeEach(() => {
  resetSession();
  calls.length = 0;
  responses = { core_webservice_get_site_info: SITE_INFO };
  files = {};
});

async function connect() {
  const server = createServer();
  const client = new Client({ name: "teste", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function json(result: unknown): any {
  const r = result as { content: { type: string; text: string }[]; isError?: boolean };
  assert.equal(r.isError, undefined, r.content[0]?.text);
  return JSON.parse(r.content[0]!.text);
}

test("expõe as ferramentas e marca quais alteram algo", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "moodle_create_discussion",
    "moodle_delete_forum_post",
    "moodle_download_file",
    "moodle_get_assignment_status",
    "moodle_get_course_contents",
    "moodle_get_grades",
    "moodle_get_me",
    "moodle_grades_overview",
    "moodle_list_assignments",
    "moodle_list_conversations",
    "moodle_list_courses",
    "moodle_list_discussions",
    "moodle_list_forums",
    "moodle_list_notifications",
    "moodle_list_quizzes",
    "moodle_quiz_answer",
    "moodle_quiz_finish",
    "moodle_quiz_next_page",
    "moodle_quiz_questions",
    "moodle_quiz_review",
    "moodle_quiz_start",
    "moodle_read_conversation",
    "moodle_read_discussion",
    "moodle_read_file",
    "moodle_remove_submission",
    "moodle_reply_forum",
    "moodle_search_people",
    "moodle_send_message",
    "moodle_submit_assignment",
    "moodle_upcoming_deadlines",
  ]);
  const writes = ["moodle_create_discussion", "moodle_delete_forum_post", "moodle_download_file", "moodle_quiz_answer", "moodle_quiz_finish", "moodle_quiz_next_page", "moodle_quiz_start", "moodle_remove_submission", "moodle_reply_forum", "moodle_send_message", "moodle_submit_assignment"];
  assert.deepEqual(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort(), writes);
  assert.deepEqual(
    tools.filter((t) => t.annotations?.destructiveHint !== false).map((t) => t.name).sort(),
    ["moodle_delete_forum_post", "moodle_quiz_finish", "moodle_quiz_next_page", "moodle_remove_submission", "moodle_submit_assignment"],
  );
  // toda ferramenta que altera o Moodle explica o fluxo de confirmação
  for (const t of tools.filter((x) => writes.includes(x.name) && !["moodle_download_file", "moodle_quiz_answer"].includes(x.name))) {
    assert.match(t.description ?? "", /DUAS ETAPAS/, t.name);
    assert.ok("confirmationCode" in ((t.inputSchema as { properties: object }).properties), t.name);
  }
});

test("moodle_list_courses filtra o semestre atual", async () => {
  responses.core_enrol_get_users_courses = [
    { id: 1, shortname: "ALG", fullname: "Algoritmos", startdate: NOW - 30 * DAY, enddate: NOW + 60 * DAY, progress: 40.4, lastaccess: NOW },
    { id: 2, shortname: "OLD", fullname: "Antiga", startdate: NOW - 400 * DAY, enddate: NOW - 200 * DAY },
  ];
  const client = await connect();
  const courses = json(await client.callTool({ name: "moodle_list_courses", arguments: {} }));
  assert.equal(courses.length, 1);
  assert.equal(courses[0].name, "Algoritmos");
  assert.equal(courses[0].progress, "40%");
  assert.equal(calls.find((c) => c.fn === "core_enrol_get_users_courses")!.body.get("userid"), "7");

  const all = json(await client.callTool({ name: "moodle_list_courses", arguments: { filter: "all" } }));
  assert.equal(all.length, 2);
});

test("moodle_get_course_contents resume seções, arquivos e conclusão", async () => {
  responses.core_course_get_contents = [
    {
      id: 10,
      name: "Semana 1",
      modules: [
        {
          id: 100, name: "Slides", modname: "resource", url: "https://m/mod/resource/view.php?id=100",
          completiondata: { state: 1 },
          contents: [{ type: "file", filename: "aula1.pdf", filesize: 2048, fileurl: "https://m/pluginfile.php/1/aula1.pdf", mimetype: "application/pdf" }],
        },
        { id: 101, name: "Aviso", modname: "label", description: "<p>Prova dia 10</p>" },
      ],
    },
  ];
  const client = await connect();
  const [section] = json(await client.callTool({ name: "moodle_get_course_contents", arguments: { courseid: 5 } }));
  assert.equal(section.section, "Semana 1");
  assert.equal(section.items[0].completion, "concluída");
  assert.equal(section.items[0].files[0].size, "2.0 KB");
  assert.equal(section.items[1].name, "Prova dia 10");
});

test("moodle_upcoming_deadlines ordena e marca atrasos", async () => {
  responses.core_calendar_get_action_events_by_timesort = {
    events: [
      { id: 2, name: "Trabalho 2 vence", activityname: "Trabalho 2", modulename: "assign", instance: 22, timesort: NOW + 3 * DAY, course: { id: 1, fullname: "Algoritmos" }, action: { name: "Adicionar envio", actionable: true } },
      { id: 1, name: "Trabalho 1 vence", activityname: "Trabalho 1", modulename: "assign", instance: 21, timesort: NOW - DAY, overdue: true, course: { id: 1, fullname: "Algoritmos" }, action: { name: "Adicionar envio", actionable: true } },
    ],
  };
  const client = await connect();
  const events = json(await client.callTool({ name: "moodle_upcoming_deadlines", arguments: { days: 7 } }));
  assert.deepEqual(events.map((e: any) => e.activity), ["Trabalho 1", "Trabalho 2"]);
  assert.equal(events[0].overdue, true);
  assert.equal(events[1].overdue, undefined);
  assert.equal(events[1].todo, "Adicionar envio");
});

test("moodle_get_grades traduz total e esconde '-'", async () => {
  responses.gradereport_user_get_grade_items = {
    usergrades: [{ courseid: 1, gradeitems: [
      { id: 1, itemname: "Prova 1", itemtype: "mod", itemmodule: "quiz", gradeformatted: "8,50", rangeformatted: "0&ndash;10", percentageformatted: "85,00 %", feedback: "<p>Bom</p>" },
      { id: 2, itemname: "Prova 2", itemtype: "mod", itemmodule: "quiz", gradeformatted: "-" },
      { id: 3, itemname: null, itemtype: "course", gradeformatted: "8,50" },
    ] }],
  };
  const client = await connect();
  const grades = json(await client.callTool({ name: "moodle_get_grades", arguments: { courseid: 1 } }));
  assert.equal(grades[0].range, "0–10");
  assert.equal(grades[0].feedback, "Bom");
  assert.equal(grades[1].grade, undefined);
  assert.equal(grades[2].item, "TOTAL DA DISCIPLINA");
});

test("moodle_get_assignment_status mostra envio e comentários", async () => {
  responses.mod_assign_get_submission_status = {
    lastattempt: {
      submission: { status: "submitted", timemodified: NOW, attemptnumber: 0, plugins: [
        { type: "file", name: "Envio de arquivos", fileareas: [{ area: "submission_files", files: [{ filename: "trab.zip", filesize: 1024, fileurl: "https://m/f" }] }] },
      ] },
      cansubmit: false, canedit: true, gradingstatus: "graded",
    },
    feedback: { gradefordisplay: "9,00 / 10,00", plugins: [{ type: "comments", name: "Comentários", editorfields: [{ name: "c", text: "<p>Ótimo</p>" }] }] },
  };
  const client = await connect();
  const s = json(await client.callTool({ name: "moodle_get_assignment_status", arguments: { assignmentId: 22 } }));
  assert.equal(s.submission, "enviado para avaliação");
  assert.equal(s.grading, "avaliado");
  assert.equal(s.submittedFiles[0].filename, "trab.zip");
  assert.equal(s.teacherComments, "Ótimo");
  assert.equal(calls.at(-1)!.body.get("assignid"), "22");
});

test("token inválido vira erro amigável pedindo novo login", async () => {
  responses.core_webservice_get_site_info = { exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token" };
  const client = await connect();
  const r = (await client.callTool({ name: "moodle_get_me", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /npm run login/);
});

test("moodle_read_file lê, pagina por offset e usa cache", async () => {
  const path = "/webservice/pluginfile.php/1/mod_page/content/3/index.html";
  files[path] = { body: "<h1>Aula 1</h1>" + "<p>" + "x".repeat(3000) + "</p>", type: "text/html" };
  const client = await connect();
  const first = (await client.callTool({ name: "moodle_read_file", arguments: { fileurl: SITE + path, maxChars: 1000 } })) as any;
  assert.equal(first.isError, undefined, first.content[0].text);
  assert.match(first.content[0].text, /Arquivo: index\.html \(HTML/);
  assert.match(first.content[0].text, /offset=1000/);
  assert.equal(calls.find((c) => c.fn === "pluginfile")!.body.get("token"), "f".repeat(32));

  const before = calls.filter((c) => c.fn === "pluginfile").length;
  const second = (await client.callTool({ name: "moodle_read_file", arguments: { fileurl: SITE + path, offset: 3000 } })) as any;
  assert.match(second.content[0].text, /Fim do conteúdo/);
  assert.equal(calls.filter((c) => c.fn === "pluginfile").length, before, "segunda leitura deve vir do cache");
});

test("moodle_read_file recusa URL de outro site sem enviar o token", async () => {
  const client = await connect();
  const r = (await client.callTool({ name: "moodle_read_file", arguments: { fileurl: "https://evil.example/webservice/pluginfile.php/1/a.pdf" } })) as any;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Só é possível baixar arquivos de/);
  assert.equal(calls.filter((c) => c.fn === "pluginfile").length, 0);
});

test("moodle_download_file salva na pasta configurada", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "moodle-srv-"));
  process.env.MOODLE_DOWNLOAD_DIR = dir;
  try {
    const client = await connect();
    const path = "/webservice/pluginfile.php/9/mod_resource/content/1/Lista%201.txt";
    files[path] = { body: "exercícios", type: "text/plain" };
    const out = json(await client.callTool({ name: "moodle_download_file", arguments: { fileurl: SITE + path, folder: "Álgebra" } }));
    assert.equal(out.saved, join(dir, "Álgebra", "Lista 1.txt"));
    assert.equal(await readFile(out.saved, "utf8"), "exercícios");
  } finally {
    delete process.env.MOODLE_DOWNLOAD_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
