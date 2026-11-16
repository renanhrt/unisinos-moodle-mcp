import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetSession } from "../src/moodle/session.js";
import { AnswerError, buildAnswerData, currentAnswer, parseQuestionHtml } from "../src/moodle/quiz-html.js";

const SITE = "https://www.moodle.unisinos.br";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const realFetch = globalThis.fetch;

// ---------- HTML no formato do Moodle 4.5 ----------

const U = 77; // uniqueid da tentativa

function radioQ(slot: number, options: string[], selected: string | null) {
  const p = `q${U}:${slot}_`;
  return `<div id="question-${U}-${slot}" class="que multichoice deferredfeedback ${selected === null ? "notyetanswered" : "answersaved"}">
<div class="info"><h3 class="no">Questão <span class="qno">${slot}</span></h3><div class="state">${selected === null ? "Ainda não respondida" : "Resposta salva"}</div><div class="grade">Vale 0,50 ponto(s).</div></div>
<div class="content"><div class="formulation clearfix"><h4 class="accesshide">Texto da questão</h4>
<input type="hidden" name="${p}:sequencecheck" value="${selected === null ? 1 : 2}" />
<div class="qtext"><p>Sejam \\(u=(1,2)\\) e \\(v=(3,4)\\). Calcule <strong>u&middot;v</strong>.</p><p><img src="${SITE}/webservice/pluginfile.php/1/question/questiontext/${U}/${slot}/5/fig.png" alt=""></p></div>
<fieldset class="ablock no-overflow visual-scroll-x"><legend class="prompt h6 font-weight-normal sr-only">Escolha uma opção:</legend>
<div class="answer">
${options
  .map(
    (o, i) =>
      `<div class="r${i % 2}"><input type="radio" name="${p}answer" value="${i}" id="${p}answer${i}" aria-labelledby="${p}answer${i}_label"${selected === String(i) ? ' checked="checked"' : ""} /><div class="d-flex w-auto" id="${p}answer${i}_label" data-region="answer-label"><span class="answernumber">${"abcde"[i]}. </span><div class="flex-fill ml-1"><p>${o}</p></div></div> </div>`,
  )
  .join("\n")}
</div><div id="${p}clearchoice" class="qtype_multichoice_clearchoice sr-only" aria-hidden="true"><input type="radio" name="${p}answer" id="${p}answer-1" value="-1" class="sr-only"${selected === null ? ' checked="checked"' : ""} /><label for="${p}answer-1"><a href="#">Limpar minha escolha</a></label></div>
</fieldset></div></div><input type="hidden" name="${p}:flagged" value="0" /></div>`;
}

function checkboxQ(slot: number, options: string[], checked: Set<number>) {
  const p = `q${U}:${slot}_`;
  return `<div class="que multichoice deferredfeedback"><div class="info"><span class="qno">${slot}</span></div>
<input type="hidden" name="${p}:sequencecheck" value="1" />
<div class="qtext"><p>Quais vetores são LI?</p></div><fieldset><legend class="prompt">Escolha uma ou mais:</legend><div class="answer">
${options
  .map(
    (o, i) =>
      `<div class="r0"><input type="hidden" name="${p}choice${i}" value="0" /><input type="checkbox" name="${p}choice${i}" value="1" id="${p}choice${i}" aria-labelledby="${p}choice${i}_label"${checked.has(i) ? ' checked="checked"' : ""} /><div id="${p}choice${i}_label"><span class="answernumber">${"abcde"[i]}. </span><div class="flex-fill ml-1">${o}</div></div></div>`,
  )
  .join("")}</div></fieldset></div>`;
}

const textQ = (slot: number, value: string) => {
  const p = `q${U}:${slot}_`;
  return `<div class="que shortanswer"><input type="hidden" name="${p}:sequencecheck" value="1" /><div class="qtext">Determinante de A?</div>
<span class="answer"><label for="${p}answer" class="mr-1">Resposta:</label><input type="text" name="${p}answer" id="${p}answer" size="80" value="${value}" /></span></div>`;
};

const matchQ = (slot: number, selected: string[]) => {
  const p = `q${U}:${slot}_`;
  const row = (i: number, t: string) =>
    `<tr class="r${i}"><td class="text"><p>${t}</p></td><td class="control"><label class="accesshide" for="menu${p}sub${i}">Resposta ${i + 1}</label><select id="menu${p}sub${i}" name="${p}sub${i}"><option value="0"${selected[i] === "0" ? ' selected="selected"' : ""}>Escolher...</option><option value="1"${selected[i] === "1" ? ' selected="selected"' : ""}>0</option><option value="2"${selected[i] === "2" ? ' selected="selected"' : ""}>1</option></select></td></tr>`;
  return `<div class="que match"><input type="hidden" name="${p}:sequencecheck" value="1" /><div class="qtext">Associe:</div><table class="answer"><tbody>${row(0, "det(I)")}${row(1, "det(0)")}</tbody></table></div>`;
};

// ---------- parser ----------

test("parseQuestionHtml: múltipla escolha com uma resposta", () => {
  const q = parseQuestionHtml(radioQ(1, ["11", "10", "<b>-5</b>"], null));
  assert.equal(q.prefix, `q${U}:1_`);
  assert.equal(q.number, "1");
  assert.equal(q.text, "Sejam \\(u=(1,2)\\) e \\(v=(3,4)\\). Calcule u·v.");
  assert.deepEqual(q.images, [`${SITE}/webservice/pluginfile.php/1/question/questiontext/${U}/1/5/fig.png`]);
  assert.equal(q.prompt, "Escolha uma opção:");
  assert.deepEqual(q.radio!.options.map((o) => [o.letter, o.value, o.text, o.selected]), [
    ["a", "0", "11", false],
    ["b", "1", "10", false],
    ["c", "2", "-5", false],
  ]);
  assert.deepEqual(q.hidden, [{ name: `q${U}:1_:sequencecheck`, value: "1" }]);
  assert.equal(currentAnswer(q), null);
  assert.equal(q.review, undefined);
  assert.equal(currentAnswer(parseQuestionHtml(radioQ(1, ["11", "10"], "1"))), "b) 10");
});

test("buildAnswerData marca só a opção pedida e nunca adivinha", () => {
  const q = parseQuestionHtml(radioQ(3, ["11", "10", "-5"], null));
  for (const pedido of ["b", "B", "b)", "letra b", "2", "10"]) {
    const { data, summary } = buildAnswerData(q, 3, pedido);
    assert.deepEqual(data, [
      { name: `q${U}:3_:sequencecheck`, value: "1" },
      { name: `q${U}:3_answer`, value: "1" },
      { name: "slots", value: "3" },
    ], pedido);
    assert.equal(summary, "b) 10");
  }
  assert.throws(() => buildAnswerData(q, 3, "z"), AnswerError);
  assert.equal(buildAnswerData(q, 3, "1").summary, "a) 11"); // posição 1; nenhuma opção tem texto "1"
  assert.throws(() => buildAnswerData(q, 3, "letra z"), /Não existe a letra "z"/);
  // opções cujo texto é número: "2" pode ser a 2ª opção ou a opção "2" → recusa
  const nums = parseQuestionHtml(radioQ(6, ["3", "2", "1"], null));
  assert.equal(buildAnswerData(nums, 6, "2").summary, "b) 2"); // 2ª opção e texto "2" são a mesma
  assert.throws(() => buildAnswerData(nums, 6, "1"), /ambíguo \(pode ser a\) ou c\)\)/);
  assert.throws(() => buildAnswerData(nums, 6, "3"), /ambíguo/);
  assert.equal(buildAnswerData(nums, 6, "letra c").summary, "c) 1");
  assert.throws(() => buildAnswerData(q, 3, ["a", "b"]), /UMA opção/);
  assert.equal(buildAnswerData(q, 3, "limpar").data.find((d) => d.name.endsWith("answer"))!.value, "-1");
});

test("várias respostas, texto e associação", () => {
  const cb = parseQuestionHtml(checkboxQ(2, ["(1,0)", "(0,1)", "(1,1)"], new Set([2])));
  assert.equal(currentAnswer(cb), "c) (1,1)");
  const { data, summary } = buildAnswerData(cb, 2, ["a", "c"]);
  assert.equal(summary, "a) (1,0); c) (1,1)");
  const v = Object.fromEntries(data.map((d) => [d.name, d.value]));
  assert.deepEqual([v[`q${U}:2_choice0`], v[`q${U}:2_choice1`], v[`q${U}:2_choice2`]], ["1", "0", "1"]);
  assert.equal(buildAnswerData(cb, 2, "a, b").summary, "a) (1,0); b) (0,1)");

  const t = parseQuestionHtml(textQ(4, ""));
  assert.equal(t.texts![0]!.label, "Resposta:");
  assert.deepEqual(buildAnswerData(t, 4, "-2").data.find((d) => d.name === `q${U}:4_answer`), { name: `q${U}:4_answer`, value: "-2" });

  const m = parseQuestionHtml(matchQ(5, ["0", "2"]));
  assert.deepEqual(m.selects!.map((s) => [s.label, s.options.map((o) => o.text), s.selected]), [
    ["det(I)", ["0", "1"], null],
    ["det(0)", ["0", "1"], "2"],
  ]);
  assert.throws(() => buildAnswerData(m, 5, { "det(I)": "1" }), /ambíguo/);
  const md = buildAnswerData(m, 5, { "det(I)": "b", "det(0)": "a" });
  assert.equal(md.summary, "det(I): 1; det(0): 0");
  assert.throws(() => buildAnswerData(m, 5, "1"), /2 campos/);
});

// ---------- Moodle falso com tentativa ----------

interface FakeState {
  navmethod: "free" | "sequential";
  attempts: { id: number; attempt: number; uniqueid: number; state: string; currentpage: number; layout: string; timestart: number }[];
  answers: Record<number, string | null>; // slot → valor marcado (rádio)
  allowed: number;
  rules: string[];
  prevent: string[];
}
let st: FakeState;
let log: { fn: string; body: URLSearchParams }[];
const OPTIONS = ["11", "10", "-5"];

before(() => {
  process.env.MOODLE_TOKEN = "c".repeat(32);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const fn = new URL(String(url)).searchParams.get("wsfunction")!;
    const body = new URLSearchParams(String(init?.body));
    log.push({ fn, body });
    const reply = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    const att = st.attempts.find((a) => String(a.id) === body.get("attemptid"));
    switch (fn) {
      case "core_webservice_get_site_info":
        return reply({ sitename: "M", siteurl: SITE, userid: 7, username: "a", fullname: "A" });
      case "core_enrol_get_users_courses":
        return reply([{ id: 1, shortname: "x", fullname: "2026/2 - Álgebra Linear e Geometria Analítica - GR10001-00001-100001 - 10BSEMI - MARIA DA SILVA SOUZA" }]);
      case "mod_quiz_get_quizzes_by_courses":
        return reply({ quizzes: [{ id: 50, coursemodule: 5, course: 1, name: "EXERCÍCIO 2", timeopen: NOW - DAY, timeclose: NOW + 5 * DAY, timelimit: 0, attempts: st.allowed, grade: 3, navmethod: st.navmethod }] });
      case "mod_quiz_get_user_attempts":
        return reply({ attempts: st.attempts });
      case "mod_quiz_get_user_best_grade":
        return reply({ hasgrade: false });
      case "mod_quiz_get_quiz_access_information":
        return reply({ canattempt: true, canreviewmyattempts: true, activerulenames: st.rules, preventaccessreasons: st.prevent });
      case "mod_quiz_start_attempt": {
        const a = { id: 900 + st.attempts.length, attempt: st.attempts.length + 1, uniqueid: U, state: "inprogress", currentpage: 0, layout: "1,0,2,0", timestart: NOW };
        st.attempts.push(a);
        return reply({ attempt: a, warnings: [] });
      }
      case "mod_quiz_get_attempt_summary":
        return reply({
          questions: [1, 2].map((slot) => ({ slot, type: "multichoice", page: slot - 1, number: slot, html: "", status: st.answers[slot] == null ? "Ainda não respondida" : "Resposta salva" })),
        });
      case "mod_quiz_get_attempt_data": {
        const page = Number(body.get("page"));
        if (st.navmethod === "sequential") {
          if (page < att!.currentpage) return reply({ exception: "moodle_exception", errorcode: "Out of sequence access", message: "Out of sequence access" });
          att!.currentpage = page; // abrir avança!
        }
        const slot = page + 1;
        return reply({
          attempt: att,
          messages: [],
          nextpage: page === 0 ? 1 : -1,
          questions: [{ slot, type: "multichoice", page, number: slot, html: radioQ(slot, OPTIONS, st.answers[slot] ?? null), maxmark: 1.5, status: "" }],
        });
      }
      case "mod_quiz_process_attempt": {
        if (body.get("finishattempt") === "1") {
          att!.state = "finished";
          return reply({ state: "finished", warnings: [] });
        }
        const entries = [...body.entries()];
        const slot = Number(entries.find(([k]) => k.endsWith("[name]") && body.get(k) === "slots") ? body.get(entries.find(([k]) => body.get(k) === "slots")![0].replace("[name]", "[value]")) : 0);
        const ansKey = entries.find(([, v]) => v === `q${U}:${slot}_answer`);
        if (ansKey) {
          const val = body.get(ansKey[0].replace("[name]", "[value]"))!;
          st.answers[slot] = val === "-1" ? null : val;
        }
        return reply({ state: "inprogress", warnings: [] });
      }
      case "mod_quiz_get_attempt_review":
        return reply({ exception: "moodle_exception", errorcode: "noreview", message: "Não é permitido revisar" });
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
  st = { navmethod: "free", attempts: [], answers: {}, allowed: 2, rules: ["quizaccess_numattempts", "quizaccess_openclosedate"], prevent: [] };
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
  return { isError: r.isError === true, text, code: /Código de confirmação: ([A-F0-9]{8})/.exec(text)?.[1] };
}
const called = (fn: string) => log.filter((l) => l.fn === fn).length;

test("lista questionários com tentativas e situação", async () => {
  st.attempts.push({ id: 800, attempt: 1, uniqueid: 1, state: "finished", currentpage: 1, layout: "1,0,2,0", timestart: NOW - DAY });
  const client = await connect();
  const [q] = JSON.parse((await tool(client, "moodle_list_quizzes", {})).text);
  assert.equal(q.name, "EXERCÍCIO 2");
  assert.equal(q.course, "Álgebra Linear e Geometria Analítica");
  assert.equal(q.status, "aberto");
  assert.equal(q.attempts, "1 de 2");
});

test("fluxo completo: iniciar (confirmado) → ver → marcar o que o aluno disse → enviar (confirmado)", async () => {
  const client = await connect();
  const prev = await tool(client, "moodle_quiz_start", { quizId: 50 });
  assert.match(prev.text, /esta será a 1ª de 2/);
  assert.match(prev.text, /já conta como uma tentativa/);
  assert.equal(called("mod_quiz_start_attempt"), 0, "prévia não inicia");

  const started = await tool(client, "moodle_quiz_start", { quizId: 50, confirmationCode: prev.code });
  assert.match(started.text, /✅ Tentativa iniciada \(attemptId 900/);

  const again = await tool(client, "moodle_quiz_start", { quizId: 50 });
  assert.match(again.text, /retomada \(attemptId 900/);
  assert.equal(called("mod_quiz_start_attempt"), 1, "retomar não gasta tentativa");

  const qs = JSON.parse((await tool(client, "moodle_quiz_questions", { attemptId: 900 })).text);
  assert.equal(qs.navigation, "livre");
  assert.equal(qs.questions.length, 2, "navegação livre traz todas as páginas");
  assert.deepEqual(qs.questions[0].options, ["a) 11", "b) 10", "c) -5"]);
  assert.match(qs.rule, /NÃO sugere/);

  const ans = await tool(client, "moodle_quiz_answer", { attemptId: 900, slot: 2, answer: "c" });
  assert.equal(ans.isError, false, ans.text);
  assert.match(ans.text, /marcado c\) -5\.\nNo Moodle agora: c\) -5/);
  assert.equal(st.answers[2], "2");

  const bad = await tool(client, "moodle_quiz_answer", { attemptId: 900, slot: 1, answer: "talvez a b" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /não corresponde a nenhuma opção/);
  assert.equal(st.answers[1], undefined, "pedido inválido não marca nada");

  const fin = await tool(client, "moodle_quiz_finish", { attemptId: 900 });
  assert.match(fin.text, /1 questão\(ões\) sem resposta: 1/);
  assert.equal(st.attempts[0]!.state, "inprogress");
  const done = await tool(client, "moodle_quiz_finish", { attemptId: 900, confirmationCode: fin.code });
  assert.match(done.text, /✅ Questionário enviado/);
  assert.equal(st.attempts[0]!.state, "finished");

  const late = await tool(client, "moodle_quiz_answer", { attemptId: 900, slot: 1, answer: "a" });
  assert.match(late.text, /finalizada; não dá mais para marcar/);

  const review = JSON.parse((await tool(client, "moodle_quiz_review", { attemptId: 900 })).text);
  assert.match(review.review, /não liberou a revisão/);
});

test("código de envio não vale se as respostas mudarem depois da prévia", async () => {
  st.attempts.push({ id: 901, attempt: 1, uniqueid: U, state: "inprogress", currentpage: 0, layout: "1,0,2,0", timestart: NOW });
  const client = await connect();
  const fin = await tool(client, "moodle_quiz_finish", { attemptId: 901 });
  await tool(client, "moodle_quiz_answer", { attemptId: 901, slot: 1, answer: "a" });
  const r = await tool(client, "moodle_quiz_finish", { attemptId: 901, confirmationCode: fin.code });
  assert.equal(r.isError, true);
  assert.equal(st.attempts[0]!.state, "inprogress");
});

test("bloqueios: sem tentativas, regras que exigem navegador", async () => {
  const client = await connect();
  st.prevent = ["Não há mais tentativas disponíveis."];
  let r = await tool(client, "moodle_quiz_start", { quizId: 50 });
  assert.equal(r.isError, true);
  assert.match(r.text, /Não há mais tentativas/);

  st.prevent = [];
  st.rules = ["quizaccess_numattempts", "quizaccess_seb"];
  r = await tool(client, "moodle_quiz_start", { quizId: 50 });
  assert.match(r.text, /exigem o navegador \(quizaccess_seb\)/);
  assert.equal(called("mod_quiz_start_attempt"), 0);
});

test("navegação sequencial: só a página atual; avançar exige confirmação", async () => {
  st.navmethod = "sequential";
  st.attempts.push({ id: 902, attempt: 1, uniqueid: U, state: "inprogress", currentpage: 0, layout: "1,0,2,0", timestart: NOW });
  const client = await connect();

  const qs = JSON.parse((await tool(client, "moodle_quiz_questions", { attemptId: 902 })).text);
  assert.equal(qs.questions.length, 1, "não abre a página seguinte");
  assert.equal(st.attempts[0]!.currentpage, 0, "ler não avançou");

  const ahead = await tool(client, "moodle_quiz_questions", { attemptId: 902, page: 2 });
  assert.equal(ahead.isError, true);
  assert.equal(st.attempts[0]!.currentpage, 0);

  const other = await tool(client, "moodle_quiz_answer", { attemptId: 902, slot: 2, answer: "a" });
  assert.match(other.text, /só dá para responder questões da página atual \(1\)/);
  assert.equal(st.attempts[0]!.currentpage, 0);

  const prev = await tool(client, "moodle_quiz_next_page", { attemptId: 902 });
  assert.match(prev.text, /NÃO dá para voltar/);
  assert.equal(st.attempts[0]!.currentpage, 0);
  const moved = await tool(client, "moodle_quiz_next_page", { attemptId: 902, confirmationCode: prev.code });
  assert.match(moved.text, /✅ Página 2 aberta/);
  assert.equal(st.attempts[0]!.currentpage, 1);

  const last = await tool(client, "moodle_quiz_next_page", { attemptId: 902 });
  assert.match(last.text, /já é a última página/);
});

test("ferramentas de questionário deixam a regra explícita para a IA", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  for (const name of ["moodle_quiz_start", "moodle_quiz_questions", "moodle_quiz_answer"]) {
    assert.match(tools.find((t) => t.name === name)!.description!, /NÃO sugere, NÃO resolve e NÃO escolhe/, name);
  }
});
