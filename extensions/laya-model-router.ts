import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { LayaRouterSocketClient } from "./laya-socket-client.ts";

export const ROUTE_LEVELS = ["low", "medium", "high"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type RouteLevel = (typeof ROUTE_LEVELS)[number];
export type RouterMode = "initial" | "every";
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelTarget {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export interface RouterConfig {
  mode?: RouterMode;
  levels: Partial<Record<RouteLevel, ModelTarget>>;
}

export interface RouteRequest {
  kind: "model_route";
  text: string;
}

export interface RouteDecision {
  level: RouteLevel;
  confidence?: number;
}

export interface RouterClient {
  route(request: RouteRequest): Promise<RouteDecision>;
}

export interface ModelRouterOptions extends RouterClient {
  config: RouterConfig;
  mode?: RouterMode;
  /** If set and the file exists, routing is silently disabled (no route attempt, no warning). */
  markerFile?: string;
}

function isRouterMode(value: unknown): value is RouterMode {
  return value === "initial" || value === "every";
}

function isRouteLevel(value: unknown): value is RouteLevel {
  return typeof value === "string" && ROUTE_LEVELS.includes(value as RouteLevel);
}

function parseConfig(path: string): RouterConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    mode?: unknown;
    levels?: Record<string, unknown>;
  };
  if (parsed.mode !== undefined && !isRouterMode(parsed.mode)) {
    throw new Error(`Router config ${path} must use mode "initial" or "every"`);
  }
  if (!parsed.levels || typeof parsed.levels !== "object" || Array.isArray(parsed.levels)) {
    throw new Error(`Router config ${path} must contain a levels object`);
  }

  const levels: RouterConfig["levels"] = {};
  for (const [level, rawTarget] of Object.entries(parsed.levels)) {
    if (!isRouteLevel(level)) throw new Error(`Unknown router level "${level}" in ${path}`);
    if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
      throw new Error(`Router level "${level}" in ${path} must be an object`);
    }
    const target = rawTarget as Record<string, unknown>;
    if (typeof target.provider !== "string" || typeof target.model !== "string") {
      throw new Error(`Router level "${level}" in ${path} requires provider and model strings`);
    }
    if (target.thinkingLevel !== undefined && !THINKING_LEVELS.includes(target.thinkingLevel as ThinkingLevel)) {
      throw new Error(`Router level "${level}" in ${path} has an invalid thinkingLevel`);
    }
    levels[level] = {
      provider: target.provider,
      model: target.model,
      ...(target.thinkingLevel !== undefined ? { thinkingLevel: target.thinkingLevel as ThinkingLevel } : {}),
    };
  }
  return {
    ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
    levels,
  };
}

export function loadRouterConfig(
  cwd: string,
  projectTrusted: boolean,
  agentDir: string,
  configDirName: string,
): RouterConfig {
  const paths = [join(agentDir, "laya-model-router.json")];
  if (projectTrusted) paths.push(join(cwd, configDirName, "laya-model-router.json"));

  const levels: RouterConfig["levels"] = {};
  let mode: RouterMode | undefined;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const config = parseConfig(path);
    Object.assign(levels, config.levels);
    if (config.mode) mode = config.mode;
  }
  return { mode, levels };
}

function formatStatusLine(config: RouterConfig, mode: RouterMode, state: string): string {
  const mappings = ROUTE_LEVELS.map((level) => {
    const target = config.levels[level];
    return `${level}: ${target ? targetLabel(target) : "unmapped"}`;
  });
  return `Laya model router — ${state} (mode: ${mode})\n${mappings.join("\n")}`;
}

function targetLabel(target: ModelTarget): string {
  const thinking = target.thinkingLevel ? ` (thinking: ${target.thinkingLevel})` : "";
  return `${target.provider}/${target.model}${thinking}`;
}

export function createLayaModelRouter(options: ModelRouterOptions) {
  return function register(pi: ExtensionAPI): void {
    let lastRoute: { level: RouteLevel; target: ModelTarget } | undefined;
    let routedInitialPrompt = false;

    const markerFile = options.markerFile;
    const isTurnedOff = (): boolean => !!markerFile && existsSync(markerFile);
    const writeMarker = (): void => {
      if (!markerFile) return;
      writeFileSync(markerFile, "");
    };
    const removeMarker = (): void => {
      if (!markerFile) return;
      rmSync(markerFile, { force: true });
    };

    async function systemctl(args: string[]): Promise<string> {
      const result = await pi.exec("systemctl", ["--user", ...args]);
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        throw new Error(`systemctl ${args.join(" ")} failed (${result.code})${detail ? `: ${detail}` : ""}`);
      }
      return result.stdout.trim();
    }

    async function serviceActive(): Promise<boolean> {
      const result = await pi.exec("systemctl", ["--user", "is-active", "pi-laya"]);
      return result.stdout.trim() === "active";
    }

    async function setOffState(off: boolean, ctx: ExtensionContext): Promise<void> {
      try {
        if (off) {
          await systemctl(["stop", "pi-laya"]);
          writeMarker();
        } else {
          await systemctl(["start", "pi-laya"]);
          removeMarker();
        }
        ctx.ui.notify(`Laya router ${off ? "off — service stopped" : "on — service started"}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Laya router toggle failed: ${message}`, "error");
      }
    }

    function updateStatus(ctx: ExtensionContext): void {
      ctx.ui.setStatus(
        "laya-model-router",
        lastRoute && !isTurnedOff() ? `route:${lastRoute.level} → ${lastRoute.target.model}` : undefined,
      );
    }

    pi.registerCommand("laya-router", {
      description: "Show Laya model-router state and level mappings, or toggle it on/off",
      handler: async (args, ctx) => {
        const subcommand = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const mode = options.mode ?? options.config.mode ?? "initial";

        if (subcommand === "on" || subcommand === "off" || subcommand === "toggle") {
          if (subcommand === "toggle") {
            const wasActive = await serviceActive().catch(() => false);
            await setOffState(wasActive, ctx);
          } else {
            await setOffState(subcommand === "off", ctx);
          }
          return;
        }
        if (subcommand === "status" || subcommand === "") {
          let state: string;
          if (isTurnedOff()) {
            state = "off";
          } else {
            try {
              state = (await serviceActive()) ? "on" : "inactive";
            } catch {
              state = "unknown";
            }
          }
          ctx.ui.notify(formatStatusLine(options.config, mode, state), "info");
          return;
        }
        ctx.ui.notify(
          "Usage: /laya-router [on|off|status|toggle]\n" +
          "  on      start the pi-laya service\n" +
          "  off     stop the pi-laya service\n" +
          "  status  show mode, level mappings and service state (default)\n" +
          "  toggle  flip between on and off",
          "warning",
        );
      },
    });

    pi.on("before_agent_start", async (event, ctx) => {
      if (isTurnedOff()) return;
      if (Object.keys(options.config.levels).length === 0) return;
      const mode = options.mode ?? options.config.mode ?? "initial";
      if (mode === "initial" && routedInitialPrompt) return;
      if (mode === "initial") routedInitialPrompt = true;

      let decision: RouteDecision;
      try {
        decision = await options.route({ kind: "model_route", text: event.prompt });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Laya model router unavailable; keeping current model: ${message}`, "warning");
        return;
      }

      const target = options.config.levels[decision.level];
      if (!target) {
        ctx.ui.notify(`Laya selected unmapped level "${decision.level}"; keeping current model`, "warning");
        return;
      }

      const model = ctx.modelRegistry.find(target.provider, target.model);
      if (!model) {
        ctx.ui.notify(`Laya route target not found: ${targetLabel(target)}`, "warning");
        return;
      }
      const previousModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const nextModel = `${target.provider}/${target.model}`;
      if (!(await pi.setModel(model))) {
        ctx.ui.notify(`Laya route target has no configured authentication: ${targetLabel(target)}`, "warning");
        return;
      }

      if (target.thinkingLevel) pi.setThinkingLevel(target.thinkingLevel);
      lastRoute = { level: decision.level, target };
      updateStatus(ctx);
      if (previousModel !== nextModel) {
        ctx.ui.notify(`Laya routed this task to ${decision.level} → ${nextModel}`, "info");
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      routedInitialPrompt = ctx.sessionManager.getBranch().some((entry) => (
        entry.type === "message" && entry.message.role === "user"
      ));
      updateStatus(ctx);
    });
  };
}

export default async function layaModelRouter(pi: ExtensionAPI): Promise<void> {
  const { CONFIG_DIR_NAME, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const socketPath = process.env.PI_LAYA_SOCKET ?? "/tmp/pi-laya-guardrails.sock";
  const configuredTimeout = Number(process.env.PI_LAYA_TIMEOUT_MS ?? "2000");
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 2_000;
  const configuredMode = process.env.PI_LAYA_ROUTER_MODE;
  const environmentMode: RouterMode | undefined = isRouterMode(configuredMode) ? configuredMode : undefined;
  let config: RouterConfig;

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadRouterConfig(ctx.cwd, ctx.isProjectTrusted(), getAgentDir(), CONFIG_DIR_NAME);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not load Laya model-router config: ${message}`, "error");
      config = { levels: {} };
    }
  });

  const client = new LayaRouterSocketClient(socketPath, timeoutMs);
  createLayaModelRouter({
    get config() { return config ?? { levels: {} }; },
    mode: environmentMode,
    markerFile: join(getAgentDir(), "laya-router-disabled"),
    route: (request) => client.route(request),
  })(pi);
}
