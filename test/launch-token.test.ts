import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildLaunchUrl,
  decodeLaunchToken,
  findLaunchToken,
  LaunchTokenError,
} from "../src/auth/launch-token.js";

const SITE = "https://www.moodle.unisinos.br";
const PASSPORT = "abc123";
const TOKEN = "0123456789abcdef0123456789abcdef";

function encode(site: string, passport: string, rest: string): string {
  const sig = createHash("md5").update(site + passport).digest("hex");
  return Buffer.from(`${sig}:::${rest}`).toString("base64");
}

test("buildLaunchUrl monta a URL do app mobile", () => {
  assert.equal(
    buildLaunchUrl(SITE + "/", "moodle_mobile_app", PASSPORT),
    `${SITE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=abc123&urlscheme=moodlemobile`,
  );
});

test("decodeLaunchToken valida a assinatura e devolve o token", () => {
  assert.deepEqual(decodeLaunchToken(encode(SITE, PASSPORT, TOKEN), SITE, PASSPORT), { token: TOKEN });
  assert.deepEqual(decodeLaunchToken(encode(SITE, PASSPORT, `${TOKEN}:::priv`), SITE, PASSPORT), {
    token: TOKEN,
    privateToken: "priv",
  });
});

test("decodeLaunchToken rejeita assinatura de outro site ou passport", () => {
  assert.throws(() => decodeLaunchToken(encode("https://evil.example", PASSPORT, TOKEN), SITE, PASSPORT), LaunchTokenError);
  assert.throws(() => decodeLaunchToken(encode(SITE, "outro", TOKEN), SITE, PASSPORT), LaunchTokenError);
  assert.throws(() => decodeLaunchToken(Buffer.from("lixo").toString("base64"), SITE, PASSPORT), LaunchTokenError);
});

test("findLaunchToken acha o token em Location e em HTML", () => {
  const enc = encode(SITE, PASSPORT, TOKEN);
  assert.equal(findLaunchToken(`moodlemobile://token=${enc}`), enc);
  assert.equal(findLaunchToken(`<a href="moodlemobile://token=${encodeURIComponent(enc)}">Abrir</a>`), enc);
  assert.equal(findLaunchToken("<html>nada</html>"), null);
});
