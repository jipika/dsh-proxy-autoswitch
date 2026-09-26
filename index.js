/**
 * dsh-proxy-autoswitch — 代理失效时自动切回直连
 *
 * 问题：代理客户端（Clash Verge 等）退出时常常没清理它注入的 http_proxy / https_proxy /
 * all_proxy 全局环境变量，而 dsh 在启动时就把这些变量解析成一份 ProxyPolicy 并装进 undici 的
 * 全局 dispatcher（@deepseek-ai/dsh-http-proxy 的 installProxyFromEnvironment）。策略是缓存的，
 * 端口没人监听后每个模型请求都还往那儿打，报 `TRANSPORT` 失败，且**不会**自动回退直连。
 *
 * 做法：定期对 http(s)_proxy 的 host:port 做 TCP 探测（不看 HTTP 语义，只确认端口活着），
 * 死了就清空代理变量并重装 dispatcher（直连），复活了再把环境还原回去并重装（走代理）。
 * 因为 installProxyFromEnvironment 每次都重装 undici 的全局 dispatcher，切换对本进程的
 * 后续请求立即生效，不需要重启。
 *
 * 只探测 http/https 代理：SOCKS（all_proxy=socks5://…）本就不被 dsh 采纳（它会打印
 * "names a SOCKS proxy, which is not supported"），所以当环境里只有 SOCKS 时代理策略本来就是
 * 直连，本插件不介入；一旦判定要切直连，则连同 all_proxy 一起清空，免得子进程（curl/git）
 * 继续撞死端口。
 */
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "dsh-proxy-autoswitch";

// 不声明 inject：cordis 4 里 "config" 不是可注入的服务（写进 inject 会永久 pending），
// entry config 从 ctx.fiber.config 读。
const PROBE_NAMES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"];
const ALL_NAMES = [...PROBE_NAMES, "all_proxy", "ALL_PROXY"];
const DEFAULT_INTERVAL_MS = 20000;
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const MIN_INTERVAL_MS = 3000;

/** 解析一个 http(s) 代理 URL；SOCKS/畸形值一律返回 undefined（与 dsh 的采纳规则保持一致）。 */
function parseHttpProxy(value) {
  if (typeof value !== "string" || value.length === 0) return void 0;
  let url;
  try {
    url = new URL(value);
  } catch {
    return void 0;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0) return void 0;
  return { hostname: url.hostname, port };
}

/** TCP 连得上就算代理活着（探测只关心端口是否有人监听）。 */
function tcpAlive(target, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: target.hostname, port: target.port });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** true=至少一个代理端口活着，false=都不可达，undefined=环境里压根没配 http 代理（不介入）。 */
async function anyProxyAlive(env, timeoutMs) {
  const candidates = PROBE_NAMES.map((name) => parseHttpProxy(env[name])).filter((target) => target !== undefined);
  if (candidates.length === 0) return void 0;
  for (const candidate of candidates) {
    if (await tcpAlive(candidate, timeoutMs)) return true;
  }
  return false;
}

/** 推导 app.asar 根：环境变量覆盖 → 宿主进程参数 → Electron 可执行文件位置（都不硬编码安装路径）。 */
function asarRoots() {
  const roots = [];
  const override = process.env.DSH_ASAR_ROOT;
  if (typeof override === "string" && override.length > 0) roots.push(override);
  const marker = process.argv.find((arg) => typeof arg === "string" && arg.includes("app.asar"));
  if (marker !== undefined) roots.push(marker.slice(0, marker.indexOf("app.asar") + "app.asar".length));
  const exe = process.execPath;
  const macIndex = exe.indexOf("/Contents/MacOS/");
  if (macIndex >= 0) roots.push(join(exe.slice(0, macIndex), "Contents", "Resources", "app.asar"));
  return [...new Set(roots)];
}

/** dsh-http-proxy 入口的候选 URL，按推导出的 asar 根逐个尝试。 */
function proxyModuleUrls() {
  return asarRoots().map((root) =>
    pathToFileURL(join(root, "dsh", "node_modules", "@deepseek-ai", "dsh-http-proxy", "lib", "index.js")).href,
  );
}

export function apply(ctx) {
  const config = ctx !== undefined && typeof ctx.fiber?.config === "object" && ctx.fiber.config !== null ? ctx.fiber.config : {};
  const enabled = config.enabled !== false;
  const intervalMs = Math.max(MIN_INTERVAL_MS, Number(config.intervalMs) || DEFAULT_INTERVAL_MS);
  const probeTimeoutMs = Math.max(200, Number(config.probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
  const verbose = config.verbose !== false;

  const log = (message) => {
    if (!verbose) return;
    const line = `[dsh-proxy-autoswitch] ${message}`;
    try {
      if (ctx !== undefined && ctx.logger !== undefined && typeof ctx.logger.info === "function") {
        ctx.logger.info(line);
        return;
      }
    } catch {}
    console.error(line);
  };

  if (!enabled) {
    log("已禁用（config.enabled === false），不做任何探测");
    return;
  }

  let baseline; // 首次安装之前的环境快照（用户/dsh 发布后的值）
  let disposer; // 当前这次安装的 disposer
  let state; // "proxy" | "direct" | "idle"
  let proxyModule; // @deepseek-ai/dsh-http-proxy
  let timer;

  // dsh 的 readEnv 只要求 env.get(name) → { value }（不是 raw process.env）；写回由它内部直接操作 process.env。
  const envView = {
    get(name) {
      const value = process.env[name];
      return value === undefined ? void 0 : { value };
    },
  };
  const snapshotEnv = () => Object.fromEntries(ALL_NAMES.map((name) => [name, process.env[name]]));
  const writeEnv = (values) => {
    for (const name of ALL_NAMES) {
      const value = values[name];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
  const clearEnv = () => writeEnv(Object.fromEntries(ALL_NAMES.map((name) => [name, void 0])));

  async function install(want) {
    // 顺序要紧：先撤掉上一次安装（它会把 dispatcher 和环境恢复成安装前的样子），
    // 再写入目标环境，最后按新环境重装 —— 否则撤销动作会把刚写好的环境冲掉。
    if (disposer !== undefined) {
      const previous = disposer;
      disposer = void 0;
      try {
        await previous();
      } catch (error) {
        log(`撤销上一次安装失败：${error && error.message}`);
      }
    }
    if (want === "proxy") writeEnv(baseline);
    else clearEnv();
    disposer = await proxyModule.installProxyFromEnvironment(envView, (message) => log(`策略：${message}`));
    // 直连安装会把"用户导出的原值"写回环境（dsh 的既有语义），这里再抹一次，
    // 否则子进程（bash / git / curl）还会照旧去撞那个已经没人监听的端口。
    if (want === "direct") clearEnv();
    state = want;
  }

  async function evaluate(reason) {
    const alive = await anyProxyAlive(baseline, probeTimeoutMs);
    if (alive === undefined) {
      if (state === undefined) {
        state = "idle";
        log("环境里没有 http(s)_proxy，无需介入");
      }
      return;
    }
    const want = alive ? "proxy" : "direct";
    if (want === state) {
      // 兜底：直连状态下若代理变量又被写回来（别的安装路径也会发布环境），再抹掉。
      if (want === "direct" && PROBE_NAMES.some((name) => process.env[name] !== undefined)) clearEnv();
      return;
    }
    await install(want);
    log(
      want === "proxy"
        ? `代理端口可达（${reason}）→ 保持/恢复走代理`
        : `代理端口不可达（${reason}）→ 已切回直连（清空 http_proxy/https_proxy/all_proxy 并重装 dispatcher）`,
    );
  }

  (async () => {
    const urls = proxyModuleUrls();
    if (urls.length === 0) {
      log("定位不到 app.asar（可用 DSH_ASAR_ROOT 覆盖），插件不生效");
      return;
    }
    for (const url of urls) {
      try {
        proxyModule = await import(url);
        break;
      } catch (error) {
        log(`加载候选失败（${url}）：${error && error.message}`);
      }
    }
    if (proxyModule === undefined) {
      log("dsh-http-proxy 加载失败，插件不生效");
      return;
    }
    if (typeof proxyModule.installProxyFromEnvironment !== "function") {
      log("dsh-http-proxy 接口不符（缺 installProxyFromEnvironment），插件不生效");
      return;
    }
    baseline = snapshotEnv();
    await evaluate("启动");
    timer = setInterval(() => {
      evaluate("周期检查").catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    log(`已启动：每 ${Math.round(intervalMs / 1000)}s 探测一次，超时 ${probeTimeoutMs}ms，当前状态 ${state}`);
    ctx.effect(
      () => () => {
        clearInterval(timer);
        if (disposer !== undefined) {
          const previous = disposer;
          disposer = void 0;
          Promise.resolve()
            .then(() => previous())
            .catch(() => {});
        }
        if (baseline !== undefined) writeEnv(baseline);
      },
      "dsh-proxy-autoswitch: 轮询定时器与 dispatcher",
    );
  })().catch((error) => log(`初始化异常：${error && error.message}`));
}
