import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetSession } from "../src/moodle/session.js";
import { countWords, escapeAsHtml, parseFileTypes } from "../src/moodle/submission.js";

const SITE = "https://www.moodle.unisinos.br";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const realFetch = globalThis.fetch;

// ---------- Moodle falso com estado ----------

interface FakeAssign {
  id: number;
  name: string;
  submissiondrafts: number;
  requiresubmissionstatement?: number;
  duedate: number;
  cutoffdate?: number;
  allowsubmissionsfromdate?: number;
  maxfiles?: number;
  types?: string;
  onlinetext?: boolean;
}

let assign: FakeAssign;
let existing: { filename: string; body: string }[];
let status: string;
let canedit: boolean;
let graded: boolean;
let drafts: Map<number, { filename: string; body: string }[]>;
let saved: Record<string, string> | null;
let submittedForGrading: URLSearchParams | null;
let saveWarnings: unknown[];
let log: string[];
let nextItem: number;

function resetFake() {
  assign = { id: 500, name: "Trabalho 1", submissiondrafts: 0, duedate: NOW + 3 * DAY, maxfiles: 3, types: ".pdf,.zip" };
  existing = [{ filename: "antigo.pdf", body: "OLD" }];
  status = "submitted";
  canedit = true;
  graded = false;
  drafts = new Map();
  saved = null;
  submittedForGrading = null;
  saveWarnings = [];
  log = [];
  nextItem = 9000;
}

function assignmentsResponse() {
  const configs = [
    { plugin: "file", subtype: "assignsubmission", name: "enabled", value: "1" },
    { plugin: "file", subtype: "assignsubmission", name: "maxfilesubmissions", value: String(assign.maxfiles ?? 20) },
    { plugin: "file", subtype: "assignsubmission", name: "maxsubmissionsizebytes", value: "1048576" },
    { plugin: "file", subtype: "assignsubmission", name: "filetypeslist", value: assign.types ?? "" },
    { plugin: "onlinetext", subtype: "assignsubmission", name: "enabled", value: assign.onlinetext ? "1" : "0" },
  ];
  return {
    courses: [
      {
        id: 1,
        fullname: "2026/2 - Algoritmos e Programação: Fundamentos - GR10003-00003-100003 - 10ASEMI - Pedro Oliveira",
        assignments: [{ cmid: 77, course: 1, configs, submissionstatement: "<p>Este trabalho é meu.</p>", ...assign }],
      },
    ],
  };
}

function statusResponse() {
  return {
    lastattempt: {
      submission: {
        status,
        timemodified: NOW,
        plugins: [
          {
            type: "file",
            fileareas: [
              {
                area: "submission_files",
                files: existing.map((f, i) => ({ filename: f.filename, filesize: f.body.length, fileurl: `${SITE}/webservice/pluginfile.php/1/assignsubmission_file/submission_files/${i}/${f.filename}` })),
              },
            ],
          },
        ],
      },
      canedit,
      cansubmit: assign.submissiondrafts === 1 && status === "draft",
      locked: false,
      gradingstatus: graded ? "graded" : "notgraded",
    },
    ...(graded ? { feedback: { gradefordisplay: "5,00 / 5,00" } } : {}),
  };
}

before(() => {
  process.env.MOODLE_TOKEN = "a".repeat(32);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const reply = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

    if (u.pathname === "/webservice/upload.php") {
      const form = init!.body as FormData;
      const itemid = Number(form.get("itemid"));
      const file = form.get("file_1") as File;
      const area = drafts.get(itemid) ?? [];
      if (area.some((f) => f.filename === file.name)) return reply([{ filename: file.name, errortype: "filenameexist", error: "exists" }]);
      area.push({ filename: file.name, body: await file.text() });
      drafts.set(itemid, area);
      log.push(`upload:${file.name}`);
      return reply([{ filename: file.name, itemid }]);
    }
    if (u.pathname.startsWith("/webservice/pluginfile.php/")) {
      const name = decodeURIComponent(u.pathname.split("/").pop()!);
      log.push(`download:${name}`);
      const f = existing.find((x) => x.filename === name)!;
      return new Response(f.body, { headers: { "content-type": "application/pdf" } });
    }

    const fn = u.searchParams.get("wsfunction")!;
    const body = new URLSearchParams(String(init?.body));
    log.push(fn);
    switch (fn) {
      case "core_webservice_get_site_info":
        return reply({ sitename: "Moodle", siteurl: SITE, userid: 7, username: "a", fullname: "A" });
      case "mod_assign_get_assignments":
        return reply(assignmentsResponse());
      case "mod_assign_get_submission_status":
        return reply(statusResponse());
      case "core_files_get_unused_draft_itemid":
        return reply({ itemid: nextItem++ });
      case "mod_assign_save_submission": {
        saved = Object.fromEntries(body.entries());
        delete saved.wstoken;
        if (saveWarnings.length) return reply(saveWarnings);
        const itemid = Number(body.get("plugindata[files_filemanager]"));
        existing = drafts.get(itemid) ?? [];
        status = assign.submissiondrafts ? "draft" : "submitted";
        return reply([]);
      }
      case "mod_assign_submit_for_grading":
        submittedForGrading = body;
        status = "submitted";
        return reply([]);
      default:
        return reply({ exception: "x", errorcode: "notmocked", message: fn });
    }
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.MOODLE_TOKEN;
});

let dir: string;
beforeEach(async () => {
  resetSession();
  resetFake();
  dir = await mkdtemp(join(tmpdir(), "moodle-submit-"));
});

async function connect() {
  const server = createServer();
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function submit(client: Client, args: Record<string, unknown>) {
  const r = (await client.callTool({ name: "moodle_submit_assignment", arguments: { assignmentId: 500, ...args } })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  return { isError: r.isError === true, text: r.content[0]!.text, code: /Código de confirmação: ([A-F0-9]{8})/.exec(r.content[0]!.text)?.[1] };
}

async function file(name: string, body: string) {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
}

// ---------- testes ----------

test("prévia não envia nada e explica que é entrega final", async () => {
  const client = await connect();
  const p = await file("trabalho.pdf", "NOVO");
  const r = await submit(client, { files: [p] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /PRÉVIA — nada foi enviado/);
  assert.match(r.text, /\+ trabalho\.pdf/);
  assert.match(r.text, /= antigo\.pdf .* mantido/);
  assert.match(r.text, /salvar o envio já é a ENTREGA FINAL/);
  assert.match(r.text, /Disciplina: Algoritmos e Programação: Fundamentos/);
  assert.ok(r.code);
  assert.ok(!log.some((l) => l.startsWith("upload") || l === "mod_assign_save_submission"), log.join(","));
});

test("com o código: mantém o antigo, sobe o novo e salva", async () => {
  const client = await connect();
  const p = await file("trabalho.pdf", "NOVO");
  const { code } = await submit(client, { files: [p] });
  const r = await submit(client, { files: [p], confirmationCode: code });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /✅ Envio feito em "Trabalho 1"/);
  assert.deepEqual(existing.map((f) => [f.filename, f.body]), [["antigo.pdf", "OLD"], ["trabalho.pdf", "NOVO"]]);
  assert.equal(saved!["assignmentid"], "500");
  assert.ok(log.indexOf("download:antigo.pdf") < log.indexOf("mod_assign_save_submission"));
  assert.equal(submittedForGrading, null, "sem rascunho não chama submit_for_grading");
});

test("código é de uso único", async () => {
  const client = await connect();
  const p = await file("trabalho.pdf", "NOVO");
  const { code } = await submit(client, { files: [p] });
  await submit(client, { files: [p], confirmationCode: code });
  const again = await submit(client, { files: [p], confirmationCode: code });
  assert.equal(again.isError, true);
  assert.match(again.text, /desconhecido|mudou/);
});

test("código não vale se o arquivo ou as opções mudarem depois da prévia", async () => {
  const client = await connect();
  const p = await file("trabalho.pdf", "NOVO");
  const { code } = await submit(client, { files: [p] });
  await writeFile(p, "NOVO MAIOR");
  const r = await submit(client, { files: [p], confirmationCode: code });
  assert.equal(r.isError, true);
  assert.match(r.text, /mudou desde a prévia/);
  assert.equal(saved, null);

  const p2 = await file("b.pdf", "B");
  const { code: c2 } = await submit(client, { files: [p2] });
  const r2 = await submit(client, { files: [p2], keepExistingFiles: false, confirmationCode: c2 });
  assert.equal(r2.isError, true);
  assert.equal(saved, null);
});

test("arquivo com o mesmo nome substitui o antigo; keepExistingFiles=false remove os outros", async () => {
  const client = await connect();
  const p = await file("antigo.pdf", "VERSAO2");
  const prev = await submit(client, { files: [p] });
  assert.match(prev.text, /− antigo\.pdf .*removido\/substituído/);
  await submit(client, { files: [p], confirmationCode: prev.code });
  assert.deepEqual(existing, [{ filename: "antigo.pdf", body: "VERSAO2" }]);
  assert.ok(!log.includes("download:antigo.pdf"));

  existing.push({ filename: "outro.pdf", body: "X" });
  const q = await file("so.pdf", "S");
  const prev2 = await submit(client, { files: [q], keepExistingFiles: false });
  assert.match(prev2.text, /− outro\.pdf/);
  await submit(client, { files: [q], keepExistingFiles: false, confirmationCode: prev2.code });
  assert.deepEqual(existing.map((f) => f.filename), ["so.pdf"]);
});

test("bloqueia prazo de corte vencido, tipo errado, excesso de arquivos e caminhos perigosos", async () => {
  const client = await connect();
  const ok = await file("a.pdf", "A");

  assign.cutoffdate = NOW - DAY;
  let r = await submit(client, { files: [ok] });
  assert.equal(r.isError, true);
  assert.match(r.text, /data de corte\) já passou/);
  assert.equal(r.code, undefined);
  assign.cutoffdate = undefined;

  r = await submit(client, { files: [await file("virus.exe", "x")] });
  assert.match(r.text, /tipo não aceito\. Tipos aceitos: \.pdf, \.zip/);

  assign.maxfiles = 1;
  r = await submit(client, { files: [ok] });
  assert.match(r.text, /no máximo 1 arquivo/);
  assign.maxfiles = 3;

  r = await submit(client, { files: ["relativo.pdf"] });
  assert.match(r.text, /caminho completo/);

  await mkdir(join(dir, ".ssh"));
  r = await submit(client, { files: [join(dir, ".ssh", "id.pdf")] });
  assert.match(r.text, /pastas ocultas/);

  r = await submit(client, { files: [join(dir, "nao-existe.pdf")] });
  assert.match(r.text, /não encontrado/);

  canedit = false;
  r = await submit(client, { files: [ok] });
  assert.match(r.text, /já foi enviada para avaliação e não pode mais ser editada/);
  assert.ok(!log.some((l) => l.startsWith("upload")));
});

test("atraso e tarefa já avaliada geram avisos mas deixam enviar", async () => {
  assign.duedate = NOW - DAY;
  graded = true;
  const client = await connect();
  const r = await submit(client, { files: [await file("a.pdf", "A")] });
  assert.equal(r.isError, false);
  assert.match(r.text, /ATRASADO/);
  assert.match(r.text, /JÁ FOI AVALIADA \(nota 5,00 \/ 5,00\)/);
});

test("tarefa com rascunho: finalize chama submit_for_grading e exige a declaração", async () => {
  assign.submissiondrafts = 1;
  assign.requiresubmissionstatement = 1;
  status = "draft";
  const client = await connect();
  const p = await file("a.pdf", "A");

  const draftOnly = await submit(client, { files: [p] });
  assert.match(draftOnly.text, /ficará como RASCUNHO/);

  const noStatement = await submit(client, { files: [p], finalize: true });
  assert.equal(noStatement.isError, true);
  assert.match(noStatement.text, /declaração de autoria/);

  const prev = await submit(client, { files: [p], finalize: true, acceptStatement: true });
  assert.match(prev.text, /ENVIADO PARA AVALIAÇÃO/);
  assert.match(prev.text, /Este trabalho é meu\./);
  const done = await submit(client, { files: [p], finalize: true, acceptStatement: true, confirmationCode: prev.code });
  assert.equal(done.isError, false, done.text);
  assert.equal(submittedForGrading!.get("acceptsubmissionstatement"), "1");
  assert.equal(status, "submitted");
});

test("avisos do save_submission viram erro", async () => {
  saveWarnings = [{ item: "x", warningcode: "couldnotsavesubmission", message: "Não foi possível salvar" }];
  const client = await connect();
  const p = await file("a.pdf", "A");
  const { code } = await submit(client, { files: [p] });
  const r = await submit(client, { files: [p], confirmationCode: code });
  assert.equal(r.isError, true);
  assert.match(r.text, /Não foi possível salvar/);
});

test("texto online é escapado e respeita o limite", async () => {
  assign.onlinetext = true;
  const client = await connect();
  const prev = await submit(client, { text: "Resposta <b>1</b>\n\nParágrafo 2" });
  assert.equal(prev.isError, false, prev.text);
  await submit(client, { text: "Resposta <b>1</b>\n\nParágrafo 2", confirmationCode: prev.code });
  assert.equal(saved!["plugindata[onlinetext_editor][text]"], "<p>Resposta &lt;b&gt;1&lt;/b&gt;</p><p>Parágrafo 2</p>");
  assert.equal(saved!["plugindata[onlinetext_editor][format]"], "1");
});

test("utilitários", () => {
  assert.deepEqual(parseFileTypes(".PDF, .docx"), [".pdf", ".docx"]);
  assert.equal(parseFileTypes("*"), null);
  assert.equal(parseFileTypes("document"), null);
  assert.equal(countWords("  um  dois\ntrês "), 3);
  assert.equal(escapeAsHtml("a\nb"), "<p>a<br>b</p>");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});
