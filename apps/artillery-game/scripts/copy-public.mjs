import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(process.cwd(), "../..");
const mappings = [
  [resolve(root, "apps/artillery-game/public/index.html"), resolve(root, "dist/apps/artillery-game/public/index.html")],
  [resolve(root, "apps/artillery-game/public/style.css"), resolve(root, "dist/apps/artillery-game/public/style.css")],
  [resolve(root, "dist/apps/artillery-game/src/client/main.js"), resolve(root, "dist/apps/artillery-game/public/client.js")]
];

for (const [source, target] of mappings) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
