# AutoDL 抢卡与克隆助手 Pro (`autodl-helper.user.js`)

基于 `Fo-OLLL/autodl-card-helper` 与 `JuntaoTang/AutoDL-GPU-Catcher` 深度整合增强的 Tampermonkey 油猴脚本，面向 AutoDL **普通容器实例**，直接复用当前网页登录态（无需填写开发者 Token）。

## 核心特性

1. **三种抢卡与克隆模式（`抢开机` 面板）**
   - **原实例开机（死守原主机）**：无卡模式运行时先通过 `/api/v1/machine/detail` 检测原主机空闲 GPU 数量，达到需求卡数后才关机并转有卡开机，避免盲目打断无卡任务。
   - **优先原实例开机，必要时克隆（含系统盘+数据盘）**：同时监控原实例主机与同地区候选主机；原主机有卡优先直接开启原实例，原主机无卡且目标服务器有卡时自动克隆。
   - **仅克隆到新服务器并开机（含系统盘+数据盘）**：不尝试开启原实例，直接监控同地区指定的目标服务器或新 GPU 型号（如从 `RTX 4090D` 换到 `RTX 5090`），目标服务器有空闲卡后自动关机源实例并发起克隆。

2. **完整克隆系统盘 + 数据盘 + 稀疏文件优化**
   - 固定开启 `copy_data_disk_after_clone: true`，同时复制系统盘环境与数据盘（`/root/autodl-tmp`）。
   - 支持 **优化稀疏文件拷贝 (`ft_sparse`)** 开关（对应网页克隆弹窗开关）。
   - **容量自动补齐**：自动读取源实例基础盘与扩容盘总容量，若目标服务器基础盘较小，自动计算并上调目标实例 `expand_data_disk`，防止因容量不足导致克隆失败。
   - **数据盘同步闭环**：等待新实例进入 `GPU running` **且** `additional_info.copy_data_disk_after_clone_status === 'Succeed'` 后才标记成功并触发通知。

3. **指定目标服务器（主机 ID 白名单 / 优先级 / 黑名单 + 实时主机表格）**
   - 选择地区与 GPU 型号后，自动加载该地区下所有物理主机列表（包含当前 `0` 空闲卡的机器），展示 `主机ID/编号`、`空闲/总卡`、`驱动/CUDA`、`可扩容盘`、`单卡原价`。
   - 支持在表格中一键点击 **`[+指定]`** 加入目标服务器白名单（或手动输入如 `661机, 756机`），按输入顺序排定抢卡优先级；支持 **`[×排除]`** 拉黑故障主机。
   - 支持切换 **「仅抢指定的主机（白名单）」** 与 **「优先抢指定主机，无卡时允许同条件其他主机」**。

4. **折后单卡价格上限保护**
   - 下单前调用 `/api/v1/order/price/preview` 计算计入会员折扣与优惠后的实际单卡小时价，超出设定价格区间的主机自动跳过。

5. **SSH 连接提取与一键切流**
   - 抢卡或克隆完成后，在任务卡片内直接展示新实例的 `ssh -p <port> root@<host>` 命令，提供 **「复制 SSH 命令」**、**「复制密码」**、**「复制 ~/.ssh/config」** 与 **「复制 PowerShell 切流命令」**（一行命令自动更新本机 `~/.ssh/config` 的 `Host autodl`）。

## 安装方法

1. 在 Chrome / Edge 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展，并在扩展管理页开启「允许运行用户脚本 / 开发者模式」。
2. 点击 **[一键安装 / 更新脚本 (`autodl-helper.user.js`)](https://raw.githubusercontent.com/yshihao636/autodl-card-helper-pro/main/autodl-helper.user.js)**，在弹出的 Tampermonkey 页面点击「安装」（也可以打开本仓库的 `INSTALL.html` 一键复制源码到油猴新建脚本）。
3. 打开 [AutoDL 控制台](https://www.autodl.com/console/instance/list) 并登录，点击页面右下角 **「AutoDL 抢卡」** 即可使用。

## 本地验证命令

```bash
npm run check         # 语法检查
npm test              # 运行 21 项核心状态机与筛选单元测试
npm run test:browser  # 运行 Playwright 浏览器集成冒烟测试（拦截全部网络请求，不触碰真实账号）
```
