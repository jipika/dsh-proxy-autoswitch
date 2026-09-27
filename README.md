# dsh-proxy-autoswitch

> **拥有**：undici 全局 dispatcher 的重装（代理端口消失时切回直连，复活后恢复）。
> **冲突时**：与任何同样重装 dispatcher 的插件互斥（本机无）；只改进程内状态，不落盘配置。
> **回滚**：删 `dsh-proxy-autoswitch` insert + 重启应用。

代理端口失效时，把 dsh 自动切回直连；代理复活后再自动恢复。

## 为什么需要它

代理客户端（Clash Verge 等）退出时常常**不清理**它注入的全局环境变量：

```
http_proxy=http://127.0.0.1:58319
https_proxy=http://127.0.0.1:58319
all_proxy=socks5://127.0.0.1:58320
```

这些变量既在 `launchctl` 全局环境里（所以 Finder/Dock 启动的 app 都会继承），也被写进 shell。
dsh 在**启动时**就把它们解析成一份 `ProxyPolicy` 并装进 undici 的全局 dispatcher
（`@deepseek-ai/dsh-http-proxy` 的 `installProxyFromEnvironment`）。此后：

- 每个模型请求都还往那个端口打 → 报 `DeepSeek Messages transport failed`（`code: TRANSPORT`）；
- **只改环境变量没用**——策略是缓存的（实测：清掉 `http_proxy` 但不重装 dispatcher，请求仍然失败）；
- 显式代理连不上时**不会**自动回退直连（会"自动挑路"的是系统代理/PAC，而这类客户端走的是环境变量）。

## 做法

插件在 host 侧定期对一个 url 做 **TCP 探测**（只确认端口有人监听，不校验 HTTP 语义）：

- 不可达 → 清空 `http_proxy` / `HTTP_PROXY` / `https_proxy` / `HTTPS_PROXY` / `all_proxy` / `ALL_PROXY`，
  再用清空后的环境调一次 `installProxyFromEnvironment` 重装 dispatcher（直连），**立即生效，不重启**；
- 可达 → 把环境恢复成启动时的快照并重装（走代理）；
- 环境里压根没有 `http(s)_proxy`（只有 SOCKS）→ 不介入（SOCKS 本就不被 dsh 采纳，策略本来就是直连）。

直连安装会把"用户导出的原值"写回环境变量（dsh 的既有语义），插件因此在安装后再抹一次，
免得子进程（bash / git / curl）继续照旧去撞那个没人监听的端口。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-proxy-autoswitch
      name: dsh-proxy-autoswitch
      config:
        enabled: true          # false 则完全不介入，也不探测
        intervalMs: 20000      # 探测间隔，下限 3000
        probeTimeoutMs: 1500   # 单次 TCP 探测超时
        verbose: true          # 状态变化时写日志
```

可用 `DSH_ASAR_ROOT` 覆盖 asar 根（默认从宿主进程参数与 Electron 可执行路径推导，
所以无需硬编码 app 安装位置）。

## 依赖的内部接口

`@deepseek-ai/dsh-http-proxy` 的 `installProxyFromEnvironment(env, report)`：

- `env` **不是** `process.env`，而是要求 `env.get(name) → { value }` 的环境视图（插件里自建适配器）；
- 每次调用都会替换 undici 的全局 dispatcher，并返回一个把 dispatcher / 策略 / 环境恢复原状的 disposer；
- 重复调用是安全的（插件每次先调用上一次的 disposer 再重装）。

若将来 dsh 改了这个接口，插件会在日志里报"接口不符"并静默退出，不影响 dsh 其它功能。

## 卸载

```bash
rm -f  ~/.dsh/profiles/desktop/node_modules/dsh-proxy-autoswitch
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.dsh/profiles/desktop/package.json')
d = json.load(open(p)); d['dependencies'].pop('dsh-proxy-autoswitch', None)
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
PY
# 再删掉 cordis.patch.yml 里那段 `- insert:`（搜索 dsh-proxy-autoswitch）
```
