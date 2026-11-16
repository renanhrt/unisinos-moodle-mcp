#!/usr/bin/env node
/**
 * unisinos-moodle-mcp
 *   (sem argumentos)  inicia o servidor MCP (stdio) — é assim que o Claude chama
 *   login             abre o navegador para entrar com a conta da Unisinos
 *   whoami            mostra quem está logado
 *   logout            apaga o acesso salvo neste computador
 */
const cmd = process.argv[2];

if (cmd === "login") {
  await import("./auth/login-cli.js");
} else if (cmd === "whoami") {
  await import("./auth/whoami-cli.js");
} else if (cmd === "logout") {
  const { deleteCredentials } = await import("./auth/store.js");
  const { CREDENTIALS_FILE } = await import("./config.js");
  await deleteCredentials();
  console.log(`Acesso apagado (${CREDENTIALS_FILE}).`);
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log("Uso: unisinos-moodle-mcp [login | whoami | logout]\nSem argumentos, inicia o servidor MCP para o Claude.");
} else if (cmd === "--version" || cmd === "-v") {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
} else {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createServer } = await import("./server.js");
  // stdout é o canal do protocolo MCP: logs vão sempre para stderr.
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("unisinos-moodle MCP rodando (stdio).");
}
