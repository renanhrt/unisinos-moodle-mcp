import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, formatBytes, formatDate, htmlToText } from "../src/moodle/format.js";

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

test("formatBytes e compact", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.deepEqual(compact({ a: 1, b: null, c: "", d: [], e: "x" }), { a: 1, e: "x" });
});
