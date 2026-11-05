// Project plugins: features that only make sense for some projects (their own files, tools or workflow).
// `vibedoc.config.json` lists them in `plugins` as ES module paths relative to the repository root; each
// module default-exports a VibeDocPlugin. Plugins are the project's own code and run with full trust.
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "./config.ts";
import { DocSystem } from "./docs/store.ts";

export type PluginContext = {
  root: string;
  cfg: Config;
  docs: DocSystem;
  // Tells open boards that this plugin's data changed (the plugin view re-renders).
  notify: () => void;
};
type Maybe<T> = T | Promise<T>;
export type VibeDocPlugin = {
  name: string; // [a-z0-9-], used in URLs and commands
  title?: string; // board tab label; needs `client`
  client?: string; // browser script (relative to the plugin file) that calls VibeDoc.registerView(name, render)
  commands?: Record<string, { describe: string; run: (args: string[], ctx: PluginContext) => Maybe<void> }>;
  get?: Record<string, (query: URLSearchParams, ctx: PluginContext) => Maybe<unknown>>; // GET /api/p/<id>/plugins/<name>/<route>
  post?: Record<string, (data: any, ctx: PluginContext) => Maybe<unknown>>; // POST, with the board token
  watch?: string[]; // repository-relative paths whose changes call notify()
  rules?: string; // Markdown bullets added to the AGENTS.md rule block under "Project plugins"
};
export type LoadedPlugin = { plugin: VibeDocPlugin; file: string; dir: string };

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

// Loads every configured plugin; a broken one is reported in `errors` instead of stopping the others.
export async function loadPlugins(root: string, cfg: Config): Promise<{ plugins: LoadedPlugin[]; errors: string[] }> {
  const plugins: LoadedPlugin[] = [];
  const errors: string[] = [];
  for (const rel of cfg.plugins) {
    const file = resolve(root, rel);
    try {
      if (!existsSync(file)) throw new Error("文件不存在");
      // The mtime query makes a changed plugin load fresh instead of from the module cache.
      const mod = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
      const plugin = (mod.default ?? mod.plugin) as VibeDocPlugin;
      if (!plugin || typeof plugin !== "object" || !NAME.test(plugin.name ?? "")) throw new Error("默认导出必须是带合法 name 的插件对象");
      if (plugins.some((p) => p.plugin.name === plugin.name)) throw new Error(`插件名 ${plugin.name} 重复`);
      if (plugin.client && !existsSync(join(dirname(file), plugin.client))) throw new Error(`client 脚本 ${plugin.client} 不存在`);
      plugins.push({ plugin, file, dir: dirname(file) });
    } catch (error) {
      errors.push(`${rel}：${(error as Error).message}`);
    }
  }
  return { plugins, errors };
}

export const pluginContext = (root: string, cfg: Config, notify: () => void = () => {}): PluginContext => ({ root, cfg, docs: new DocSystem(root, cfg), notify });

// The rule text plugins contribute to the AGENTS.md block, in config order.
export const pluginRules = (plugins: LoadedPlugin[]) =>
  plugins.filter((p) => p.plugin.rules?.trim()).map((p) => `### ${p.plugin.title ?? p.plugin.name}\n\n${p.plugin.rules!.trim()}`).join("\n\n");
