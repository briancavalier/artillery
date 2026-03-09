import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = process.cwd();

export async function createTempWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "artillery-test-"));
  await mkdir(join(workspace, "specs"), { recursive: true });
  await mkdir(join(workspace, "architecture"), { recursive: true });
  await mkdir(join(workspace, "evidence"), { recursive: true });
  await mkdir(join(workspace, "reports"), { recursive: true });
  await mkdir(join(workspace, "ops/canary"), { recursive: true });
  await mkdir(join(workspace, "var/ledger"), { recursive: true });
  return workspace;
}

export async function runScript(
  scriptPath: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
  }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("node", [scriptPath, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env
    }
  });

  return { stdout, stderr };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}
