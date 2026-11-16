// Monta a extensão do Claude Desktop (.mcpb):
//   1. compila (dist/)
//   2. cria build/mcpb/ só com o necessário (dist sem .map, dependências de produção, ícone, licença)
//   3. gera manifest.json com a lista real de ferramentas
//   4. valida e empacota em releases/unisinos-moodle-mcp-<versão>.mcpb
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build", "mcpb");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

console.log("» compilando");
run("npm run build");

console.log("» montando build/mcpb");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
for (const f of ["README.md", "LICENSE", "package-lock.json"]) cpSync(join(root, f), join(stage, f));
cpSync(join(root, "assets", "icon.png"), join(stage, "icon.png"));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", license: pkg.license, dependencies: pkg.dependencies }, null, 2),
);
run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);
rmSync(join(stage, "package-lock.json"));

console.log("» lendo as ferramentas do servidor");
const { createServer } = await import(new URL("../dist/server.js", import.meta.url));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const client = new Client({ name: "build", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([createServer().connect(a), client.connect(b)]);
const { tools } = await client.listTools();
await client.close();

const manifest = {
  manifest_version: "0.2",
  name: pkg.name,
  display_name: "Moodle Unisinos",
  version: pkg.version,
  description: "Use o Claude no Moodle da Unisinos: prazos, notas, materiais, entregas, fóruns, mensagens e questionários.",
  long_description: [
    "Conecta o Claude ao **Moodle da Unisinos** (www.moodle.unisinos.br) com a sua própria conta.",
    "",
    "- **Prazos e notas**: o que vence na semana, boletim de cada disciplina, notificações.",
    "- **Materiais**: lê PDFs, slides, planilhas e páginas das aulas para resumir ou tirar dúvidas; baixa arquivos.",
    "- **Tarefas**: mostra o status e entrega arquivos do seu computador.",
    "- **Fóruns e mensagens**: lê avisos dos professores, responde fóruns e envia mensagens.",
    "- **Questionários**: mostra as questões e marca só a resposta que você disser (a IA não sugere respostas).",
    "",
    "Tudo que altera o Moodle (entregar, postar, enviar mensagem, abrir ou enviar questionário) mostra uma **prévia** e só acontece depois da sua confirmação.",
    "",
    "Para começar, diga ao Claude: *\"conecta no meu Moodle\"*. Vai abrir o login da Microsoft da Unisinos; o acesso fica salvo só neste computador.",
    "",
    "Projeto independente, sem vínculo oficial com a Unisinos.",
  ].join("\n"),
  author: { name: pkg.author, url: "https://github.com/renanhrt" },
  repository: { type: "git", url: "https://github.com/renanhrt/unisinos-moodle-mcp" },
  homepage: "https://github.com/renanhrt/unisinos-moodle-mcp",
  support: "https://github.com/renanhrt/unisinos-moodle-mcp/issues",
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: { command: "node", args: ["${__dirname}/dist/index.js"], env: {} },
  },
  tools: tools.map((t) => ({ name: t.name, description: t.title ?? t.name })),
  keywords: ["moodle", "unisinos", "educação", "faculdade"],
  license: pkg.license,
  compatibility: { platforms: ["win32", "darwin", "linux"], runtimes: { node: ">=20.0.0" } },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log("» validando e empacotando");
run(`npx -y ${MCPB} validate manifest.json`, stage);
mkdirSync(join(root, "releases"), { recursive: true });
const out = join(root, "releases", `${pkg.name}-${pkg.version}.mcpb`);
rmSync(out, { force: true });
run(`npx -y ${MCPB} pack . "${out}"`, stage);
if (!existsSync(out)) throw new Error("o .mcpb não foi gerado");
console.log(`\n✅ ${relative(root, out)} (${tools.length} ferramentas)`);
