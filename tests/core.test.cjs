'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  VERSION, NAME, DEFAULT_SETTINGS,
  Api, ApiError, Engine, fresh, compareVersion,
  parseMachineIds, machineMatchesId, matchesMachine, sortMachines,
  createPayload, groupRegions, flattenImages, regionalGpuOptions,
  availableDrivers, instanceDisplay,
  cloneSourceConfig, cloneTargetConfig, clonePayload, cloneDataReady, applyCloneFilters,
  isGpuRunning, hasEnoughGpu, serverChanUrl, validateNew,
  canRemoveTask, removeTask, priceRange, matchesPrice, extractSshInfo
} = require('../autodl-helper.user.js');

const copy = x => JSON.parse(JSON.stringify(x));
const GB = 1024 ** 3;

const config = () => ({
  gpus: ['RTX 4090D', 'RTX 4090'],
  regions: [{ name: '北京', signs: ['bj'] }, { name: '西北', signs: ['west'] }],
  gpuCount: 2,
  minExpandGb: 500,
  expandGb: 100,
  driver: { mode: 'minimum', value: '550' },
  image: { type: 'base', uuid: 'base-1', chip_corp: 'nvidia', cpu_arch: 'x86', cuda: '12.1' }
});

const machine = (overrides = {}) => ({
  machine_id: 'm1',
  machine_alias: '101机',
  gpu_name: 'RTX 4090D',
  gpu_idle_num: 2,
  gpu_order_num: 8,
  region_sign: 'west',
  driver_version: '550.54.15',
  max_data_disk_expand_size: 500 * GB,
  max_instance_num: 10,
  binding_instance_num: 2,
  on_line: 1,
  chip_corp: 'nvidia',
  cpu_arch: 'x86',
  highest_cuda_version: '12.4',
  ...overrides
});

const existing = (id, uuid = id) => ({ id, name: id, kind: 'existing', instanceUuid: uuid, account: 'account', status: 'active' });
const newTask = id => ({ id, name: id, marker: `ADLH-${id}`, kind: 'new', config: config(), account: 'account', status: 'active' });

function fixture(tasks, api = {}) {
  let state = { ...fresh(), tasks: copy(tasks) }, time = 100000;
  const calls = [], defaults = {
    instances: async () => [],
    machines: async () => [machine()],
    quote: async () => ({ gpuHourlyMilli: 3960, diskDailyMilli: 2500 }),
    create: async () => 'created',
    clone: async () => 'cloned',
    snapshot: async () => sourceSnapshot(),
    regions: async () => [{ data_center: 'west', region_name: '西北', region_sign: 'west', visible: 'all', used_for: 'all' }],
    retryClone: async () => {},
    machineDetail: async () => ({ gpu_idle_num: 0, on_line: 1 }),
    powerOn: async () => {},
    powerOff: async () => {},
    init: async () => {}
  };
  const wrapped = Object.fromEntries(Object.entries({ ...defaults, ...api }).map(([name, fn]) => [name, async (...args) => {
    calls.push([name, ...copy(args)]);
    return fn(...args);
  }]));
  const read = () => copy(state), update = async fn => { const s = copy(state), value = fn(s); state = s; return value; };
  return {
    engine: new Engine({ api: wrapped, read, update, now: () => time }),
    read, update, calls,
    advance(n) { time += n; },
    restart() { return new Engine({ api: wrapped, read, update, now: () => time }); }
  };
}

const sourceRow = () => ({
  uuid: 'src',
  name: '源实例',
  machine_id: 'original',
  machine_alias: '001机',
  region_sign: 'west',
  status: 'shutdown',
  req_gpu_amount: 2,
  snapshot_gpu_alias_name: 'RTX 4090D',
  expand_data_disk_size: 100 * GB
});

const sourceSnapshot = () => ({
  expand_data_disk_size: 100 * GB,
  machine_info_snapshot: { gpu_name: 'RTX 4090D', max_instance_disk_size: 100 * GB },
  image: { image_type: 'public', image_name: 'base', chip_corp: 'nvidia', cpu_arch: 'x86', cuda_version: '12.1' }
});

const cloneTask = (overrides = {}) => ({
  id: 'clone',
  marker: 'ADLH-clone',
  name: '克隆任务',
  kind: 'clone',
  cloneMode: 'prefer_original',
  sourceUuid: 'src',
  account: 'account',
  status: 'active',
  ...overrides
});

// ─── Seam 1: 指定目标服务器 (machine_id / machine_alias 白名单、优先级、黑名单) ───

test('parseMachineIds 解析逗号、空格、换行分隔的主机标识并去重', () => {
  assert.deepEqual(parseMachineIds(' 661机, 756, m-abc \n 661机 ，007 '), ['661机', '756', 'm-abc', '007']);
  assert.deepEqual(parseMachineIds(['007机', ' 008 ', '007机']), ['007机', '008']);
  assert.deepEqual(parseMachineIds(''), []);
  assert.deepEqual(parseMachineIds(null), []);
});

test('machineMatchesId 支持精确匹配 machine_id、machine_alias 及去掉“机/machine”后缀的编号', () => {
  const m = machine({ machine_id: '9f8e7d6c5b', machine_alias: '661 machine' });
  assert.equal(machineMatchesId(m, '9f8e7d6c5b'), true);
  assert.equal(machineMatchesId(m, '661 machine'), true);
  assert.equal(machineMatchesId(m, '661机'), true);
  assert.equal(machineMatchesId(m, '661'), true);
  assert.equal(machineMatchesId(m, '662'), false);
});

test('指定主机白名单 (only 模式) 仅允许列表内主机，并严格按白名单顺序优先于 GPU 顺序排序', () => {
  const c = {
    ...config(),
    gpus: ['RTX 5090', 'RTX 4090D'],
    machineIds: ['662', 'm-first'],
    machineFilterMode: 'only'
  };
  const rows = [
    machine({ machine_id: 'other-5090', machine_alias: '999机', gpu_name: 'RTX 5090' }),
    machine({ machine_id: 'm-first', machine_alias: '101机', gpu_name: 'RTX 4090D' }),
    machine({ machine_id: 'm-second', machine_alias: '662机', gpu_name: 'RTX 5090' })
  ];
  assert.deepEqual(sortMachines(rows, c).map(m => m.machine_id), ['m-second', 'm-first']);
});

test('指定主机优先模式 (prefer 模式) 将白名单主机排在最前，其余合规主机作为备选', () => {
  const c = {
    ...config(),
    gpus: ['RTX 5090', 'RTX 4090D'],
    machineIds: ['101机'],
    machineFilterMode: 'prefer'
  };
  const rows = [
    machine({ machine_id: 'fallback-5090', machine_alias: '888机', gpu_name: 'RTX 5090' }),
    machine({ machine_id: 'preferred-4090d', machine_alias: '101机', gpu_name: 'RTX 4090D' })
  ];
  assert.deepEqual(sortMachines(rows, c).map(m => m.machine_id), ['preferred-4090d', 'fallback-5090']);
});

test('主机黑名单 (excludeMachineIds) 排除指定故障主机，即使在白名单中也拒绝', () => {
  const c = {
    ...config(),
    machineIds: ['101', '102'],
    machineFilterMode: 'only',
    excludeMachineIds: ['101机']
  };
  const rows = [
    machine({ machine_id: 'm1', machine_alias: '101机' }),
    machine({ machine_id: 'm2', machine_alias: '102机' })
  ];
  assert.deepEqual(sortMachines(rows, c).map(m => m.machine_id), ['m2']);
});

// ─── Seam 2: 克隆实例（系统盘 + 数据盘 + 稀疏文件优化 ft_sparse + 容量自动补齐） ───

test('克隆请求强制复制系统盘与数据盘，支持 ft_sparse 开关，目标盘自动补齐源盘容量', () => {
  const t = cloneTask();
  const base = cloneSourceConfig(sourceRow(), sourceSnapshot(), [
    { data_center: 'west', region_name: '西北', region_sign: 'west', visible: 'all', used_for: 'all' }
  ]);
  t.config = applyCloneFilters(base, {
    gpus: ['RTX 5090'],
    gpuCount: 1,
    driver: { mode: 'any', value: '' },
    minExpandGb: 0,
    expandGb: 0,
    ftSparse: true,
    machineIds: ['661机'],
    machineFilterMode: 'only'
  });
  const targetMachine = machine({ machine_id: 'm-661', machine_alias: '661机', gpu_name: 'RTX 5090', max_instance_disk_size: 50 * GB });
  const p = clonePayload(t, targetMachine);
  assert.equal(p.instance_uuid, 'src');
  assert.equal(p.instance_info.machine_id, 'm-661');
  assert.equal(p.instance_info.copy_data_disk_after_clone, true);
  assert.equal(p.instance_info.ft_sparse, true);
  assert.equal(p.instance_info.expand_data_disk, 150 * GB);
  assert.equal(p.price_info.expand_data_disk, 150 * GB);
  assert.equal(p.instance_info.instance_name, 'ADLH-clone');
  assert.equal(p.instance_info.keep_src_user_service_address_after_clone, false);
});

test('克隆可更换 GPU/卡数/指定主机/价格上限及 ft_sparse，但不能覆盖源地区和镜像', () => {
  const base = cloneSourceConfig(sourceRow(), sourceSnapshot(), [
    { data_center: 'west', region_name: '西北', region_sign: 'west', visible: 'all', used_for: 'all' }
  ]);
  const c = applyCloneFilters(base, {
    gpus: ['RTX 5090'],
    gpuCount: 3,
    minExpandGb: 500,
    expandGb: 20,
    driver: { mode: 'minimum', value: '570.10' },
    machineIds: ['661机', '662机'],
    machineFilterMode: 'only',
    excludeMachineIds: ['999机'],
    ftSparse: true,
    maxGpuPriceYuan: 3.2,
    regions: [{ signs: ['bj'] }],
    image: { uuid: 'wrong' }
  });
  assert.deepEqual(c.gpus, ['RTX 5090']);
  assert.equal(c.gpuCount, 3);
  assert.equal(c.expandGb, 100);
  assert.deepEqual(c.regions, base.regions);
  assert.deepEqual(c.image, base.image);
  assert.equal(c.driver.value, '570.10');
  assert.equal(c.minExpandGb, 500);
  assert.deepEqual(c.machineIds, ['661机', '662机']);
  assert.equal(c.machineFilterMode, 'only');
  assert.deepEqual(c.excludeMachineIds, ['999机']);
  assert.equal(c.ftSparse, true);
  assert.equal(c.maxGpuPriceYuan, 3.2);
});

// ─── Seam 3: 三种抢卡与克隆策略状态机 ───

test('双路模式 (prefer_original)：原实例 GPU 已运行时直接完成，不再克隆', async () => {
  const f = fixture([cloneTask()], {
    instances: async () => [{ ...sourceRow(), status: 'running', start_mode: 'gpu' }],
    machines: async () => [machine({ max_instance_disk_size: 100 * GB })]
  });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 0);
  assert.equal(f.read().tasks[0].status, 'success');
  assert.equal(f.read().tasks[0].completedVia, 'original');
});

test('双路模式 (prefer_original)：本机与克隆目标均有卡时优先原实例，并等待结果防止双开', async () => {
  let source = sourceRow();
  const f = fixture([cloneTask()], {
    instances: async () => [source],
    machineDetail: async () => ({ gpu_idle_num: 2, on_line: 1 })
  });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'machines').length, 0);
  f.advance(120000);
  await f.restart().tick();
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 1);
  source = { ...source, status: 'running', start_mode: 'gpu' };
  await f.engine.tick();
  assert.equal(f.read().tasks[0].status, 'success');
  assert.equal(f.read().tasks[0].instanceUuid, 'src');
});

test('纯克隆模式 (clone_only)：即使原主机有空闲卡也不开启原实例，直接按指定服务器克隆', async () => {
  let rows = [sourceRow()];
  const task = cloneTask({
    cloneMode: 'clone_only',
    targetFilters: {
      gpus: ['RTX 5090'],
      gpuCount: 1,
      driver: { mode: 'any', value: '' },
      minExpandGb: 0,
      expandGb: 0,
      machineIds: ['661机'],
      machineFilterMode: 'only',
      ftSparse: true
    }
  });
  const f = fixture([task], {
    instances: async () => rows,
    machineDetail: async () => ({ gpu_idle_num: 8, on_line: 1 }),
    machines: async () => [
      machine({ machine_id: 'm-other', machine_alias: '500机', gpu_name: 'RTX 5090', gpu_idle_num: 4, max_instance_disk_size: 100 * GB }),
      machine({ machine_id: 'm-661', machine_alias: '661机', gpu_name: 'RTX 5090', gpu_idle_num: 1, max_instance_disk_size: 100 * GB })
    ]
  });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 1);
  const cloneCall = f.calls.find(c => c[0] === 'clone');
  assert.equal(cloneCall[2].machine_id, 'm-661');
  assert.equal(cloneCall[1].config.ftSparse, true);
});

test('纯克隆模式 (clone_only)：目标主机无卡时保持源实例运行，目标主机有卡后才关机源实例并克隆', async () => {
  let source = { ...sourceRow(), status: 'running', start_mode: 'non_gpu' };
  let targetIdle = 0;
  const task = cloneTask({
    cloneMode: 'clone_only',
    targetFilters: {
      gpus: ['RTX 5090'],
      gpuCount: 1,
      driver: { mode: 'any', value: '' },
      minExpandGb: 0,
      expandGb: 0,
      machineIds: ['661机'],
      machineFilterMode: 'only'
    }
  });
  const f = fixture([task], {
    instances: async () => [source],
    machines: async () => targetIdle > 0
      ? [machine({ machine_id: 'm-661', machine_alias: '661机', gpu_name: 'RTX 5090', gpu_idle_num: targetIdle, max_instance_disk_size: 100 * GB })]
      : []
  });
  // 第 1 轮：目标机器无卡，源实例保持无卡运行，不关机
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 0);

  // 第 2 轮：目标机器 661机 释放 1 张卡，触发源实例关机
  targetIdle = 1;
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 0);

  // 第 3 轮：源实例已关机，立即向 661机 发起克隆
  source.status = 'shutdown';
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 1);
  assert.equal(f.calls.find(c => c[0] === 'clone')[2].machine_id, 'm-661');
});

test('无卡源实例原主机有卡时优先关机再原地开机，不查克隆库存', async () => {
  let source = { ...sourceRow(), status: 'running', start_mode: 'non_gpu' };
  const f = fixture([cloneTask()], { instances: async () => [source], machineDetail: async () => ({ gpu_idle_num: 2, on_line: 1 }) });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 1);
  source.status = 'shutdown';
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'machines').length, 0);
});

test('查克隆目标时本机刚释放卡，提交前再次优先原地开机', async () => {
  let idle = 0;
  const f = fixture([cloneTask()], {
    instances: async () => [sourceRow()],
    machineDetail: async () => ({ gpu_idle_num: idle, on_line: 1 }),
    machines: async () => { idle = 2; return [machine({ max_instance_disk_size: 100 * GB })]; }
  });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 0);
});

test('原地开机明确失败才克隆，超时不确定时不能克隆', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture([cloneTask()], {
      instances: async () => [sourceRow()],
      machineDetail: async () => ({ gpu_idle_num: 2, on_line: 1 }),
      machines: async () => [machine({ max_instance_disk_size: 100 * GB })],
      powerOn: async () => { throw new ApiError('开机失败', 'GpuUnavailable', uncertain); }
    });
    await f.engine.tick();
    assert.equal(f.calls.filter(c => c[0] === 'clone').length, uncertain ? 0 : 1);
    assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 1);
    if (uncertain) {
      f.advance(120000);
      await f.restart().tick();
      assert.equal(f.calls.filter(c => c[0] === 'clone').length, 0);
    }
  }
});

test('克隆仅选择同地区其他主机，等待数据盘完成后通知并提取 SSH 信息', async () => {
  let rows = [sourceRow()];
  const f = fixture([cloneTask()], {
    instances: async () => rows,
    machines: async () => [
      machine({ machine_id: 'original', max_instance_disk_size: 100 * GB }),
      machine({ machine_id: 'too-small', max_instance_disk_size: 50 * GB, max_data_disk_expand_size: 149 * GB }),
      machine({ machine_id: 'target', max_instance_disk_size: 50 * GB })
    ]
  });
  await f.engine.tick();
  assert.equal(f.calls.find(c => c[0] === 'clone')[2].machine_id, 'target');
  rows.push({
    uuid: 'cloned',
    name: 'ADLH-clone',
    status: 'running',
    start_mode: 'gpu',
    ssh_command: 'ssh -p 38192 root@connect.westc.gpuhub.com',
    root_password: 'secret-password',
    additional_info: { copy_data_disk_after_clone_status: 'Running' }
  });
  await f.restart().tick();
  assert.equal(f.read().tasks[0].status, 'active');
  assert.equal(f.read().events.length, 0);

  rows[1].additional_info.copy_data_disk_after_clone_status = 'Succeed';
  await f.engine.tick();
  const doneTask = f.read().tasks[0];
  assert.equal(doneTask.status, 'success');
  assert.equal(f.read().events.length, 1);
  assert.equal(doneTask.sourceUuid, 'src');
  assert.equal(doneTask.ssh.host, 'connect.westc.gpuhub.com');
  assert.equal(doneTask.ssh.port, 38192);
  assert.equal(doneTask.calls?.length ?? f.calls.filter(c => c[0] === 'clone').length, 1);
});

test('克隆结果不确定时刷新不重复下单，通过名称认领原克隆实例', async () => {
  let rows = [sourceRow()];
  const f = fixture([cloneTask()], {
    instances: async () => rows,
    machines: async () => [machine({ max_instance_disk_size: 100 * GB })],
    clone: async () => { throw new ApiError('超时', 'NetworkError', true); }
  });
  await f.engine.tick();
  f.advance(300000);
  await f.restart().tick();
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 1);
  rows.push({
    uuid: 'recovered',
    name: 'ADLH-clone',
    status: 'running',
    start_mode: 'gpu',
    additional_info: { copy_data_disk_after_clone_status: 'Succeed' }
  });
  await f.restart().tick();
  assert.equal(f.read().tasks[0].instanceUuid, 'recovered');
});

test('缺少容量或复制完成状态时不冒报克隆完成；克隆失败重试原目标', async () => {
  assert.throws(() => cloneSourceConfig(sourceRow(), { image: {} }, []));
  assert.equal(cloneDataReady({ additional_info: { copy_data_disk_after_clone_status: 'Failed' } }), false);
  assert.equal(cloneDataReady({}), false);
  const t = cloneTask({ instanceUuid: 'target' });
  const f = fixture([t], { instances: async () => [{ uuid: 'target', status: 'created_clone_failed' }] });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'retryClone').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'clone').length, 0);
});

// ─── Seam 4: 折后单卡价格预览与区间匹配 ───

test('平台预览报价取最终 GPU 折后金额，超出区间继续检查下一台候选主机', async () => {
  const t = newTask('priced');
  Object.assign(t.config, { minGpuPriceYuan: 1.8, maxGpuPriceYuan: 1.98 });
  const f = fixture([t], {
    machines: async () => [
      machine({ machine_id: 'expensive-host' }),
      machine({ machine_id: 'good-host', machine_sku_info: [{ type: 'payg', current_price: 2200 }] })
    ],
    quote: async (task, m) => ({
      gpuHourlyMilli: m.machine_id === 'expensive-host' ? 4200 : 3960,
      diskDailyMilli: 2500
    })
  });
  await f.engine.tick();
  assert.equal(f.calls.find(c => c[0] === 'create')[2].machine_id, 'good-host');
  assert.equal(f.calls.filter(c => c[0] === 'quote').length, 2);
  assert.deepEqual(f.read().tasks[0].quote, { gpuHourlyMilli: 3960, diskDailyMilli: 2500 });
});

// ─── Seam 5: SSH 信息提取与 ~/.ssh/config 生成 ───

test('extractSshInfo 从实例行解析 host/port/command 并生成 ~/.ssh/config 与 PowerShell 切流命令', () => {
  const info = extractSshInfo({
    uuid: 'inst-1',
    ssh_command: 'ssh -p 41234 root@connect.westc.gpuhub.com',
    root_password: 'my-pass-123',
    jupyter_domain: 'u123.westc.gpuhub.com',
    jupyter_token: 'tok-xyz'
  }, 'autodl');
  assert.equal(info.host, 'connect.westc.gpuhub.com');
  assert.equal(info.port, 41234);
  assert.equal(info.user, 'root');
  assert.equal(info.command, 'ssh -p 41234 root@connect.westc.gpuhub.com');
  assert.equal(info.password, 'my-pass-123');
  assert.equal(info.jupyterUrl, 'https://u123.westc.gpuhub.com/jupyter?token=tok-xyz');
  assert.match(info.sshConfig, /Host autodl\s+HostName connect\.westc\.gpuhub\.com\s+User root\s+Port 41234/);
  assert.match(info.psCommand, /connect\.westc\.gpuhub\.com/);
  assert.match(info.psCommand, /41234/);
});

// ─── 基础筛选、无卡保护、并发幂等回归验证 ───

test('无卡模式保持运行，原主机足够卡数时才关机并等待 GPU 开机成功', async () => {
  let row = { uuid: 'a', machine_id: 'original', req_gpu_amount: 2, status: 'running', start_mode: 'non_gpu' }, idle = 0;
  const f = fixture([existing('a')], {
    instances: async () => [row],
    machineDetail: async () => ({ gpu_idle_num: idle, on_line: 1 })
  });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 0);
  idle = 1;
  await f.restart().tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 0);
  idle = 2;
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOff').length, 1);
  row.status = 'shutdown';
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'powerOn').length, 1);
  row = { ...row, status: 'running', start_mode: 'gpu' };
  await f.engine.tick();
  assert.equal(f.read().tasks[0].status, 'success');
});

test('在途创建取消后不能移除，返回 UUID 仍保留且之后可以移除', async () => {
  const f = fixture([newTask('b')], {
    create: async () => {
      await f.update(s => { s.tasks[0].status = 'cancelled'; });
      assert.equal(canRemoveTask(f.read().tasks[0]), false);
      await assert.rejects(f.update(s => removeTask(s, 'b')), /暂不能移除/);
      return 'paid-instance';
    }
  });
  await f.engine.tick();
  const saved = f.read().tasks[0];
  assert.equal(saved.instanceUuid, 'paid-instance');
  assert.equal(saved.status, 'cancelled');
  assert.equal(canRemoveTask(saved), true);
  await f.update(s => removeTask(s, 'b'));
  assert.equal(f.read().tasks.length, 0);
});
