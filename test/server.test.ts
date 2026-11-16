import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetSession } from "../src/moodle/session.js";

// Respostas falsas do Moodle, por wsfunction.
let responses: Record<string, unknown> = {};
const calls: { fn: string; body: URLSearchParams }[] = [];
const realFetch = globalThis.fetch;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const SITE_INFO = { sitename: "Moodle Unisinos", siteurl: "https://www.moodle.unisinos.br", userid: 7, username: "aluno", fullname: "Aluno Teste", release: "4.3" };

before(() => {
  process.env.MOODLE_TOKEN = "f".repeat(32);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const fn = new URL(String(url)).searchParams.get("wsfunction")!;
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

test("expõe as ferramentas somente leitura", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "moodle_get_assignment_status",
    "moodle_get_course_contents",
    "moodle_get_grades",
    "moodle_get_me",
    "moodle_grades_overview",
    "moodle_list_assignments",
    "moodle_list_courses",
    "moodle_upcoming_deadlines",
  ]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
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
