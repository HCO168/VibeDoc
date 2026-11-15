// Hosted board pages: the same board served from a website (for example https://vibedoc.hconet.com) that talks to
// this machine's VibeDoc server on 127.0.0.1. Off until the user allows it (`vibedoc web on`), and then only for the
// origins listed in ~/.config/vibedoc/settings.json. Requests from any other website are refused, and every request
// must be addressed to 127.0.0.1 / localhost so a rebound DNS name cannot reach the server.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { registryFile } from "./registry.ts";

/** The official hosted board (production and the HCONet dev site). */
export const DEFAULT_WEB_ORIGINS = ["https://vibedoc.hconet.com", "https://vibedoc.hcon.dev"];
/** Bumped when the hosted page needs server changes; the page refuses an older server with a hint to update. */
export const WEB_API_VERSION = 1;

const settingsFile = () => join(dirname(registryFile()), "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function webOrigins(): string[] {
  const list = readSettings().webOrigins;
  return Array.isArray(list) ? list.map(String) : [];
}

/** Normalizes `https://Host/path` to `https://host`; only https origins (or http on loopback) are accepted. */
export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`不是有效的网址：${value}`);
  }
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`只能允许 https 网站：${value}`);
  return url.origin;
}

export function setWebOrigins(origins: string[]): string[] {
  const unique = [...new Set(origins.map(normalizeOrigin))];
  const file = settingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...readSettings(), webOrigins: unique }, null, 2)}\n`);
  return unique;
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * Checks a request before routing. Returns "local" for the board this server serves (and for clients that send no
 * Origin, such as the CLI and scripts), "web" for an allowed hosted page (CORS headers are set), or null when the
 * request was refused or fully answered (a preflight).
 */
export function gate(req: IncomingMessage, res: ServerResponse, port: number): "local" | "web" | null {
  const refuse = (error: string) => {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error }));
    return null;
  };
  if (!LOOPBACK_HOST.test(String(req.headers.host ?? ""))) return refuse("只接受发给 127.0.0.1 的本机请求");
  const origin = req.headers.origin;
  if (!origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) {
    if (req.method === "OPTIONS") return refuse("不需要跨域");
    return "local";
  }
  if (!webOrigins().includes(origin)) return refuse(`没有允许 ${origin} 访问本机 VibeDoc；在终端运行 vibedoc web on 后重试`);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, X-Board-Token",
      "Access-Control-Max-Age": "600",
    };
    // Chrome's Private Network Access preflight for a public page reaching loopback.
    if (req.headers["access-control-request-private-network"] === "true") headers["Access-Control-Allow-Private-Network"] = "true";
    res.writeHead(204, headers);
    res.end();
    return null;
  }
  return "web";
}
