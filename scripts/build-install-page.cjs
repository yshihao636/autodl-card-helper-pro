'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const scriptSource = fs.readFileSync(path.join(root, 'autodl-helper.user.js'), 'utf8');
const escapedJson = JSON.stringify(scriptSource).replace(/<\//g, '<\\/');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AutoDL 抢卡与克隆助手 Pro · 安装与沙盒预览</title>
  <style>
    :root {
      --bg: #f8fafc;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --border: #cbd5e1;
      --accent: #0284c7;
      --accent-hover: #0369a1;
      --ok: #059669;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 15px/1.65 "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      color: var(--ink);
      background: var(--bg);
      padding: 36px 20px 100px;
    }
    .container {
      max-width: 920px;
      margin: 0 auto;
    }
    header {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px 28px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 18px;
    }
    button {
      font: inherit;
      cursor: pointer;
      border-radius: 8px;
      padding: 10px 18px;
      font-weight: 600;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--ink);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    button.primary:hover {
      background: var(--accent-hover);
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }
    .step-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
    }
    .step-card strong {
      display: block;
      margin-bottom: 6px;
      color: var(--accent-hover);
    }
    pre {
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 10px;
      padding: 16px;
      max-height: 440px;
      overflow: auto;
      font: 12.5px/1.6 "Cascadia Mono", "JetBrains Mono", ui-monospace, monospace;
      margin: 0;
    }
    .toast {
      display: inline-block;
      margin-left: 10px;
      color: var(--ok);
      font-weight: 600;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>AutoDL 抢卡与克隆助手 Pro v1.1.0</h1>
      <p class="subtitle">支持系统盘 + 数据盘完整克隆 · 指定目标服务器 (machine_id / 编号) · 稀疏文件优化 (ft_sparse) · 折后单价过滤 · SSH 一键切流</p>
      <div class="actions">
        <button class="primary" id="copy-btn">一键复制油猴脚本代码</button>
        <button id="demo-btn">在本页启动交互沙盒预览（右下角）</button>
        <span class="toast" id="toast" hidden>✓ 已复制到剪贴板，请打开 Tampermonkey 新建脚本粘贴保存</span>
      </div>
    </header>

    <div class="steps">
      <div class="step-card">
        <strong>1. 安装 Tampermonkey</strong>
        在 Chrome 或 Edge 扩展商店安装 Tampermonkey（油猴），并在浏览器扩展管理页开启「开发者模式 / 允许运行用户脚本」。
      </div>
      <div class="step-card">
        <strong>2. 新建并粘贴脚本</strong>
        点击上方「一键复制油猴脚本代码」，打开 Tampermonkey 面板 → 点击「+ 添加新脚本」→ 全选替换原有代码 → 按 Ctrl+S 保存。
      </div>
      <div class="step-card">
        <strong>3. 打开 AutoDL 控制台使用</strong>
        登录 <a href="https://www.autodl.com/console/instance/list" target="_blank" rel="noopener">AutoDL 实例列表</a>，点击右下角「AutoDL 抢卡」即可选择源实例、勾选克隆模式并指定要抢的服务器。
      </div>
    </div>

    <pre id="code-view"></pre>
  </div>

  <script>
    const SCRIPT_CODE = ${escapedJson};
    document.getElementById('code-view').textContent = SCRIPT_CODE;
    document.getElementById('copy-btn').addEventListener('click', async () => {
      await navigator.clipboard.writeText(SCRIPT_CODE);
      const toast = document.getElementById('toast');
      toast.hidden = false;
      setTimeout(() => { toast.hidden = true; }, 4000);
    });

    document.getElementById('demo-btn').addEventListener('click', () => {
      if (document.getElementById('autodl-helper-host')) {
        const btn = document.querySelector('#autodl-helper-host')?.shadowRoot?.querySelector('button.launcher');
        if (btn) btn.click();
        return;
      }
      localStorage.setItem('token', 'sandbox-demo-token');
      localStorage.setItem('user', JSON.stringify({ id: 8900, uuid: 'demo-user-8900' }));
      window.GM_getValue = (key, fallback) => JSON.parse(localStorage.getItem('sandbox-gm-' + key) || 'null') || fallback;
      window.GM_setValue = (key, value) => localStorage.setItem('sandbox-gm-' + key, JSON.stringify(value));
      window.GM_addValueChangeListener = () => {};
      window.GM_notification = ({ title, text }) => alert(title + '\\n' + text);
      window.GM_xmlhttpRequest = () => {};

      const mockRows = [
        {
          uuid: 'ac0644ba4a-ca1921d4',
          name: 'ac0644ba4a-ca1921d4 (西北B区源实例)',
          snapshot_gpu_alias_name: 'RTX 5090',
          machine_id: 'm-src-01',
          machine_alias: '012机',
          region_sign: 'westDC3',
          expand_data_disk_size: 50 * 1024 ** 3,
          status: 'shutdown',
          start_mode: 'gpu',
          req_gpu_amount: 1
        }
      ];

      const origFetch = window.fetch.bind(window);
      window.fetch = async (url, init = {}) => {
        const path = typeof url === 'string' ? url.split('?')[0] : '';
        const body = init.body ? JSON.parse(init.body) : {};
        const respond = data => new Response(JSON.stringify({ code: 'Success', data }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
        if (path === '/api/v1/instance') return respond({ list: mockRows, result_total: mockRows.length, page_size: 90 });
        if (path === '/api/v1/region/list') return respond([
          { data_center: 'westDC3', region_name: '西北B区', region_sign: 'westDC3', visible: 'all', used_for: 'all' },
          { data_center: 'beijingDC2', region_name: '北京B区', region_sign: 'beijingDC2', visible: 'all', used_for: 'all' }
        ]);
        if (path === '/api/v1/machine/gpu_type') return respond([
          { gpu_name: 'RTX 5090', chip_corp: 'nvidia', cpu_arch: 'x86' },
          { gpu_name: 'RTX PRO 6000', chip_corp: 'nvidia', cpu_arch: 'x86' },
          { gpu_name: 'RTX 4090D', chip_corp: 'nvidia', cpu_arch: 'x86' },
          { gpu_name: 'RTX 4090', chip_corp: 'nvidia', cpu_arch: 'x86' }
        ]);
        if (path === '/api/v1/machine/region/gpu_type') return respond([
          { 'RTX 5090': { idle: 0 }, 'RTX PRO 6000': { idle: 0 }, 'RTX 4090D': { idle: 0 }, 'RTX 4090': { idle: 0 } }
        ]);
        if (path === '/api/v1/instance/snapshot') return respond({
          expand_data_disk_size: 50 * 1024 ** 3,
          machine_info_snapshot: { gpu_name: 'RTX 5090', max_instance_disk_size: 50 * 1024 ** 3 },
          image: { image_type: 'public', image_name: 'base-pytorch-2.5', chip_corp: 'nvidia', cpu_arch: 'x86', cuda_version: '12.4' }
        });
        if (path === '/api/v1/user/machine/list') return respond({
          list: [
            { machine_id: 'm-661a9f20', machine_alias: '661机', gpu_name: 'RTX 5090', gpu_idle_num: 1, gpu_order_num: 8, region_sign: 'westDC3', region_name: '西北B区', on_line: 1, driver_version: '570.124', highest_cuda_version: '12.8', max_data_disk_expand_size: 2000 * 1024 ** 3, max_instance_disk_size: 50 * 1024 ** 3, mem_per_gpu: 96 * 1024 ** 3, chip_corp: 'nvidia', cpu_arch: 'x86', payg_price: 2930 },
            { machine_id: 'm-756b8e11', machine_alias: '756机', gpu_name: 'RTX 5090', gpu_idle_num: 0, gpu_order_num: 8, region_sign: 'westDC3', region_name: '西北B区', on_line: 1, driver_version: '570.124', highest_cuda_version: '12.8', max_data_disk_expand_size: 1500 * 1024 ** 3, max_instance_disk_size: 50 * 1024 ** 3, mem_per_gpu: 96 * 1024 ** 3, chip_corp: 'nvidia', cpu_arch: 'x86', payg_price: 2930 },
            { machine_id: 'm-308c4d99', machine_alias: '308机', gpu_name: 'RTX 4090', gpu_idle_num: 0, gpu_order_num: 8, region_sign: 'westDC3', region_name: '西北B区', on_line: 1, driver_version: '550.54.15', highest_cuda_version: '12.4', max_data_disk_expand_size: 1000 * 1024 ** 3, max_instance_disk_size: 50 * 1024 ** 3, mem_per_gpu: 64 * 1024 ** 3, chip_corp: 'nvidia', cpu_arch: 'x86', payg_price: 1980 }
          ],
          result_total: 3,
          page_size: 90
        });
        if (path === '/api/v1/order/price/preview') return respond({
          origin_price: 2930 * (body.num || 1),
          discount_list: [],
          data_disk_info: { data_disk_deal_daily_price: 500 }
        });
        if (path === '/api/v1/order/instance/clone/payg') {
          const newId = 'cloned-5090-demo';
          mockRows.push({
            uuid: newId,
            name: body.instance_info.instance_name,
            snapshot_gpu_alias_name: 'RTX 5090',
            machine_id: body.instance_info.machine_id,
            machine_alias: '661机',
            region_sign: 'westDC3',
            status: 'running',
            start_mode: 'gpu',
            req_gpu_amount: body.instance_info.req_gpu_amount,
            ssh_command: 'ssh -p 42199 root@connect.westc.gpuhub.com',
            root_password: 'demo-password-888',
            additional_info: { copy_data_disk_after_clone_status: 'Succeed' }
          });
          return respond(newId);
        }
        return origFetch(url, init);
      };

      const s = document.createElement('script');
      s.textContent = SCRIPT_CODE;
      document.body.appendChild(s);
      setTimeout(() => {
        const launcher = document.querySelector('#autodl-helper-host')?.shadowRoot?.querySelector('button.launcher');
        if (launcher) launcher.click();
      }, 100);
    });
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(root, 'INSTALL.html'), html, 'utf8');
console.log('Generated INSTALL.html');
