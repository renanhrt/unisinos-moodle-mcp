import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { extractContent } from "../src/extract/index.js";
import { MoodleClient, MoodleError } from "../src/moodle/client.js";
import { filenameFromUrl, guessMimetype, safeName, saveDownload } from "../src/moodle/files.js";
import { parseRanges } from "../src/tools/files.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ---------- segurança da URL ----------

test("checkFileUrl só aceita pluginfile do próprio Moodle e remove token", () => {
  const client = new MoodleClient({ baseUrl: "https://www.moodle.unisinos.br", token: "t" });
  assert.equal(
    client.checkFileUrl("https://www.moodle.unisinos.br/webservice/pluginfile.php/1/a.pdf?token=velho").toString(),
    "https://www.moodle.unisinos.br/webservice/pluginfile.php/1/a.pdf",
  );
  assert.throws(() => client.checkFileUrl("https://evil.example/webservice/pluginfile.php/1/a.pdf"), MoodleError);
  assert.throws(() => client.checkFileUrl("http://www.moodle.unisinos.br/webservice/pluginfile.php/1/a.pdf"), MoodleError);
  assert.throws(() => client.checkFileUrl("https://www.moodle.unisinos.br/login/index.php"), MoodleError);
  assert.throws(() => client.checkFileUrl("não é url"), MoodleError);
});

test("downloadFile não segue redirect e repassa erro JSON do Moodle", async () => {
  const seen: RequestInit[] = [];
  const mk = (res: Response) =>
    new MoodleClient({
      baseUrl: "https://m.example",
      token: "t",
      fetchImpl: (async (_u: unknown, init?: RequestInit) => (seen.push(init!), res)) as typeof fetch,
    });
  await assert.rejects(mk(new Response(null, { status: 303, headers: { location: "https://x" } })).downloadFile("https://m.example/pluginfile.php/1/a"), /redirecionou/);
  assert.equal(seen[0]!.redirect, "manual");
  await assert.rejects(
    mk(new Response(JSON.stringify({ error: "Arquivo não encontrado", errorcode: "filenotfound" }), { headers: { "content-type": "application/json" } })).downloadFile("https://m.example/pluginfile.php/1/a"),
    /Arquivo não encontrado/,
  );
  const ok = await mk(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } })).downloadFile("https://m.example/pluginfile.php/1/a");
  assert.deepEqual([...ok.bytes], [1, 2, 3]);
  await assert.rejects(mk(new Response(new Uint8Array(10))).downloadFile("https://m.example/pluginfile.php/1/a", 5), /grande demais/);
});

// ---------- nomes e gravação ----------

test("filenameFromUrl, guessMimetype e safeName", () => {
  assert.equal(filenameFromUrl("https://m/webservice/pluginfile.php/1/mod_resource/content/2/Aula%2001%20-%20Introdu%C3%A7%C3%A3o.pdf?forcedownload=1"), "Aula 01 - Introdução.pdf");
  assert.equal(guessMimetype("x.pptx", "application/x-forcedownload"), PPTX);
  assert.equal(guessMimetype("x.bin", "application/pdf; charset=binary"), "application/pdf");
  assert.equal(guessMimetype("index.html", null), "text/html");
  assert.equal(safeName('a<b>:c"d/e\\f|g?h*.pdf'), "a_b__c_d_e_f_g_h_.pdf");
  assert.equal(safeName(".."), "arquivo");
  assert.equal(safeName("CON.txt"), "arquivo");
});

test("saveDownload organiza em subpasta, reaproveita igual e não sobrescreve diferente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moodle-dl-"));
  try {
    const a = await saveDownload(dir, "Álgebra Linear", "lista.pdf", strToU8("abc"));
    assert.equal(a.path, join(dir, "Álgebra Linear", "lista.pdf"));
    assert.equal(a.reused, false);
    assert.equal((await saveDownload(dir, "Álgebra Linear", "lista.pdf", strToU8("abc"))).reused, true);
    const c = await saveDownload(dir, "Álgebra Linear", "lista.pdf", strToU8("abcd"));
    assert.equal(c.path, join(dir, "Álgebra Linear", "lista (2).pdf"));
    assert.equal(await readFile(a.path, "utf8"), "abc");
    const d = await saveDownload(dir, "../../fora", "x.txt", strToU8("x"));
    assert.ok(d.path.startsWith(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseRanges", () => {
  assert.equal(parseRanges(undefined, 10), null);
  assert.deepEqual([...parseRanges("1-3, 5, 9-20", 10)!], [1, 2, 3, 5, 9, 10]);
  assert.throws(() => parseRanges("a-b", 10), /inválido/);
});

// ---------- extração ----------

test("extrai DOCX com parágrafos, entidades e notas de rodapé", async () => {
  const doc = zipSync({
    "word/document.xml": strToU8(
      '<w:document><w:body><w:p><w:r><w:t>Trabalho &amp; </w:t></w:r><w:r><w:t xml:space="preserve">Avaliação</w:t></w:r></w:p>' +
        "<w:p><w:r><w:t>Item</w:t><w:tab/><w:t>2</w:t></w:r></w:p></w:body></w:document>",
    ),
    "word/footnotes.xml": strToU8("<w:footnotes><w:p><w:r><w:t>Nota 1</w:t></w:r></w:p></w:footnotes>"),
  });
  const r = await extractContent(doc, DOCX);
  assert.equal(r.kind, "text");
  assert.equal(r.kind === "text" && r.parts[0]!.text, "Trabalho & Avaliação\nItem\t2\n\nNota 1");
});

test("extrai PPTX por slide em ordem numérica, com notas", async () => {
  const slide = (t: string) => strToU8(`<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`);
  const pptx = zipSync({
    "ppt/slides/slide10.xml": slide("Dez"),
    "ppt/slides/slide2.xml": slide("Dois"),
    "ppt/slides/slide1.xml": slide("Um"),
    "ppt/notesSlides/notesSlide2.xml": strToU8("<p:notes><a:p><a:r><a:t>Falar devagar</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>"),
  });
  const r = await extractContent(pptx, PPTX);
  assert.ok(r.kind === "text");
  assert.deepEqual(r.parts.map((p) => p.label), ["Slide 1", "Slide 2", "Slide 10"]);
  assert.equal(r.parts[1]!.text, "Dois\n\n[Notas do apresentador]\nFalar devagar");
});

test("extrai XLSX por aba, com strings compartilhadas e colunas vazias", async () => {
  const xlsx = zipSync({
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Notas &amp; Faltas" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/sharedStrings.xml": strToU8("<sst><si><t>Aluno</t></si><si><t>Nota</t></si><si><r><t>A</t></r><r><t>na</t></r></si></sst>"),
    "xl/worksheets/sheet1.xml": strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"/><c r="C2"><v>9.5</v></c></row></sheetData></worksheet>',
    ),
  });
  const r = await extractContent(xlsx, XLSX);
  assert.ok(r.kind === "text");
  assert.equal(r.parts[0]!.label, 'Planilha "Notas & Faltas"');
  assert.equal(r.parts[0]!.text, "Aluno\t\tNota\nAna\t\t9.5");
});

/** PDF mínimo válido com uma página por texto. */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const n = pages.length;
  const pageIds = pages.map((_, i) => 3 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`;
  const fontId = 3 + n * 2;
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`;
    objs[4 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objs[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(out);
}

test("extrai PDF por página", async () => {
  const r = await extractContent(makePdf(["Primeira pagina", "Segunda pagina"]), "application/pdf");
  assert.ok(r.kind === "text", JSON.stringify(r));
  assert.deepEqual(r.parts, [
    { label: "Página 1", text: "Primeira pagina" },
    { label: "Página 2", text: "Segunda pagina" },
  ]);
});

test("HTML, texto Latin-1, imagem e formatos não suportados", async () => {
  const html = await extractContent(strToU8("<h1>Aula</h1><p>Conte&uacute;do</p>"), "text/html");
  assert.ok(html.kind === "text" && html.parts[0]!.text === "Aula\nConteúdo");

  const video = await extractContent(
    strToU8(
      '<p><iframe title="YouTube video player" src="https://www.youtube.com/embed/abc?si=1&amp;t=2"></iframe></p>' +
        '<p>Veja <a href="https://exemplo.org/doc">o material</a> e <a href="#topo">topo</a></p>',
    ),
    "text/html",
  );
  assert.ok(video.kind === "text");
  assert.equal(
    video.parts[0]!.text,
    'Veja o material e topo\n\n[Links e conteúdo incorporado]\n• Vídeo "YouTube video player": https://www.youtube.com/embed/abc?si=1&t=2\n• Link "o material": https://exemplo.org/doc',
  );

  const latin1 = new Uint8Array([...Buffer.from("Avalia", "latin1"), 0xe7, 0xe3, 0x6f, 0x20, ...Array(6).fill(0xe9)]);
  const t = await extractContent(latin1, "text/plain");
  assert.ok(t.kind === "text" && t.parts[0]!.text.startsWith("Avaliação"));

  const img = await extractContent(new Uint8Array([137, 80, 78, 71]), "image/png");
  assert.ok(img.kind === "image" && img.base64 === "iVBORw==");

  assert.equal((await extractContent(new Uint8Array(1), "application/msword")).kind, "unsupported");
  assert.equal((await extractContent(new Uint8Array(1), "audio/mpeg")).kind, "unsupported");
});
