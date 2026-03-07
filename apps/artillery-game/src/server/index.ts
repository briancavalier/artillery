import { createArtilleryServer } from "./http.js";

const port = Number(process.env.PORT ?? 4173);
const server = createArtilleryServer();

server.listen(port).then(() => {
  // eslint-disable-next-line no-console
  console.log(`Artillery server listening on http://127.0.0.1:${port}`);
}).catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
