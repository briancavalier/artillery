import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const mappings = [
  [resolve(root, "public/index.html"), resolve(root, "dist/public/index.html")],
  [resolve(root, "public/style.css"), resolve(root, "dist/public/style.css")],
  [resolve(root, "dist/src/client/main.js"), resolve(root, "dist/public/client.js")]
];

for (const [source, target] of mappings) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
