import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const key = readFileSync(join(homedir(), ".ssh", "id_rsa"), "utf8");
const token = process.env.GITHUB_TOKEN;

export function diagnose() {
  return { hasKey: Boolean(key), hasToken: Boolean(token) };
}
