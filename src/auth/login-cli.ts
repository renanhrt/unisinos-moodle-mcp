import { CREDENTIALS_FILE } from "../config.js";
import { login } from "./login.js";

try {
  const creds = await login();
  console.log(`\n✅ Login concluído: ${creds.fullname} (${creds.username}).`);
  console.log(`Token salvo em ${CREDENTIALS_FILE} (fora do repositório).`);
} catch (err) {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
