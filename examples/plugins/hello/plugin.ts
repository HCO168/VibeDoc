// A minimal VibeDoc plugin: a command, a GET/POST route, a watched file, a board tab and a rule.
// Enable it with "plugins": ["path/to/plugin.ts"] in vibedoc.config.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "hello.txt";

export default {
  name: "hello",
  title: "问候",
  client: "client.js",
  watch: [FILE],
  rules: "- Write greetings with `vibedoc hello <名字>`; never edit `hello.txt` by hand.",
  commands: {
    hello: {
      describe: "把问候写进 hello.txt",
      run(args: string[], ctx: { root: string }) {
        writeFileSync(join(ctx.root, FILE), `你好，${args[0] ?? "世界"}\n`);
        console.log(`已写入 ${FILE}`);
      },
    },
  },
  get: {
    greeting: (_q: URLSearchParams, ctx: { root: string }) => ({ text: existsSync(join(ctx.root, FILE)) ? readFileSync(join(ctx.root, FILE), "utf8") : "" }),
  },
  post: {
    greet: (data: { name?: string }, ctx: { root: string; notify: () => void }) => {
      writeFileSync(join(ctx.root, FILE), `你好，${data.name || "世界"}\n`);
      ctx.notify();
    },
  },
};
