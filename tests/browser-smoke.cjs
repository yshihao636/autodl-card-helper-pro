'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const script = fs.readFileSync(path.join(__dirname, '../autodl-helper.user.js'), 'utf8');
const { VERSION, NAME, fresh } = require('../autodl-helper.user.js');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 960 } });
    const errors = [], calls = [], notifications = [];
    let rows = [
      {
        uuid: 'ac0644ba4a-ca1921d4',
        name: '我的源实例',
        snapshot_gpu_alias_name: 'RTX 4090D',
        machine_id: 'original',
        machine_alias: '001机',
        region_sign: 'west1',
        expand_data_disk_size: 50 * 1024 ** 3,
        status: 'shutdown',
        start_mode: 'gpu',
        req_gpu_amount: 1
      }
    ];
    let clonePayloads = [];
    await context.exposeFunction('recordNotification', data => notifications.push(data));
    await context.addInitScript(() => {
      localStorage.setItem('token', 'mock-token');
      localStorage.setItem('user', JSON.stringify({ id: 1 }));
      window.GM_getValue = (key, fallback) => JSON.parse(localStorage.getItem(`mock-gm-${key}`) || 'null') || fallback;
      window.GM_setValue = (key, value) => localStorage.setItem(`mock-gm-${key}`, JSON.stringify(value));
      window.GM_addValueChangeListener = (key, listener) => window.addEventListener('storage', event => {
        if (event.key === `mock-gm-${key}`) listener();
      });
      window.GM_notification = data => window.recordNotification(data);
      window.GM_xmlhttpRequest = () => { throw Error('此测试未启用 Server酱'); };
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), body = request.postDataJSON();
      if (!url.pathname.startsWith('/api/')) {
        await route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<html><head><meta charset="utf-8"><title>模拟 AutoDL</title></head><body><h1>模拟 AutoDL 控制台</h1></body></html>'
        });
        return;
      }
      calls.push([url.pathname, body]);
      let data;
      switch (url.pathname) {
        case '/api/v1/instance':
          data = { list: rows, result_total: rows.length, page_size: 90 };
          break;
        case '/api/v1/instance/power_off':
          rows.find(r => r.uuid === body.instance_uuid).status = 'shutdown';
          data = null;
          break;
        case '/api/v1/instance/power_on':
          Object.assign(rows.find(r => r.uuid === body.instance_uuid), { status: 'running', start_mode: 'gpu' });
          data = null;
          break;
        case '/api/v1/machine/detail':
          data = { gpu_idle_num: 2, on_line: 1 };
          break;
        case '/api/v1/instance/snapshot':
          data = {
            expand_data_disk_size: 50 * 1024 ** 3,
            machine_info_snapshot: { gpu_name: 'RTX 4090D', max_instance_disk_size: 50 * 1024 ** 3 },
            image: { image_type: 'public', image_name: 'base-1', chip_corp: 'nvidia', cpu_arch: 'x86', cuda_version: '12.4' }
          };
          break;
        case '/api/v1/machine/gpu_type':
          data = [
            { gpu_name: 'RTX 4090D', chip_corp: 'nvidia', cpu_arch: 'x86' },
            { gpu_name: 'RTX 5090', chip_corp: 'nvidia', cpu_arch: 'x86' }
          ];
          break;
        case '/api/v1/machine/region/gpu_type':
          data = [{ 'RTX 4090D': { idle: 0 } }, { 'RTX 5090': { idle: 1 } }];
          break;
        case '/api/v1/region/list':
          data = [
            { data_center: 'west', region_name: '西北B区', region_sign: 'west1', visible: 'all', used_for: 'all' }
          ];
          break;
        case '/api/v1/user/machine/list':
          data = {
            list: [
              {
                machine_id: 'm-500',
                machine_alias: '500机',
                gpu_name: 'RTX 5090',
                gpu_idle_num: 2,
                gpu_order_num: 8,
                region_sign: 'west1',
                region_name: '西北B区',
                on_line: 1,
                driver_version: '570.10',
                max_data_disk_expand_size: 1024 ** 4,
                chip_corp: 'nvidia',
                cpu_arch: 'x86',
                highest_cuda_version: '12.8',
                mem_per_gpu: 64 * 1024 ** 3,
                max_instance_disk_size: 50 * 1024 ** 3,
                payg_price: 2930
              },
              {
                machine_id: 'm-661',
                machine_alias: '661机',
                gpu_name: 'RTX 5090',
                gpu_idle_num: 1,
                gpu_order_num: 8,
                region_sign: 'west1',
                region_name: '西北B区',
                on_line: 1,
                driver_version: '570.10',
                max_data_disk_expand_size: 1024 ** 4,
                chip_corp: 'nvidia',
                cpu_arch: 'x86',
                highest_cuda_version: '12.8',
                mem_per_gpu: 64 * 1024 ** 3,
                max_instance_disk_size: 50 * 1024 ** 3,
                payg_price: 2930
              }
            ],
            result_total: 2,
            page_size: 90
          };
          break;
        case '/api/v1/order/price/preview':
          data = {
            origin_price: 2930 * body.num,
            discount_list: [],
            data_disk_info: { data_disk_deal_daily_price: 500 }
          };
          break;
        case '/api/v1/order/instance/clone/payg':
          clonePayloads.push(body);
          data = 'cloned-5090-1';
          rows.push({
            uuid: data,
            name: body.instance_info.instance_name,
            status: 'running',
            start_mode: 'gpu',
            ssh_command: 'ssh -p 42199 root@connect.westc.gpuhub.com',
            root_password: 'mock-root-password',
            additional_info: { copy_data_disk_after_clone_status: 'Running' }
          });
          break;
        default:
          throw Error(`未预期请求：${url.pathname}`);
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 'Success', data }) });
    });

    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.install();
    await page.goto('https://www.autodl.com/console/instance/list');
    const state = fresh();
    state.settings.sound = false;
    await page.evaluate(s => localStorage.setItem('mock-gm-autodl-helper-v1', JSON.stringify(s)), state);
    await page.addScriptTag({ content: script });

    const host = page.locator('#autodl-helper-host');
    await host.locator('button.launcher').click();
    await host.getByText(`${NAME} v${VERSION}`, { exact: true }).waitFor();

    // 进入抢开机/克隆面板
    await host.getByRole('button', { name: '抢开机', exact: true }).click();
    await page.clock.runFor(300);
    await host.getByLabel(/我的源实例/).check();
    await host.getByLabel('开机方式', { exact: true }).selectOption('clone_only');
    await page.clock.runFor(300);

    const cloneEditor = host.locator('.clone-filter-editor');
    await cloneEditor.getByRole('button', { name: 'RTX 5090', exact: true }).click();
    await page.clock.runFor(300);

    // 验证主机列表表格渲染并点击 661机 的 [+指定]
    await cloneEditor.locator('.host-table').waitFor();
    const row661 = cloneEditor.locator('.host-table tr', { hasText: '661机' });
    await row661.getByRole('button', { name: '+指定' }).click();
    assert.equal(await cloneEditor.getByLabel('克隆指定目标服务器（主机ID / 编号）', { exact: true }).inputValue(), '661机');

    // 开启稀疏文件拷贝优化并设置单卡最高价
    await cloneEditor.getByLabel('优化稀疏文件拷贝 (ft_sparse)').check();
    await cloneEditor.getByLabel('克隆折后单卡最高价（元/小时，0 不限制）', { exact: true }).fill('3.5');

    await host.getByRole('button', { name: '启动所选实例抢卡' }).click();
    const advance = async n => { await page.clock.fastForward(n); await page.waitForTimeout(100); };
    await advance(11000);

    // 验证直接向指定的 661机 (m-661) 发起克隆，且包含系统盘+数据盘和稀疏拷贝
    assert.equal(clonePayloads.length, 1);
    assert.equal(clonePayloads[0].instance_uuid, 'ac0644ba4a-ca1921d4');
    assert.equal(clonePayloads[0].instance_info.machine_id, 'm-661');
    assert.equal(clonePayloads[0].instance_info.copy_data_disk_after_clone, true);
    assert.equal(clonePayloads[0].instance_info.ft_sparse, true);
    assert.equal(clonePayloads[0].instance_info.expand_data_disk, 50 * 1024 ** 3);

    // 数据盘复制完成前不报成功
    await advance(11000);
    assert.equal(notifications.length, 0);

    // 数据盘复制完成后任务成功，并且展示 SSH 终端切流面板
    rows.find(r => r.uuid === 'cloned-5090-1').additional_info.copy_data_disk_after_clone_status = 'Succeed';
    await advance(11000);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mock-gm-autodl-helper-v1')).tasks[0]?.status === 'success');
    assert.equal(notifications.length, 1);
    await host.locator('.ssh-box').waitFor();
    assert.match(await host.locator('.ssh-box').innerText(), /ssh -p 42199 root@connect\.westc\.gpuhub\.com/);
    assert.deepEqual(errors, []);
    console.log('PASS: 浏览器克隆选机表格、指定主机 661机、系统盘+数据盘克隆、ft_sparse 稀疏优化、价格校验及 SSH 切流面板验证通过');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
