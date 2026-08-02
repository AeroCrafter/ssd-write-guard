import { scanSystem } from "./src/scanner.mjs";

process.stdout.write(`${JSON.stringify(await scanSystem(), null, 2)}\n`);
