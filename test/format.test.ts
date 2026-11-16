import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compact,
  formatBytes,
  formatDate,
  htmlToText,
  parseUnisinosCourseName,
  shortCourseName,
} from "../src/moodle/format.js";

test("htmlToText remove tags, decodifica entidades e quebra parágrafos", () => {
  const html = '<p>Entrega&nbsp;at&eacute; <strong>sexta</strong></p><ul><li>PDF</li><li>Código &#8211; zip</li></ul><script>x()</script>';
  assert.equal(htmlToText(html), "Entrega até sexta\n• PDF\n• Código – zip");
  assert.equal(htmlToText("Avalia&ccedil;&atilde;o &Eacute;tica"), "Avaliação Ética");
});

test("htmlToText corta no tamanho máximo", () => {
  assert.equal(htmlToText("<p>abcdefghij</p>", 5), "abcd…");
  assert.equal(htmlToText(null), "");
});

test("formatDate usa o fuso de São Paulo", () => {
  // 2026-03-10 15:00 UTC = 12:00 em São Paulo (UTC-3)
  assert.equal(formatDate(Date.UTC(2026, 2, 10, 15, 0) / 1000), "10/03/2026, 12:00");
  assert.equal(formatDate(0), null);
});

test("htmlToText normaliza \\r\\n", () => {
  assert.equal(htmlToText("<p>a</p>\r\n\r\n<p>b</p>"), "a\n\nb");
});

test("parseUnisinosCourseName separa as partes do nome da disciplina", () => {
  assert.deepEqual(
    parseUnisinosCourseName(
      "2026/2 - Álgebra Linear e Geometria Analítica - GR10001-00001-100001 - 10BSEMI - MARIA DA SILVA SOUZA - Unisinos São Leopoldo - Sede",
    ),
    {
      semester: "2026/2",
      name: "Álgebra Linear e Geometria Analítica",
      code: "GR10001-00001-100001",
      group: "10BSEMI",
      teacher: "Maria da Silva Souza",
      campus: "Unisinos São Leopoldo - Sede",
    },
  );
  assert.deepEqual(
    parseUnisinosCourseName(
      "2026/2 - Projeto Extensionista: Sustentabilidade Socioambiental - GR10002-00002-100002 - QUI - 19:30 - 20SSEMI - Joana Pereira Lima",
    ),
    {
      semester: "2026/2",
      name: "Projeto Extensionista: Sustentabilidade Socioambiental",
      code: "GR10002-00002-100002",
      schedule: "QUI 19:30",
      group: "20SSEMI",
      teacher: "Joana Pereira Lima",
    },
  );
  assert.equal(parseUnisinosCourseName("Curso de Ambientação"), null);
  assert.equal(shortCourseName("Curso de Ambientação"), "Curso de Ambientação");
  assert.equal(titleCase("CARLOS ALBERTO DOS SANTOS"), "Carlos Alberto dos Santos");
});

function titleCase(teacher: string): string | undefined {
  return parseUnisinosCourseName(`2026/2 - X - GR1-1-1 - 10ASEMI - ${teacher}`)?.teacher;
}

test("formatBytes e compact", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.deepEqual(compact({ a: 1, b: null, c: "", d: [], e: "x" }), { a: 1, e: "x" });
});
