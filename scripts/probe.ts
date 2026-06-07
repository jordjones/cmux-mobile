/**
 * Dev probe — dump the shapes of cmux topology methods so modules are built on
 * the real JSON. Read-only. Run: bun run scripts/probe.ts [method]
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";

const method = process.argv[2];
const client = new CmuxSocketClient();
await client.connect();

async function dump(m: string, params: Record<string, unknown> = {}): Promise<void> {
  try {
    const r = await client.call(m, params);
    console.log(`\n===== ${m} ${JSON.stringify(params)} =====`);
    console.log(JSON.stringify(r, null, 2).slice(0, 2500));
  } catch (e) {
    console.log(`\n===== ${m} FAILED: ${(e as Error).message} =====`);
  }
}

if (method) {
  await dump(method);
} else {
  await dump("system.tree");
  await dump("window.list");
  await dump("workspace.list");
  await dump("surface.list");
}

client.close();
