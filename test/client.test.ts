import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenParams, MoodleClient, MoodleError } from "../src/moodle/client.js";

test("flattenParams usa a notação de colchetes do Moodle", () => {
  assert.deepEqual(
    flattenParams({
      userid: 42,
      courseids: [3, 7],
      options: [{ name: "excludemodules", value: true }],
      skip: undefined,
      nada: null,
    }),
    [
      ["userid", "42"],
      ["courseids[0]", "3"],
      ["courseids[1]", "7"],
      ["options[0][name]", "excludemodules"],
      ["options[0][value]", "1"],
    ],
  );
});

function fakeFetch(body: unknown, init: { status?: number; contentType?: string } = {}) {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({ url: String(url), body: String(opts?.body ?? "") });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

test("call envia token e parâmetros e devolve o JSON", async () => {
  const { impl, calls } = fakeFetch({ sitename: "Moodle Unisinos" });
  const client = new MoodleClient({ baseUrl: "https://m.example/", token: "abc", fetchImpl: impl });
  const data = await client.call<{ sitename: string }>("core_webservice_get_site_info", { a: [1] });

  assert.equal(data.sitename, "Moodle Unisinos");
  assert.equal(
    calls[0]!.url,
    "https://m.example/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=core_webservice_get_site_info",
  );
  assert.equal(calls[0]!.body, "wstoken=abc&a%5B0%5D=1");
});

test("call transforma exceções do Moodle em MoodleError", async () => {
  const { impl } = fakeFetch({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Token inválido" });
  const client = new MoodleClient({ baseUrl: "https://m.example", token: "x", fetchImpl: impl });

  await assert.rejects(client.call("x"), (err: unknown) => {
    assert.ok(err instanceof MoodleError);
    assert.equal(err.errorcode, "invalidtoken");
    assert.equal(err.isAuthError, true);
    return true;
  });
});

test("call aceita respostas null (funções sem retorno)", async () => {
  const { impl } = fakeFetch("null");
  const client = new MoodleClient({ baseUrl: "https://m.example", token: "x", fetchImpl: impl });
  assert.equal(await client.call("x"), null);
});

test("authenticatedFileUrl troca para webservice/pluginfile e adiciona token", () => {
  const client = new MoodleClient({ baseUrl: "https://m.example", token: "tok" });
  assert.equal(
    client.authenticatedFileUrl("https://m.example/pluginfile.php/10/mod_resource/content/1/aula.pdf?forcedownload=1"),
    "https://m.example/webservice/pluginfile.php/10/mod_resource/content/1/aula.pdf?forcedownload=1&token=tok",
  );
  assert.equal(
    client.authenticatedFileUrl("https://m.example/webservice/pluginfile.php/10/x.pdf"),
    "https://m.example/webservice/pluginfile.php/10/x.pdf?token=tok",
  );
});
