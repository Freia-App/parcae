import type { LogApp } from "./log";

/**
 * The client's IP. The ALB APPENDS the connecting address to
 * X-Forwarded-For rather than replacing the header, so only the RIGHTMOST
 * entry is trustworthy; the leftmost is whatever the caller wrote.
 */
export function clientIp(req: any): string {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    const parts = forwarded.split(",");
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? "";
}

export interface ClientIdentity {
  app: LogApp;
  appVersion: string | null;
  platform: string | null;
}

const APPS = new Set<string>(["dashboard", "portal", "mobile", "persona"]);
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const PLATFORM = /^[a-z]{1,16}$/;

/**
 * `<app>/<version>/<platform>`, the `X-Freia-Client` header and the hello
 * `client` field. Anything else is no identity: the value is the client's
 * to write, so only the known apps and short code-shaped parts survive.
 */
export function parseClientIdentity(raw: unknown): ClientIdentity | null {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const [app, version, platform] = raw.trim().split("/");
  if (!app || !APPS.has(app)) return null;
  return {
    app: app as LogApp,
    appVersion: version && VERSION.test(version) ? version : null,
    platform: platform && PLATFORM.test(platform) ? platform : null,
  };
}
