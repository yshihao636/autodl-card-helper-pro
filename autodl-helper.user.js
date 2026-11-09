// ==UserScript==
// @name         AutoDL 抢卡与克隆助手 Pro
// @namespace    autodl-card-helper
// @version      1.1.0
// @homepageURL  https://github.com/yshihao636/autodl-card-helper-pro
// @supportURL   https://github.com/yshihao636/autodl-card-helper-pro/issues
// @updateURL    https://raw.githubusercontent.com/yshihao636/autodl-card-helper-pro/main/autodl-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/yshihao636/autodl-card-helper-pro/main/autodl-helper.user.js
// @description  AutoDL 普通容器实例自动抢卡与克隆：支持克隆系统盘+数据盘、指定目标服务器(machine_id)、稀疏文件优化、折后价格过滤及 SSH 一键切流
// @match        https://www.autodl.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      sctapi.ftqq.com
// @connect      *.push.ft07.com
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.1.0';
  const NAME = 'AutoDL 抢卡助手 Pro';
  const KEY = 'autodl-helper-v1';
  const GiB = 1024 ** 3;
  const MIN_INTERVAL_SECONDS = 1;
  const DEFAULT_SETTINGS = {
    intervalSeconds: 10,
    sound: true,
    desktop: true,
    serverChan: false,
    sendKey: '',
    sshAlias: 'autodl'
  };

  const active = t => t?.status === 'active';
  const awaitingReconciliation = t => t?.status === 'cancelled' && !!t.intent;
  const monitored = t => active(t) || awaitingReconciliation(t);
  const uid = () => globalThis.crypto.randomUUID();
  const fresh = () => ({
    version: 1,
    nextCycleAt: 0,
    settings: { ...DEFAULT_SETTINGS },
    tasks: [],
    events: [],
    logs: []
  });
  const clone = x => JSON.parse(JSON.stringify(x));
  const rejectedCodes = new Set([
    'AuthorizeFailed',
    'AccountChanged',
    'TORecharge',
    'TORealName',
    'MachineGpuNumUpdateFailed',
    'GpuUnavailable'
  ]);
  const shutdownStates = new Set([
    'shutdown',
    'shutdown_by_starting_error',
    'shutdown_by_running_error'
  ]);

  const canRemoveTask = t => !!t && !active(t) && !t.intent;
  function appendLog(state, at, text) {
    state.logs.unshift({ at, text });
    state.logs = state.logs.slice(0, 100);
  }
  function removeTask(state, id) {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    if (!canRemoveTask(task)) throw new Error('任务仍在运行或创建结果待核对，暂不能移除记录');
    state.tasks = state.tasks.filter(t => t.id !== id);
    state.events = state.events.filter(e => e.id !== id);
  }

  // ─── 版本与主机标识解析 ───

  function compareVersion(a, b) {
    const parts = v => /^\d+(?:\.\d+)*$/.test(String(v).trim()) ? String(v).trim().split('.').map(Number) : null;
    const x = parts(a), y = parts(b);
    if (!x || !y) return null;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return Math.sign(d);
    }
    return 0;
  }

  function parseMachineIds(input) {
    if (!input) return [];
    const rawList = Array.isArray(input) ? input : [String(input)];
    const out = [];
    const seen = new Set();
    for (const item of rawList) {
      for (const part of String(item ?? '').split(/[,，;；\s\n]+/)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const normKey = trimmed.toLowerCase();
        if (!seen.has(normKey)) {
          seen.add(normKey);
          out.push(trimmed);
        }
      }
    }
    return out;
  }

  function normalizeMachineToken(value) {
    return String(value ?? '').trim().replace(/\s*(?:机|machine)$/i, '').trim().toLowerCase();
  }

  function machineMatchesId(m, token) {
    if (!m || !token) return false;
    const raw = String(token).trim().toLowerCase();
    if (!raw) return false;
    const id = String(m.machine_id ?? '').trim().toLowerCase();
    const alias = String(m.machine_alias ?? '').trim().toLowerCase();
    if (id === raw || alias === raw) return true;
    const norm = normalizeMachineToken(raw);
    if (!norm) return false;
    return (Boolean(id) && normalizeMachineToken(id) === norm) ||
      (Boolean(alias) && normalizeMachineToken(alias) === norm);
  }

  // ─── 平台数据转换与主机筛选 ───

  function groupRegions(rows) {
    const groups = new Map();
    for (const r of rows) {
      if (r.visible !== 'all' || r.used_for !== 'all') continue;
      const key = r.data_center || r.region_name;
      if (!groups.has(key)) groups.set(key, { id: key, name: r.region_name, signs: [] });
      groups.get(key).signs.push(r.region_sign);
    }
    return [...groups.values()];
  }

  function flattenImages(nodes, path = [], out = []) {
    for (const node of nodes) {
      const label = node.label_name;
      if (node.children) flattenImages(node.children, [...path, String(label)], out);
      else if (label && typeof label === 'object' && label.uuid) out.push({
        type: 'base',
        uuid: label.uuid,
        name: [...path, label.v].join(' / '),
        chip_corp: label.chip_corp,
        cpu_arch: label.cpu_arch,
        cuda: label.v
      });
    }
    return out;
  }

  function regionalGpuOptions(rows, catalog) {
    if (!Array.isArray(rows) || !Array.isArray(catalog)) throw new Error('地区 GPU 列表结构发生变化');
    const names = new Set(rows.flatMap(row => Object.keys(row)));
    return catalog.filter(g => names.has(g.gpu_name) && g.chip_corp !== 'cpu')
      .map(g => ({ ...g, id: g.gpu_name, name: g.gpu_name }));
  }

  function availableDrivers(rows) {
    return [...new Set(rows.map(r => String(r.driver_version || '').trim()).filter(v => compareVersion(v, '0') !== null))]
      .sort((a, b) => compareVersion(b, a));
  }

  function instanceDisplay(row) {
    return {
      gpu: row.snapshot_gpu_alias_name || row.gpu_name || '型号未知',
      status: row.status,
      tone: row.status === 'running' ? 'running' : shutdownStates.has(row.status) ? 'shutdown' : 'pending',
      mode: row.start_mode === 'non_gpu' ? '无卡模式' : '',
      count: row.req_gpu_amount || '?',
      hostLabel: row.machine_alias || row.machine_id || ''
    };
  }

  function priceRange(c) {
    return { min: c?.minGpuPriceYuan ?? c?.exactGpuPriceYuan ?? 0, max: c?.maxGpuPriceYuan ?? c?.exactGpuPriceYuan ?? 0 };
  }

  function hasPriceFilter(c) {
    const { min, max } = priceRange(c);
    return min > 0 || max > 0;
  }

  function matchesPrice(quote, c) {
    const { min, max } = priceRange(c);
    return (!min || quote.gpuHourlyMilli >= Math.round(min * 1000) * c.gpuCount) &&
      (!max || quote.gpuHourlyMilli <= Math.round(max * 1000) * c.gpuCount);
  }

  const yuan = milli => Number((milli / 1000).toFixed(4));

  function matchesMachine(m, c) {
    const excludeIds = parseMachineIds(c.excludeMachineIds);
    if (excludeIds.some(tok => machineMatchesId(m, tok))) return false;

    const targetIds = parseMachineIds(c.machineIds);
    const filterMode = c.machineFilterMode || (targetIds.length ? 'only' : 'any');
    if (targetIds.length && filterMode === 'only' && !targetIds.some(tok => machineMatchesId(m, tok))) {
      return false;
    }

    if (!c.gpus.includes(m.gpu_name) || !(Number(m.gpu_idle_num) >= c.gpuCount)) return false;
    if (c.minCpuCores > 0 && !(Number(m.cpu_per_gpu) * c.gpuCount >= c.minCpuCores)) return false;
    if (c.minCpuPerGpu > 0 && !(Number(m.cpu_per_gpu) >= c.minCpuPerGpu)) return false;
    const minMemoryGb = c.minMemoryGb || 0;
    if (minMemoryGb > 0) {
      const perGpuBytes = Number(m.mem_per_gpu);
      if (!Number.isFinite(perGpuBytes) || perGpuBytes <= 0 || perGpuBytes * c.gpuCount < minMemoryGb * GiB) return false;
    }
    if ([3, 4, 5, 6].includes(Number(m.on_line))) return false;
    if (m.max_instance_num != null && Number(m.max_instance_num) <= Number(m.binding_instance_num)) return false;
    if (!c.regions.some(r => r.signs.includes(m.region_sign))) return false;
    const expandGb = Math.max(c.minExpandGb || 0, c.expandGb || 0);
    if (expandGb > 0) {
      const capacity = Number(m.max_data_disk_expand_size);
      if (!Number.isFinite(capacity) || capacity < expandGb * GiB) return false;
    }
    if (c.driver.mode === 'minimum') {
      const d = compareVersion(m.driver_version, c.driver.value);
      if (d === null || d < 0) return false;
    }
    if (c.driver.mode === 'exact' && !c.driver.value.split(/[,，\s]+/).some(v => compareVersion(m.driver_version, v) === 0)) return false;
    if (c.image.chip_corp && c.image.chip_corp !== m.chip_corp) return false;
    if (c.image.cpu_arch && c.image.cpu_arch !== m.cpu_arch) return false;
    if (m.chip_corp === 'nvidia' && c.image.cuda && m.highest_cuda_version) {
      const d = compareVersion(m.highest_cuda_version, c.image.cuda);
      if (d !== null && d < 0) return false;
    }
    return true;
  }

  function sortMachines(rows, c) {
    const targetIds = parseMachineIds(c.machineIds);
    const machineOrder = m => {
      if (!targetIds.length) return 0;
      const idx = targetIds.findIndex(tok => machineMatchesId(m, tok));
      return idx >= 0 ? idx : targetIds.length + 1;
    };
    const rank = m => [
      machineOrder(m),
      c.gpus.indexOf(m.gpu_name),
      c.regions.findIndex(r => r.signs.includes(m.region_sign))
    ];
    return rows.filter(m => matchesMachine(m, c)).sort((a, b) => {
      const x = rank(a), y = rank(b);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || String(a.machine_id).localeCompare(String(b.machine_id));
    });
  }

  // ─── 创建、克隆与 SSH 切流 ───

  function createPayload(task, machine) {
    const c = task.config, disk = c.expandGb * GiB;
    return {
      instance_info: {
        machine_id: machine.machine_id,
        charge_type: 'payg',
        req_gpu_amount: c.gpuCount,
        base_image_uuid: c.image.type === 'base' ? c.image.uuid : '',
        private_image_uuid: c.image.type === 'private' ? c.image.uuid : '',
        reproduction_uuid: '',
        reproduction_id: 0,
        cg_application_uuid: '',
        cg_application_info: { image_name: '', current_version_id: 0, current_version: '', image_id: 0 },
        instance_name: task.marker,
        expand_data_disk: disk
      },
      price_info: {
        coupon_id_list: [],
        machine_id: machine.machine_id,
        charge_type: 'payg',
        duration: 1,
        num: c.gpuCount,
        expand_data_disk: disk
      }
    };
  }

  function isGpuRunning(row) {
    return row.status === 'running' && row.start_mode === 'gpu';
  }

  function hasEnoughGpu(machine, required) {
    const count = Number(required), idle = Number(machine?.gpu_idle_num);
    return Number.isInteger(count) && count > 0 && Number.isFinite(idle) && idle >= count &&
      ![3, 4, 5, 6].includes(Number(machine?.on_line));
  }

  function cloneSourceConfig(source, snapshot, regions) {
    const machine = snapshot.machine_info_snapshot, image = snapshot.image;
    const region = groupRegions(regions).find(r => r.signs.includes(source.region_sign));
    const gpu = machine?.gpu_name || source.snapshot_gpu_alias_name;
    const extra = Number(snapshot.expand_data_disk_size ?? source.expand_data_disk_size);
    const base = Number(machine?.max_instance_disk_size);
    if (!region || !gpu || !image || !Number.isInteger(source.req_gpu_amount) || source.req_gpu_amount < 1 ||
      !Number.isFinite(extra) || extra < 0 || !Number.isFinite(base) || base <= 0) {
      throw new Error('无法确认源实例的地区、显卡或数据盘容量，保留任务等待核对');
    }
    return {
      gpus: [gpu],
      gpuCount: source.req_gpu_amount,
      regions: [region],
      driver: { mode: 'any', value: '' },
      minExpandGb: 0,
      expandGb: Math.ceil(extra / GiB),
      sourceDataBytes: base + extra,
      ftSparse: false,
      machineIds: [],
      machineFilterMode: 'any',
      excludeMachineIds: [],
      image: {
        type: source.private_image_uuid ? 'private' : 'base',
        uuid: source.private_image_uuid || image.image_name || '',
        name: '源实例系统盘',
        chip_corp: image.chip_corp,
        cpu_arch: image.cpu_arch,
        cuda: image.cuda_version
      },
      cloneImage: {
        base_image_uuid: image.image_type === 'public' ? image.image_name : '',
        private_image_uuid: source.private_image_uuid || '',
        reproduction_uuid: source.reproduction_uuid || '',
        reproduction_id: Number(source.reproduction_id) || 0,
        cg_application_uuid: snapshot.cg_application_uuid || '',
        cg_application_info: snapshot.cg_application_info || {}
      }
    };
  }

  function cloneTargetConfig(c, machine) {
    const base = Number(machine.max_instance_disk_size);
    if (!Number.isFinite(base) || base <= 0) return null;
    const expandGb = Math.max(c.expandGb, Math.ceil(Math.max(0, c.sourceDataBytes - base) / GiB));
    return { ...c, expandGb };
  }

  function applyCloneFilters(sourceConfig, filters) {
    if (!filters) return sourceConfig;
    const machineIds = parseMachineIds(filters.machineIds);
    const excludeMachineIds = parseMachineIds(filters.excludeMachineIds);
    const c = {
      ...sourceConfig,
      gpus: [...filters.gpus],
      gpuCount: filters.gpuCount,
      driver: { ...filters.driver },
      minExpandGb: filters.minExpandGb ?? 0,
      minMemoryGb: filters.minMemoryGb || 0,
      minCpuCores: filters.minCpuCores || 0,
      minCpuPerGpu: filters.minCpuPerGpu || 0,
      minGpuPriceYuan: filters.minGpuPriceYuan || 0,
      maxGpuPriceYuan: filters.maxGpuPriceYuan || 0,
      machineIds,
      machineFilterMode: filters.machineFilterMode || (machineIds.length ? 'only' : 'any'),
      excludeMachineIds,
      ftSparse: Boolean(filters.ftSparse),
      expandGb: Math.max(sourceConfig.expandGb, filters.expandGb || 0)
    };
    validateNew({ ...c, image: { uuid: 'source-instance' } });
    return c;
  }

  function clonePayload(task, machine) {
    const c = cloneTargetConfig(task.config, machine);
    if (!c) throw new Error('目标主机的数据盘容量未知');
    const payload = createPayload({ ...task, config: c }, machine);
    payload.instance_uuid = task.sourceUuid;
    Object.assign(payload.instance_info, c.cloneImage, {
      copy_data_disk_after_clone: true,
      keep_src_user_service_address_after_clone: false,
      ft_sparse: Boolean(c.ftSparse)
    });
    return payload;
  }

  function cloneDataReady(row) {
    return ['Succeed', 'Success'].includes(row.additional_info?.copy_data_disk_after_clone_status);
  }

  function extractSshInfo(row, alias = 'autodl') {
    if (!row) return null;
    const cmd = String(row.ssh_command || '').trim();
    const portMatch = cmd.match(/-p\s+(\d+)/);
    const hostMatch = cmd.match(/([^\s@]+)@([^\s]+)/);
    const user = hostMatch ? hostMatch[1] : 'root';
    const host = hostMatch ? hostMatch[2] : String(row.proxy_host || '').trim();
    const port = portMatch ? Number(portMatch[1]) : (Number(row.ssh_port) || 0);
    const command = cmd || (host && port ? `ssh -p ${port} ${user}@${host}` : '');
    const password = String(row.root_password || '');
    const jupyterUrl = row.jupyter_domain
      ? `https://${row.jupyter_domain}/jupyter${row.jupyter_token ? `?token=${row.jupyter_token}` : ''}`
      : '';
    const safeAlias = String(alias || 'autodl').trim() || 'autodl';
    const sshConfig = host && port
      ? `Host ${safeAlias}\n    HostName ${host}\n    User ${user}\n    Port ${port}`
      : '';
    const psCommand = host && port
      ? `powershell -NoProfile -Command "$p=Join-Path $HOME '.ssh/config'; New-Item -ItemType Directory -Force (Split-Path $p)|Out-Null; $c=if(Test-Path $p){Get-Content $p -Raw}else{''}; $b=\\"Host ${safeAlias}\`r\`n    HostName ${host}\`r\`n    User ${user}\`r\`n    Port ${port}\\"; if($c -match '(?ms)^Host\\s+${safeAlias}\\b.*?(?=^Host\\s+|\\z)'){$c=[regex]::Replace($c,'(?ms)^Host\\s+${safeAlias}\\b.*?(?=^Host\\s+|\\z)',$b+\\"\`r\`n\\")}else{$c=($c.TrimEnd()+\\"\`r\`n\`r\`n\\"+$b+\\"\`r\`n\\").TrimStart()}; Set-Content $p $c -Encoding UTF8; Write-Host 'Updated Host ${safeAlias} -> ${host}:${port}'"`
      : '';
    return { host, port, user, command, password, jupyterUrl, sshConfig, psCommand };
  }

  // ─── API 客户端 ───

  class ApiError extends Error {
    constructor(message, code = 'NetworkError', uncertain = false) {
      super(message);
      this.code = code;
      this.uncertain = uncertain;
    }
  }

  class Api {
    constructor(session, fetcher = (...args) => globalThis.fetch(...args)) {
      this.session = session;
      this.fetcher = fetcher;
    }
    async call(path, body, account) {
      const session = this.session();
      if (!session.token || !session.account) throw new ApiError('请登录 AutoDL，任务会在登录后继续', 'AuthorizeFailed');
      if (account && account !== session.account) throw new ApiError('当前账号与任务所属账号不同，等待切回原账号', 'AccountChanged');
      if (session.subUser) path = path.replace('/api/v1/', '/api/v1/sub_user/');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await this.fetcher(path, {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'include',
          headers: {
            Authorization: session.token,
            AppVersion: session.appVersion,
            'Content-Type': 'application/json'
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal
        });
        if (!res.ok) throw new ApiError(`接口 HTTP ${res.status}`, `HTTP${res.status}`, ![401, 403].includes(res.status));
        let json;
        try {
          json = await res.json();
        } catch {
          throw new ApiError('接口返回了无法解析的内容', 'InvalidResponse', true);
        }
        if (json.code !== 'Success') {
          throw new ApiError(
            String(json.msg || json.code || '接口返回异常').slice(0, 240),
            json.code || 'InvalidResponse',
            !json.code || !rejectedCodes.has(json.code)
          );
        }
        return json.data;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('网络中断或请求超时，等待下一轮核对', 'NetworkError', true);
      } finally {
        clearTimeout(timer);
      }
    }
    async pages(path, body, account) {
      let page = 1;
      const result = [];
      while (true) {
        const data = await this.call(path, { ...body, page_index: page, page_size: 90 }, account);
        if (!data || !Array.isArray(data.list)) throw new ApiError('列表接口结构发生变化，等待适配', 'SchemaChanged');
        result.push(...data.list);
        const size = Number(data.page_size) || 90;
        if (data.list.length === 0 || (data.result_total != null ? result.length >= Number(data.result_total) : data.list.length < size)) {
          return result;
        }
        page++;
        if (page > 1000) throw new ApiError('列表分页异常，任务保留', 'SchemaChanged');
      }
    }
    instances(account) {
      return this.pages('/api/v1/instance', { status: [], charge_type: [], name: '', sub_name: '' }, account);
    }
    machines(c, account, includeBusy = false) {
      return this.pages('/api/v1/user/machine/list', {
        charge_type: 'payg',
        gpu_type_name: c.gpus,
        gpu_idle_num: includeBusy ? 0 : c.gpuCount,
        region_sign_list: c.regions.flatMap(r => r.signs),
        default_order: true,
        machine_tag_name: [],
        mount_net_disk: false,
        cpu_arch: [],
        chip_corp: [],
        instance_disk_size_order: '',
        date_range: '',
        date_from: '',
        date_to: '',
        pay_price_order: '',
        gpu_idle_type: ''
      }, account);
    }
    powerOn(uuid, account) {
      return this.call('/api/v1/instance/power_on', { instance_uuid: uuid }, account);
    }
    powerOff(uuid, account) {
      return this.call('/api/v1/instance/power_off', { instance_uuid: uuid }, account);
    }
    machineDetail(machineId, account) {
      return this.call('/api/v1/machine/detail', { machine_id: machineId }, account);
    }
    async quote(task, machine) {
      const payload = task.kind === 'clone' ? clonePayload(task, machine) : createPayload(task, machine);
      const data = await this.call('/api/v1/order/price/preview', payload.price_info, task.account);
      const instance = (data.discount_list || []).filter(d => d.product_type === 'instance').at(-1);
      const gpuHourlyMilli = instance ? instance.origin_price - instance.total_reduction : data.origin_price;
      if (!(gpuHourlyMilli >= 0)) throw new ApiError('未读到有效折后报价', 'InvalidPrice');
      return { gpuHourlyMilli, diskDailyMilli: data.data_disk_info?.data_disk_deal_daily_price || 0 };
    }
    create(task, m) {
      return this.call('/api/v1/order/instance/create/payg', createPayload(task, m), task.account);
    }
    clone(task, m) {
      return this.call('/api/v1/order/instance/clone/payg', clonePayload(task, m), task.account);
    }
    snapshot(uuid, account) {
      return this.call(`/api/v1/instance/snapshot?instance_uuid=${encodeURIComponent(uuid)}`, undefined, account);
    }
    regions(account) {
      return this.call('/api/v1/region/list', undefined, account);
    }
    retryClone(uuid, account) {
      return this.call('/api/v1/instance/clone/retry', { instance_uuid: uuid }, account);
    }
    init(uuid, account) {
      return this.call('/api/v1/instance/init', { instance_uuid: uuid }, account);
    }
  }

  // ─── 任务状态机引擎 ───

  class Engine {
    constructor({ api, read, update, now = Date.now }) {
      Object.assign(this, { api, read, update, now });
    }
    async patch(id, fn) {
      return this.update(s => {
        const task = s.tasks.find(t => t.id === id);
        if (task && active(task)) return fn(task, s);
      });
    }
    async message(id, text) {
      await this.patch(id, t => { t.message = text; });
    }
    async success(id, instance, completedVia) {
      await this.patch(id, (t, s) => {
        t.status = 'success';
        t.instanceUuid = instance.uuid;
        t.message = 'GPU 开机成功';
        t.completedAt = this.now();
        if (completedVia) t.completedVia = completedVia;
        const ssh = extractSshInfo(instance, s.settings?.sshAlias || 'autodl');
        if (ssh) t.ssh = { host: ssh.host, port: ssh.port, user: ssh.user, command: ssh.command, jupyterUrl: ssh.jupyterUrl, sshConfig: ssh.sshConfig, psCommand: ssh.psCommand };
        s.events.push({
          id: t.id,
          taskName: t.name,
          instanceUuid: instance.uuid,
          sshCommand: ssh?.command || '',
          createdAt: this.now(),
          desktop: false,
          sound: false,
          server: false,
          serverAttempts: 0,
          nextAt: 0
        });
        appendLog(s, this.now(), `${t.name}：GPU 开机成功 (${instance.uuid})`);
      });
    }
    async reconcileCancelled(id, rows) {
      await this.update(s => {
        const task = s.tasks.find(t => t.id === id);
        if (!awaitingReconciliation(task)) return;
        const found = rows.filter(row => row.name === task.marker);
        if (found.length === 1) {
          task.instanceUuid = found[0].uuid;
          task.intent = null;
        }
        task.message = found.length === 1
          ? '已取消；已找到创建实例，请核对控制台计费'
          : `已取消；创建结果仍待核对：${task.marker}`;
      });
    }
    async recordCreation(id, result) {
      const uuid = typeof result === 'string' ? result : result?.instance_uuid || result?.uuid;
      await this.update(s => {
        const task = s.tasks.find(t => t.id === id);
        if (!task) return;
        if (uuid) {
          task.instanceUuid = uuid;
          task.intent = null;
        }
        task.message = active(task)
          ? (uuid ? '创建已受理，等待 GPU 运行' : '创建已受理，正在核对实例列表')
          : '已取消；创建请求已发送，请核对控制台';
      });
    }
    async handleError(id, error) {
      await this.patch(id, (t, s) => {
        t.errors = (t.errors || 0) + 1;
        t.nextAt = this.now() + Math.min(300_000, s.settings.intervalSeconds * 1000 * 2 ** Math.min(t.errors - 1, 5));
        const text = error.message || '发生异常，稍后重试';
        if (t.message !== text) appendLog(s, this.now(), `${t.name}：${text}`);
        t.message = text;
      });
    }
    async preferOriginal(task, source) {
      if (isGpuRunning(source)) {
        await this.success(task.id, source, 'original');
        return true;
      }
      if (task.sourceStartIntent) {
        if (source.status === 'starting') {
          await this.patch(task.id, t => { t.sourceStartIntent.observedStarting = true; });
        } else if (task.sourceStartIntent.observedStarting && shutdownStates.has(source.status)) {
          await this.patch(task.id, (t, s) => {
            t.sourceStartIntent = null;
            t.sourceRetryAfter = this.now() + s.settings.intervalSeconds * 1000;
          });
          return false;
        }
        await this.message(task.id, '原实例开机请求待确认，优先等待其结果，暂不克隆');
        return true;
      }
      if (!(source.status === 'running' && source.start_mode === 'non_gpu') && !shutdownStates.has(source.status)) {
        await this.message(task.id, '优先等待原实例状态变化，暂不克隆');
        return true;
      }
      if ((task.sourceRetryAfter || 0) > this.now()) return false;
      if (!source.machine_id || !Number.isInteger(Number(source.req_gpu_amount)) || Number(source.req_gpu_amount) < 1) {
        await this.message(task.id, '等待确认原实例主机和卡数，暂不克隆');
        return true;
      }
      if (typeof this.api.machineDetail !== 'function') return false;
      const machine = await this.api.machineDetail(source.machine_id, task.account);
      if (!hasEnoughGpu(machine, source.req_gpu_amount)) return false;
      if (source.status === 'running') {
        if (task.lastAction?.type === 'off' && this.now() - task.lastAction.at < 60_000) {
          await this.message(task.id, '原主机有卡，等待无卡实例关机后优先开机');
          return true;
        }
        if (!await this.patch(task.id, t => { t.lastAction = { type: 'off', at: this.now() }; return true; })) return true;
        await this.api.powerOff(source.uuid, task.account);
        await this.message(task.id, '原主机有卡，已请求关机，接下来优先开启原实例');
        return true;
      }
      if (!await this.patch(task.id, t => { t.sourceStartIntent = { at: this.now(), observedStarting: false }; return true; })) return true;
      try {
        await this.api.powerOn(source.uuid, task.account);
        await this.message(task.id, '优先开启原实例，等待 GPU 运行；暂不克隆');
        return true;
      } catch (error) {
        if (error.uncertain) throw error;
        await this.patch(task.id, (t, s) => {
          t.sourceStartIntent = null;
          t.sourceRetryAfter = this.now() + s.settings.intervalSeconds * 1000;
        });
        if (['AuthorizeFailed', 'AccountChanged'].includes(error.code)) throw error;
        return false;
      }
    }
    async selectPricedCandidate(id, t, machines) {
      if (typeof this.api.quote !== 'function') {
        return { machine: machines[0], quote: null };
      }
      let machine = null, quote = null;
      for (const candidate of machines) {
        if (!active(this.read().tasks.find(x => x.id === id))) return { cancelled: true };
        const candidateQuote = await this.api.quote(t, candidate);
        if (matchesPrice(candidateQuote, t.config)) {
          machine = candidate;
          quote = candidateQuote;
          break;
        }
      }
      return { machine, quote };
    }
    async step(id) {
      let t = this.read().tasks.find(x => x.id === id);
      if (!monitored(t) || (t.nextAt || 0) > this.now()) return;
      try {
        const rows = await this.api.instances(t.account);
        t = this.read().tasks.find(x => x.id === id);
        if (awaitingReconciliation(t)) {
          await this.reconcileCancelled(id, rows);
          return;
        }
        if (!t || !active(t)) return;
        if (['new', 'clone'].includes(t.kind) && !t.instanceUuid) {
          const found = rows.filter(r => r.name === t.marker);
          if (found.length > 1) {
            await this.message(id, '发现多个同名创建结果，请在控制台核对；任务保留');
            return;
          }
          if (found.length === 1) {
            await this.patch(id, task => { task.instanceUuid = found[0].uuid; task.intent = null; });
            t = this.read().tasks.find(x => x.id === id);
            if (!active(t)) return;
          } else if (t.intent) {
            await this.message(id, `创建结果待核对，持续查找实例 ${t.marker}，不会重复下单`);
            return;
          } else {
            let source;
            const cloneOnly = t.kind === 'clone' && t.cloneMode === 'clone_only';
            if (t.kind === 'clone') {
              source = rows.find(r => r.uuid === t.sourceUuid);
              if (!source) {
                await this.message(id, '等待源实例出现，未创建新实例');
                return;
              }
              if (!cloneOnly && await this.preferOriginal(t, source)) return;
              if (source.status !== 'running' && !shutdownStates.has(source.status)) {
                await this.message(id, '等待源实例状态变化，准备克隆');
                return;
              }
              const config = applyCloneFilters(
                cloneSourceConfig(source, await this.api.snapshot(source.uuid, t.account), await this.api.regions(t.account)),
                t.targetFilters
              );
              if (!await this.patch(id, task => { task.config = config; return true; })) return;
              t = this.read().tasks.find(x => x.id === id);
              if (!active(t)) return;
            }
            const inventory = await this.api.machines(t.config, t.account);
            const machines = t.kind === 'clone'
              ? sortMachines(inventory.filter(m => {
                  const c = cloneTargetConfig(t.config, m);
                  return c && m.machine_id !== source?.machine_id && matchesMachine(m, c);
                }), t.config)
              : sortMachines(inventory, t.config);
            if (!machines.length) {
              await this.message(id, source?.status === 'running' ? '保持源实例运行，等待符合筛选的空闲 GPU 后再关机克隆' : '等待符合条件的空闲 GPU');
              return;
            }
            if (source && !cloneOnly) {
              const latest = this.read().tasks.find(task => task.id === id);
              if (!active(latest) || await this.preferOriginal(latest, source)) return;
            }
            if (source && !shutdownStates.has(source.status)) {
              if (hasPriceFilter(t.config)) {
                const check = await this.selectPricedCandidate(id, t, machines);
                if (check.cancelled) return;
                if (!check.machine) {
                  await this.message(id, '等待折后单卡价格符合区间的空闲 GPU');
                  return;
                }
              }
              if (!t.lastAction || this.now() - t.lastAction.at >= 60_000) {
                if (!await this.patch(id, task => { task.lastAction = { type: 'off', at: this.now() }; return true; })) return;
                await this.api.powerOff(source.uuid, t.account);
              }
              await this.message(id, '已发现符合条件的空闲 GPU，等待源实例关机后克隆');
              return;
            }
            const { machine, quote, cancelled } = await this.selectPricedCandidate(id, t, machines);
            if (cancelled) return;
            if (!machine) {
              await this.message(id, '等待折后单卡价格符合区间的空闲 GPU');
              return;
            }
            const prepared = await this.patch(id, task => {
              if (quote) task.quote = quote;
              task.intent = { at: this.now(), machineId: machine.machine_id };
              task.message = `正在创建：${machine.machine_alias || machine.machine_id} (${machine.gpu_name} / ${machine.region_name || machine.region_sign})`;
              return clone(task);
            });
            if (!prepared || !active(this.read().tasks.find(x => x.id === id))) return;
            try {
              const result = prepared.kind === 'clone'
                ? await this.api.clone(prepared, machine)
                : await this.api.create(prepared, machine);
              await this.recordCreation(id, result);
            } catch (error) {
              if (error instanceof ApiError && error.uncertain === false) {
                await this.update(s => {
                  const task = s.tasks.find(x => x.id === id);
                  if (task) task.intent = null;
                });
              }
              throw error;
            }
            return;
          }
        }
        const row = rows.find(r => r.uuid === t.instanceUuid);
        if (!row) {
          await this.message(id, '等待实例出现在列表中；请确认实例未被释放');
          return;
        }
        if (t.kind === 'clone' && row.status === 'created_clone_failed') {
          if (t.lastAction?.type === 'retryClone' && this.now() - t.lastAction.at < 60_000) return;
          if (!await this.patch(id, task => { task.lastAction = { type: 'retryClone', at: this.now() }; return true; })) return;
          await this.api.retryClone(row.uuid, t.account);
          await this.message(id, '重试原克隆实例，不重复创建');
          return;
        }
        if (isGpuRunning(row)) {
          if (t.kind === 'clone' && !cloneDataReady(row)) {
            await this.message(id, `GPU 已运行，等待数据盘复制完成：${row.additional_info?.copy_data_disk_after_clone_status || '状态待确认'}`);
            return;
          }
          await this.success(id, row);
          return;
        }
        if (row.status === 'running' && row.start_mode === 'non_gpu') {
          if (t.lastAction?.type === 'off' && this.now() - t.lastAction.at < 60_000) {
            await this.message(id, '等待无卡实例关机完成');
            return;
          }
          if (row.machine_id && Number.isInteger(Number(row.req_gpu_amount)) && Number(row.req_gpu_amount) >= 1 && typeof this.api.machineDetail === 'function') {
            const machine = await this.api.machineDetail(row.machine_id, t.account);
            if (!hasEnoughGpu(machine, row.req_gpu_amount)) {
              await this.message(id, `保持无卡模式运行，等待原主机空闲 GPU 达到 ${row.req_gpu_amount} 张`);
              return;
            }
          } else if (t.checkOriginalStock !== false && (!row.machine_id || !Number.isInteger(Number(row.req_gpu_amount)))) {
            await this.message(id, '保持无卡模式运行，等待确认主机和所需 GPU 数量');
            return;
          }
          if (!await this.patch(id, task => { task.lastAction = { type: 'off', at: this.now() }; return true; })) return;
          await this.api.powerOff(row.uuid, t.account);
          await this.message(id, '已检测到足够空闲 GPU，等待无卡实例关机后抢卡');
        } else if (shutdownStates.has(row.status)) {
          if (t.lastAction?.type === 'on' && this.now() - t.lastAction.at < 30_000) {
            await this.message(id, '等待开机结果');
            return;
          }
          if (!await this.patch(id, task => { task.lastAction = { type: 'on', at: this.now() }; return true; })) return;
          try {
            await this.api.powerOn(row.uuid, t.account);
          } catch (error) {
            if (error instanceof ApiError && error.uncertain === false) {
              await this.patch(id, task => { task.lastAction = null; });
            }
            throw error;
          }
          await this.message(id, '开机已受理，等待 GPU 运行');
        } else if (['new', 'clone'].includes(t.kind) && ['create_failed', 're_init_failed'].includes(row.status)) {
          if (t.lastAction?.type === 'init' && this.now() - t.lastAction.at < 60_000) return;
          if (!await this.patch(id, task => { task.lastAction = { type: 'init', at: this.now() }; return true; })) return;
          await this.api.init(row.uuid, t.account);
          await this.message(id, '请求重试创建原实例');
        } else {
          await this.message(id, `等待实例状态变化：${row.status} / ${row.start_mode || '模式未知'}`);
        }
        await this.patch(id, task => { task.errors = 0; });
      } catch (error) {
        await this.handleError(id, error);
      }
    }
    async tick() {
      for (const t of this.read().tasks.filter(monitored)) await this.step(t.id);
    }
  }

  function serverChanUrl(key) {
    if (/^SCT[A-Za-z0-9]+$/.test(key)) return `https://sctapi.ftqq.com/${key}.send`;
    const match = key.match(/^sctp(\d+)t[A-Za-z0-9]+$/);
    if (match) return `https://${match[1]}.push.ft07.com/send/${key}.send`;
    throw new Error('SendKey 格式不正确，需要 SCT… 或 sctp…');
  }

  function validateNew(c) {
    if (!c.gpus?.length || !c.regions?.length || !c.image?.uuid) throw new Error('请选择 GPU、地区和镜像');
    if (!Number.isInteger(c.gpuCount) || c.gpuCount < 1) throw new Error('GPU 数量必须为正整数');
    if (![c.minExpandGb, c.expandGb].every(x => Number.isInteger(x) && x >= 0)) throw new Error('磁盘容量必须为非负整数');
    if (c.minMemoryGb !== undefined && (!Number.isFinite(c.minMemoryGb) || c.minMemoryGb < 0)) throw new Error('最低内存容量必须为非负数');
    for (const key of ['minCpuCores', 'minCpuPerGpu', 'minGpuPriceYuan', 'maxGpuPriceYuan']) {
      if (c[key] !== undefined && (!Number.isFinite(c[key]) || c[key] < 0)) throw new Error('CPU 核数和单卡价格必须为非负数');
    }
    const { min, max } = priceRange(c);
    if (max > 0 && min > max) throw new Error('单卡价格下限不能高于上限');
    if ([min, max].some(v => Math.abs(v * 1000 - Math.round(v * 1000)) > 1e-8)) throw new Error('价格最多保留三位小数');
    if (c.driver.mode === 'minimum' && compareVersion(c.driver.value, '0') === null) throw new Error('请等待驱动加载完成并选择最低版本');
    if (c.driver.mode === 'exact' && !c.driver.value.split(/[,，\s]+/).filter(Boolean).length) throw new Error('请等待驱动加载完成并选择指定版本');
    if (c.driver.mode === 'exact' && c.driver.value.split(/[,，\s]+/).filter(Boolean).some(v => compareVersion(v, '0') === null)) throw new Error('驱动版本请用数字和点，多版本用逗号分隔');
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      VERSION, NAME, DEFAULT_SETTINGS,
      Api, ApiError, Engine, fresh, compareVersion,
      parseMachineIds, machineMatchesId, matchesMachine, sortMachines,
      createPayload, cloneSourceConfig, cloneTargetConfig, clonePayload, cloneDataReady, applyCloneFilters,
      hasEnoughGpu, groupRegions, regionalGpuOptions, availableDrivers, instanceDisplay,
      flattenImages, isGpuRunning, serverChanUrl, validateNew, canRemoveTask, removeTask,
      priceRange, matchesPrice, extractSshInfo
    };
    return;
  }

  if (window.top !== window.self || document.getElementById('autodl-helper-host')) return;

  // ─── 浏览器会话、持久化与通知 ───

  function session() {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      const identity = user.uuid || user.id;
      return {
        token: localStorage.getItem('token'),
        account: identity ? `${identity}:${user.sub_name || ''}` : '',
        subUser: !!user.sub_name,
        appVersion: JSON.parse(localStorage.getItem('app_version') || '{}').version || '0.0.0'
      };
    } catch {
      return { token: null, account: '' };
    }
  }

  const read = () => {
    const s = GM_getValue(KEY, fresh());
    s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    return s;
  };
  let onState = () => {};
  async function update(fn) {
    if (!navigator.locks) throw new Error('此浏览器缺少 Web Locks，请使用新版 Chrome 或 Edge');
    return navigator.locks.request(`${KEY}-state`, async () => {
      const s = read(), result = fn(s);
      GM_setValue(KEY, s);
      onState();
      return result;
    });
  }

  const api = new Api(session), engine = new Engine({ api, read, update });
  let audio;
  async function enableSound() {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    await audio.resume();
  }
  async function beep() {
    await enableSound();
    if (audio.state !== 'running') throw new Error('请点击“测试提醒”解锁提示音');
    for (const offset of [0, 0.25, 0.5]) {
      const o = audio.createOscillator(), gain = audio.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      gain.gain.value = 0.08;
      o.connect(gain);
      gain.connect(audio.destination);
      o.start(audio.currentTime + offset);
      o.stop(audio.currentTime + offset + 0.15);
    }
  }

  function sendServer(key, title, desp) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: serverChanUrl(key),
        timeout: 15_000,
        anonymous: true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({ title, desp }).toString(),
        onload: res => {
          try {
            const data = JSON.parse(res.responseText);
            if (res.status >= 200 && res.status < 300 && (data.code === 0 || data.errno === 0)) resolve();
            else reject(new Error('Server酱未接受通知，请检查 SendKey 和额度'));
          } catch {
            reject(new Error('Server酱返回内容异常'));
          }
        },
        onerror: () => reject(new Error('Server酱网络异常')),
        ontimeout: () => reject(new Error('Server酱通知超时'))
      });
    });
  }

  async function dispatchEvents() {
    for (const event of read().events) {
      const settings = read().settings;
      const title = `AutoDL 抢卡成功：${event.taskName}`;
      const text = `实例 ${event.instanceUuid} 已进入 GPU 运行状态${event.sshCommand ? ` (${event.sshCommand})` : ''}`;
      if (!event.desktop && settings.desktop) {
        try {
          GM_notification({ title, text, timeout: 10000 });
          await update(s => { const e = s.events.find(x => x.id === event.id); if (e) e.desktop = true; });
        } catch { /* ignore */ }
      }
      if (!event.sound && settings.sound) {
        try {
          await beep();
          await update(s => { const e = s.events.find(x => x.id === event.id); if (e) e.sound = true; });
        } catch { /* ignore */ }
      }
      if (!event.server && settings.serverChan && settings.sendKey && event.nextAt <= Date.now()) {
        try {
          await sendServer(
            settings.sendKey,
            title,
            `${text}\n\n任务：${event.taskName}\n\n[查看实例](https://www.autodl.com/console/instance/list)`
          );
          await update(s => { const e = s.events.find(x => x.id === event.id); if (e) { e.server = true; e.error = ''; } });
        } catch (error) {
          await update(s => {
            const e = s.events.find(x => x.id === event.id);
            if (e) {
              e.serverAttempts++;
              e.nextAt = Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(e.serverAttempts, 6));
              e.error = error.message;
            }
          });
        }
      }
    }
  }

  let runner = false, busy = false, loopTimer;
  const latestInstanceMap = new Map();

  async function loop() {
    if (busy) return;
    clearTimeout(loopTimer);
    busy = true;
    try {
      if (!navigator.locks) {
        notice('当前浏览器不支持任务互斥，请使用新版 Chrome 或 Edge');
        return;
      }
      await navigator.locks.request(`${KEY}-runner`, { ifAvailable: true }, async lock => {
        runner = !!lock;
        renderTasks();
        if (!lock) return;
        if ((read().nextCycleAt || 0) > Date.now()) return;
        await update(s => { s.nextCycleAt = Date.now() + s.settings.intervalSeconds * 1000; });
        await engine.tick();
        await dispatchEvents();
        await update(s => { s.nextCycleAt = Date.now() + s.settings.intervalSeconds * 1000; });
      });
    } catch (error) {
      notice(error.message);
    } finally {
      busy = false;
      loopTimer = setTimeout(loop, Math.max(MIN_INTERVAL_SECONDS, Number(read().settings.intervalSeconds) || DEFAULT_SETTINGS.intervalSeconds) * 1000);
    }
  }

  // ─── Shadow DOM 界面构建 ───

  const host = document.createElement('div');
  host.id = 'autodl-helper-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'class') node.className = value;
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children.filter(x => x != null));
    return node;
  };
  const button = (text, fn, cls = '') => el('button', { type: 'button', onclick: fn, class: cls }, text);
  const input = (type, value, attrs = {}) => el('input', { type, value, ...attrs });
  const label = (text, field) => {
    field.setAttribute('aria-label', text);
    return el('label', {}, el('span', {}, text), field);
  };
  const section = (step, title, description, ...children) => el(
    'section',
    { class: 'section' },
    el('h3', { class: 'section-title' }, ...(step ? [el('span', { class: 'step' }, String(step))] : []), title),
    description ? el('p', { class: 'muted' }, description) : null,
    ...children
  );
  const safeAction = fn => async () => {
    try {
      await fn();
    } catch (error) {
      notice(error.message);
    }
  };
  async function copyText(text, labelText) {
    if (!text) throw new Error(`暂无可复制的${labelText}`);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    notice(`已复制${labelText}`);
  }

  const style = el('style', {}, `
    :host{all:initial;font:13.5px/1.55 "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#0f172a}
    *{box-sizing:border-box}button,input,select,textarea{font:inherit}
    button{cursor:pointer;border:1px solid #cbd5e1;border-radius:6px;padding:5px 10px;background:#fff;color:#0f172a;transition:background .12s,border-color .12s}
    button:hover{background:#f1f5f9;border-color:#94a3b8}button:disabled{opacity:.5;cursor:not-allowed}
    .primary{background:#0284c7;color:#fff;border-color:#0284c7;font-weight:600}.primary:hover{background:#0369a1;border-color:#0369a1}
    .danger{color:#dc2626;border-color:#fecaca}.danger:hover{background:#fef2f2}
    .sm{padding:2px 7px;font-size:12px}
    .launcher{position:fixed;right:22px;bottom:24px;z-index:2147483646;box-shadow:0 8px 24px rgba(15,23,42,.22);padding:11px 18px;border-radius:8px;font-size:14px}
    .panel{position:fixed;right:22px;bottom:78px;width:min(680px,calc(100vw - 24px));max-height:82vh;overflow:auto;background:#fff;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 20px 60px rgba(15,23,42,.24);z-index:2147483646;padding:18px}
    .head,.bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.head strong{font-size:18px;letter-spacing:-.01em}
    .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.selected{background:#e0f2fe;color:#0369a1;border-color:#7dd3fc;font-weight:600}
    .muted{color:#475569;font-size:12px;white-space:pre-line;margin:4px 0}.notice{background:#fef3c7;border:1px solid #fde68a;color:#92400e;border-radius:7px;padding:8px 10px;margin:10px 0;white-space:pre-wrap;font-size:12.5px}
    .card{border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:10px 0;background:#f8fafc;overflow-wrap:anywhere}.success{border-color:#6ee7b7;background:#ecfdf5}
    label{display:flex;flex-direction:column;gap:4px;margin:8px 0;font-size:13px;font-weight:500}
    input,select{width:100%;border:1px solid #cbd5e1;border-radius:6px;padding:6px 8px;background:#fff;color:#0f172a;font-variant-numeric:tabular-nums}
    input:focus,select:focus{outline:2px solid #7dd3fc;border-color:#0284c7}
    input[type=checkbox]{width:auto;margin:0 6px 0 0}
    .check{display:flex;flex-direction:row;align-items:center;margin:7px 0;font-weight:400}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.picks{display:flex;gap:6px;flex-wrap:wrap;max-height:150px;overflow:auto}
    .ordered{margin:5px 0;display:flex;gap:6px;align-items:center;font-variant-numeric:tabular-nums}.ordered span{flex:1}
    .status{font-size:12px;color:#0284c7;font-weight:600}.log{font:12px/1.65 "Cascadia Mono","JetBrains Mono",ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:3px 0;border-bottom:1px dashed #e2e8f0}
    [hidden]{display:none!important}
    .top{position:sticky;top:-18px;z-index:3;background:#fff;margin:-18px -18px 12px;padding:18px 18px 2px;border-bottom:1px solid #e2e8f0}
    .section{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:13px;margin:11px 0;min-width:0}
    .section-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:650;margin:0 0 6px;color:#0f172a}
    .step{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;border-radius:6px;background:#e0f2fe;color:#0369a1;font-size:12px;font-weight:700}
    .section .picks{margin:8px 0}.section label:last-child{margin-bottom:0}.section .grid label{margin:4px 0}
    .section fieldset{border:0;padding:0;margin:0;min-width:0}.section fieldset:disabled{opacity:.55}
    .section .ordered{background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:4px 8px}.section .ordered button{padding:2px 7px}
    .section-footer{border-top:1px solid #e2e8f0;padding-top:12px;margin-top:12px}.section-footer button{width:100%;padding:9px}
    .picker-title{color:#334155;font-size:12px;font-weight:600}
    .instance-option{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;gap:6px}
    .instance-detail{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
    .instance-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;font-variant-numeric:tabular-nums}
    .state-badge{border-radius:5px;padding:1px 7px;background:#f1f5f9;color:#475569;font-weight:600}
    .state-running{background:#d1fae5;color:#065f46}.state-shutdown{background:#fee2e2;color:#991b1b}
    .driver-choices{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:7px;margin:8px 0}
    .driver-choices label.check{display:flex;align-items:center;gap:7px;margin:0;padding:6px 9px;min-height:34px;background:#fff;border:1px solid #cbd5e1;border-radius:6px;font-variant-numeric:tabular-nums}
    .driver-choices input[type=checkbox]{flex:none;margin:0}.driver-choices label:has(input:checked){background:#e0f2fe;border-color:#38bdf8}
    .host-table-wrap{max-height:210px;overflow:auto;border:1px solid #cbd5e1;border-radius:7px;background:#fff;margin:8px 0}
    .host-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
    .host-table th,.host-table td{padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:left;white-space:nowrap}
    .host-table th{position:sticky;top:0;background:#f1f5f9;color:#334155;font-weight:600;z-index:1}
    .host-table tr:hover td{background:#f8fafc}
    .idle-ok{color:#059669;font-weight:700}.idle-zero{color:#64748b}
    .ssh-box{background:#0f172a;color:#f8fafc;border-radius:7px;padding:9px 11px;margin-top:8px;font:12px/1.6 "Cascadia Mono","JetBrains Mono",ui-monospace,monospace}
    .ssh-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
    .ssh-actions button{background:#1e293b;color:#e2e8f0;border-color:#334155;font-size:11.5px;padding:3px 8px}
    .ssh-actions button:hover{background:#334155}
    @media(max-width:560px){.grid{grid-template-columns:1fr;gap:0}.panel{right:12px;padding:14px}}
  `);

  const panel = el('section', { class: 'panel', hidden: true });
  const launcher = button('AutoDL 抢卡', () => { panel.hidden = !panel.hidden; renderTasks(); }, 'launcher primary');
  const noticeBox = el('div', { class: 'notice', hidden: true });
  function notice(text) {
    noticeBox.textContent = text;
    noticeBox.hidden = !text;
  }
  const statusLine = el('div', { class: 'muted' });
  const views = {}, tabs = el('nav', { class: 'tabs' });

  function show(name) {
    for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
    for (const b of tabs.children) b.classList.toggle('selected', b.dataset.name === name);
    renderTasks();
    if (name === 'existing') autoLoad('instances', loadInstances, 0);
    if (name === 'new' && !regionsLoaded) autoLoad('regions', loadRegions, 0);
  }

  for (const [name, title] of [['tasks', '任务'], ['existing', '抢开机'], ['new', '抢新实例'], ['settings', '设置'], ['logs', '日志']]) {
    const b = button(title, () => show(name));
    b.dataset.name = name;
    tabs.append(b);
    views[name] = el('div', { hidden: name !== 'tasks' });
  }

  panel.append(
    el(
      'div',
      { class: 'top' },
      el('header', { class: 'head' }, el('strong', {}, `${NAME} v${VERSION}`), button('收起', () => { panel.hidden = true; })),
      el('div', { class: 'muted' }, '普通容器实例 · 支持系统盘+数据盘克隆与指定服务器抢卡 · 保持页面开启'),
      statusLine,
      noticeBox,
      tabs
    ),
    ...Object.values(views)
  );
  root.append(style, panel, launcher);

  // ─── 任务看板渲染（含 SSH 一键复制与切流） ───

  function renderSshPanel(t, s) {
    const liveRow = latestInstanceMap.get(t.instanceUuid);
    const info = liveRow ? extractSshInfo(liveRow, s.settings?.sshAlias || 'autodl') : t.ssh;
    if (!info || !info.command) return null;
    const box = el('div', { class: 'ssh-box' }, el('div', {}, `SSH: ${info.command}`));
    const actions = el(
      'div',
      { class: 'ssh-actions' },
      button('复制 SSH 命令', safeAction(() => copyText(info.command, 'SSH 命令'))),
      ...(info.password ? [button('复制密码', safeAction(() => copyText(info.password, '实例密码')))] : []),
      ...(info.sshConfig ? [button('复制 ~/.ssh/config', safeAction(() => copyText(info.sshConfig, 'SSH Config 配置块')))] : []),
      ...(info.psCommand ? [button('复制 PowerShell 切流命令', safeAction(() => copyText(info.psCommand, 'PowerShell 自动更新 ~/.ssh/config 命令')))] : [])
    );
    box.append(actions);
    return box;
  }

  function renderTasks() {
    const s = read(), account = session().account;
    const current = s.tasks.filter(t => t.account === account);
    const count = current.filter(active).length;
    launcher.textContent = `AutoDL 抢卡 · ${count} 待完成`;
    statusLine.textContent = !session().token
      ? '等待登录；已保存的任务继续保留'
      : `${count} 个任务待完成 · ${runner ? '此页面执行监控' : '等待执行轮次 / 其他页面监控'} · ${s.settings.intervalSeconds} 秒间隔`;
    views.tasks.replaceChildren(el('p', { class: 'muted' }, '各任务独立执行。创建或克隆请求发出后，取消任务不会撤回已发请求或关闭已开实例。'));
    if (!current.length) views.tasks.append(el('p', {}, '还没有任务。选择“抢开机”或“抢新实例”开始配置。'));

    for (const t of current) {
      const card = el('article', { class: `card ${t.status === 'success' ? 'success' : ''}` });
      const actions = el('div', { class: 'bar' }, el('strong', {}, t.name));
      if (active(t)) {
        actions.append(button('取消任务', safeAction(async () => {
          await update(state => {
            const task = state.tasks.find(x => x.id === t.id);
            if (active(task)) {
              task.status = 'cancelled';
              task.message = task.intent ? '已取消，已发送创建请求请核对控制台' : '已由你取消';
            }
          });
        }), 'danger'));
      } else {
        const remove = button('移除记录', safeAction(async () => { await update(state => removeTask(state, t.id)); }));
        remove.disabled = !canRemoveTask(t);
        actions.append(remove);
      }
      card.append(
        actions,
        el('div', { class: 'status' }, { active: '监控中', success: '已成功', cancelled: '已取消' }[t.status]),
        el('div', {}, t.message || '等待首次检查')
      );

      if (t.kind === 'new') {
        card.append(el('div', { class: 'muted' },
          `${t.config.gpus.join(' → ')} · ${t.config.gpuCount} 卡 · ${t.config.regions.map(r => r.name).join(' → ')}` +
          `${t.config.minMemoryGb ? ` · 内存≥${t.config.minMemoryGb}GB` : ''}\n镜像：${t.config.image.name}`));
        card.append(el('div', { class: 'muted' },
          `实际额外扩容：${t.config.expandGb}GB · 主机可扩容≥${t.config.minExpandGb}GB` +
          `${t.config.minCpuCores ? ` · 实例 CPU≥${t.config.minCpuCores}核` : ''}${t.config.minCpuPerGpu ? ` · 每卡 CPU≥${t.config.minCpuPerGpu}核` : ''}`));
        if (t.config.machineIds?.length) {
          card.append(el('div', { class: 'muted' }, `指定主机 (${t.config.machineFilterMode === 'prefer' ? '优先' : '仅限'})：${t.config.machineIds.join(' → ')}`));
        }
        if (t.config.excludeMachineIds?.length) {
          card.append(el('div', { class: 'muted' }, `排除主机：${t.config.excludeMachineIds.join(', ')}`));
        }
        const { min, max } = priceRange(t.config);
        if (min || max) card.append(el('div', { class: 'muted' }, `折后单卡价格：${min}–${max || '不限'}元/小时`));
      }

      if (t.quote) {
        const gpuCountNum = t.config?.gpuCount || t.targetFilters?.gpuCount || 1;
        card.append(el('div', { class: 'muted' },
          `下单前报价：${yuan(t.quote.gpuHourlyMilli / gpuCountNum)}元/卡/小时 · GPU 合计${yuan(t.quote.gpuHourlyMilli)}元/小时 · 数据盘${yuan(t.quote.diskDailyMilli)}元/天`));
      }

      if (t.kind === 'clone') {
        const modeDesc = t.cloneMode === 'clone_only'
          ? `纯克隆源：${t.sourceUuid}（不尝试开启原实例）`
          : `原实例优先：${t.sourceUuid}${t.completedVia === 'original' ? '（已直接开机成功，未克隆）' : ''}`;
        const f = t.targetFilters;
        const machineDesc = f?.machineIds?.length
          ? `\n指定服务器 (${f.machineFilterMode === 'prefer' ? '优先' : '仅限'})：${f.machineIds.join(' → ')}`
          : '';
        const excludeDesc = f?.excludeMachineIds?.length ? `\n排除服务器：${f.excludeMachineIds.join(', ')}` : '';
        const sparseDesc = f?.ftSparse ? ' · 已开启稀疏拷贝优化' : '';
        card.append(el('div', { class: 'muted' },
          `${modeDesc}\n克隆内容：系统盘＋数据盘${sparseDesc} · 地区固定为源实例地区 · 原实例保留\n` +
          `目标：${f ? `${f.gpus.join(' → ')} · ${f.gpuCount} 卡${f.minMemoryGb ? ` · 内存≥${f.minMemoryGb}GB` : ''}${f.maxGpuPriceYuan ? ` · 最高${f.maxGpuPriceYuan}元/卡/h` : ''}` : '沿用原型号和卡数'}` +
          `${machineDesc}${excludeDesc}`
        ));
      }

      if (t.instanceUuid) card.append(el('div', { class: 'muted' }, `实例：${t.instanceUuid}`));
      if (t.marker) card.append(el('div', { class: 'muted' }, `创建核对名称：${t.marker}`));
      if (t.status === 'success') {
        const sshPanel = renderSshPanel(t, s);
        if (sshPanel) card.append(sshPanel);
      }

      if ((active(t) || t.status === 'cancelled') && t.intent && Date.now() - t.intent.at > 120_000) {
        card.append(button(
          active(t) ? '已核对未创建，重新尝试' : '已核对未创建，结束核对',
          safeAction(async () => {
            if (!window.confirm(`请先到控制台核对不存在名称为 ${t.marker} 的实例和正在创建的实例。${active(t) ? '确认后重新发送创建请求？' : '确认后结束核对？不会重新下单。'}`)) return;
            await update(state => {
              const task = state.tasks.find(x => x.id === t.id);
              if (task && !task.instanceUuid && task.intent?.at === t.intent.at) {
                task.intent = null;
                task.nextAt = 0;
                task.message = active(task) ? '你已核对未创建，继续抢卡' : '已取消；你已核对未创建';
              }
            });
          })
        ));
      }
      const event = s.events.find(e => e.id === t.id);
      if (event?.error) card.append(el('div', { class: 'muted' }, `${event.error}；通知稍后重试`));
      views.tasks.append(card);
    }

    const foreign = s.tasks.filter(t => t.account !== account && active(t)).length;
    if (foreign) views.tasks.append(el('p', { class: 'muted' }, `其他账号有 ${foreign} 个待完成任务；切回对应账号后自动继续。`));
    views.logs.replaceChildren(...s.logs.map(l => el('div', { class: 'log' }, `${new Date(l.at).toLocaleString()} ${l.text}`)));
  }

  onState = renderTasks;
  GM_addValueChangeListener(KEY, () => renderTasks());

  // ─── 异步自动加载与防抖 ───

  const autoTimers = new Map();
  function cancelAuto(key) {
    clearTimeout(autoTimers.get(key));
    autoTimers.delete(key);
  }
  function autoLoad(key, fn, delay = 200) {
    cancelAuto(key);
    autoTimers.set(key, setTimeout(async () => {
      autoTimers.delete(key);
      try {
        await fn();
      } catch (error) {
        notice(error.message);
        if (error instanceof ApiError && session().token && !['AccountChanged', 'SchemaChanged'].includes(error.code)) {
          autoLoad(key, fn, 10000);
        }
      }
    }, delay));
  }

  // ─── 可复用组件：有序多选器 + 可视化主机选择表格 ───

  function orderedPicker(title, onChange = () => {}) {
    const selected = [], available = el('div', { class: 'picks' }), ordered = el('div');
    let options = [];
    function render() {
      available.replaceChildren(...options.map(o => button(o.name, () => {
        const i = selected.findIndex(x => x.id === o.id);
        if (i >= 0) selected.splice(i, 1);
        else selected.push(o);
        render();
        onChange();
      }, selected.some(x => x.id === o.id) ? 'selected' : '')));
      ordered.replaceChildren(...selected.map((o, i) => el(
        'div',
        { class: 'ordered' },
        el('span', {}, `${i + 1}. ${o.name}`),
        button('↑', () => { if (i > 0) { [selected[i - 1], selected[i]] = [selected[i], selected[i - 1]]; render(); } }),
        button('↓', () => { if (i < selected.length - 1) { [selected[i + 1], selected[i]] = [selected[i], selected[i + 1]]; render(); } })
      )));
    }
    return {
      node: el('div', {}, el('div', { class: 'picker-title' }, title), available, ordered),
      get: () => clone(selected),
      setOptions(list) {
        options = list;
        const refreshed = selected.map(s => list.find(o => o.id === s.id)).filter(Boolean);
        selected.splice(0, selected.length, ...refreshed);
        render();
        onChange();
      }
    };
  }

  function createHostSelector(prefixLabel) {
    const targetInput = input('text', '', { placeholder: '留空不限；可填如 661机, 756机 或在下方表格点[+指定]（按顺序优先）' });
    const filterMode = el(
      'select',
      {},
      el('option', { value: 'only' }, '仅抢指定的主机（白名单）'),
      el('option', { value: 'prefer' }, '优先抢指定主机，无卡时允许同条件其他主机')
    );
    const excludeInput = input('text', '', { placeholder: '可选，排除故障机 ID 或编号，如 404机' });
    const tableWrap = el('div', { class: 'host-table-wrap', hidden: true });
    const hint = el('p', { class: 'muted' }, '选择 GPU 后自动加载该地区全部主机（含当前 0 空闲卡的机器），可直接点击指定要抢的服务器。');

    function addTokenToInput(inputEl, tok) {
      const list = parseMachineIds(inputEl.value);
      if (!list.some(x => x.toLowerCase() === tok.toLowerCase())) list.push(tok);
      inputEl.value = list.join(', ');
    }
    function removeTokenFromInput(inputEl, tok) {
      const list = parseMachineIds(inputEl.value).filter(x => x.toLowerCase() !== tok.toLowerCase());
      inputEl.value = list.join(', ');
    }

    function renderMachines(rows) {
      if (!rows || !rows.length) {
        tableWrap.hidden = true;
        tableWrap.replaceChildren();
        return;
      }
      tableWrap.hidden = false;
      const tbody = el('tbody');
      const isMaint = m => [3, 4, 5, 6].includes(Number(m.on_line));
      const sorted = [...rows].sort((a, b) => Number(isMaint(a)) - Number(isMaint(b)) ||
        (Number(b.gpu_idle_num) || 0) - (Number(a.gpu_idle_num) || 0) ||
        String(a.machine_alias || a.machine_id).localeCompare(String(b.machine_alias || b.machine_id)));
      for (const m of sorted.slice(0, 120)) {
        const displayId = m.machine_alias || m.machine_id;
        const maint = isMaint(m);
        const idle = Number(m.gpu_idle_num) || 0;
        const total = Number(m.gpu_number || m.gpu_all_num || m.gpu_order_num) || '?';
        const expandGb = Number.isFinite(Number(m.max_data_disk_expand_size))
          ? `${Math.floor(Number(m.max_data_disk_expand_size) / GiB)}GB`
          : '-';
        const skuPrice = m.machine_sku_info?.find?.(s => s.type === 'payg')?.current_price ?? m.payg_price;
        const priceStr = skuPrice != null ? `¥${(Number(skuPrice) / 1000).toFixed(2)}` : '-';
        const tr = el(
          'tr',
          {},
          el('td', { title: `machine_id: ${m.machine_id}` }, el('strong', {}, displayId), m.machine_alias && m.machine_id !== m.machine_alias ? el('span', { class: 'muted' }, ` (${String(m.machine_id).slice(0, 8)})`) : null),
          el('td', {}, m.gpu_name || '-'),
          el('td', { class: !maint && idle > 0 ? 'idle-ok' : 'idle-zero' }, `${idle} / ${total}${maint ? ' (维护)' : ''}`),
          el('td', {}, `${m.driver_version || '-'} / ${m.highest_cuda_version || '-'}`),
          el('td', {}, expandGb),
          el('td', {}, priceStr),
          el(
            'td',
            {},
            button('+指定', () => {
              removeTokenFromInput(excludeInput, displayId);
              addTokenToInput(targetInput, displayId);
            }, 'sm'),
            ' ',
            button('×排除', () => {
              removeTokenFromInput(targetInput, displayId);
              addTokenToInput(excludeInput, displayId);
            }, 'sm danger')
          )
        );
        tbody.append(tr);
      }
      tableWrap.replaceChildren(
        el(
          'table',
          { class: 'host-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, '主机ID'),
            el('th', {}, 'GPU型号'),
            el('th', {}, '空闲/总卡'),
            el('th', {}, '驱动/CUDA'),
            el('th', {}, '可扩容盘'),
            el('th', {}, '单卡原价'),
            el('th', {}, '操作')
          )),
          tbody
        )
      );
    }

    return {
      node: el(
        'div',
        {},
        el('div', { class: 'grid' },
          label(`${prefixLabel}指定目标服务器（主机ID / 编号）`, targetInput),
          label(`${prefixLabel}指定主机策略`, filterMode)
        ),
        label(`${prefixLabel}排除服务器（黑名单主机ID）`, excludeInput),
        hint,
        tableWrap
      ),
      getValues() {
        const machineIds = parseMachineIds(targetInput.value);
        return {
          machineIds,
          machineFilterMode: machineIds.length ? filterMode.value : 'any',
          excludeMachineIds: parseMachineIds(excludeInput.value)
        };
      },
      setMachines(rows) {
        renderMachines(rows);
      },
      reset() {
        tableWrap.hidden = true;
        tableWrap.replaceChildren();
      }
    };
  }

  // ─── 视图 1：抢开机 & 克隆实例（含数据盘、稀疏优化、指定主机） ───

  let regionsLoaded = false, instancesGeneration = 0;
  const instanceList = el('div'), selectedInstances = new Map();

  async function loadInstances() {
    const generation = ++instancesGeneration, account = session().account;
    const rows = await api.instances(account);
    if (generation !== instancesGeneration || account !== session().account) return;
    for (const r of rows) latestInstanceMap.set(r.uuid, r);
    const previouslySelected = new Set(selectedInstances.keys());
    instanceList.replaceChildren();
    selectedInstances.clear();
    for (const r of rows) {
      if (previouslySelected.has(r.uuid)) selectedInstances.set(r.uuid, r);
      const cb = input('checkbox', '', {
        checked: previouslySelected.has(r.uuid),
        onchange: () => {
          if (cb.checked) selectedInstances.set(r.uuid, r);
          else selectedInstances.delete(r.uuid);
          refreshCloneEditor();
        }
      });
      const display = instanceDisplay(r);
      instanceList.append(el(
        'label',
        { class: 'check instance-option' },
        cb,
        el(
          'span',
          { class: 'instance-detail' },
          el('strong', {}, r.name || r.uuid),
          el(
            'span',
            { class: 'instance-meta' },
            el('span', { class: `state-badge state-${display.tone}` }, display.status),
            el('span', {}, `${display.gpu} · ${display.count} 卡`),
            display.hostLabel ? el('span', { class: 'muted' }, `主机: ${display.hostLabel}`) : null,
            display.mode ? el('span', { class: 'muted' }, display.mode) : null
          )
        )
      ));
    }
    if (!rows.length) instanceList.append(el('p', {}, '当前账号没有普通容器实例'));
    refreshCloneEditor();
  }

  const existingMode = el(
    'select',
    {},
    el('option', { value: 'existing' }, '原实例开机（死守原主机释放 GPU）'),
    el('option', { value: 'clone' }, '优先原实例开机，必要时克隆（含系统盘+数据盘）'),
    el('option', { value: 'clone_only' }, '仅克隆到新服务器并开机（含系统盘+数据盘，直接换机/换卡）')
  );
  const clonePanel = el('div', { hidden: true });
  existingMode.addEventListener('change', () => refreshCloneEditor());

  views.existing.append(
    section(null, '选择已有实例', '可多选源实例，每个实例建立独立任务。', instanceList),
    section(
      null,
      '开始抢开机 / 克隆',
      '等待空闲 GPU 期间保持无卡实例运行。双路模式优先开启原实例；纯克隆模式直接盯目标服务器并完整克隆系统盘与数据盘。',
      label('开机方式', existingMode),
      clonePanel,
      button('启动所选实例抢卡', safeAction(async () => {
        if (!selectedInstances.size) throw new Error('请先选择实例');
        const account = session().account;
        if (!account) throw new Error('请先登录 AutoDL');
        const rows = [...selectedInstances.values()];
        const isCloning = existingMode.value === 'clone' || existingMode.value === 'clone_only';
        const cloneMode = existingMode.value === 'clone_only' ? 'clone_only' : 'prefer_original';
        const targetFilters = isCloning ? readCloneFilters() : null;
        await update(s => {
          for (const r of rows) {
            if (s.tasks.some(t => t.account === account && active(t) && (t.sourceUuid || t.instanceUuid) === r.uuid)) continue;
            const id = uid();
            const prefix = existingMode.value === 'clone_only' ? '纯克隆：' : isCloning ? '本机优先：' : '';
            s.tasks.push({
              id,
              kind: isCloning ? 'clone' : 'existing',
              ...(isCloning ? { cloneMode, sourceUuid: r.uuid, marker: `ADLH-${id}`, targetFilters } : { instanceUuid: r.uuid }),
              name: `${prefix}${r.name || r.uuid}`,
              account,
              status: 'active',
              createdAt: Date.now(),
              message: isCloning ? '等待克隆（含数据盘）' : '等待抢开机',
              nextAt: 0
            });
          }
        });
        enableSound().catch(() => {});
        show('tasks');
        loop();
      }), 'primary')
    )
  );

  // ─── 视图 2：算力市场抢新实例 ───

  const newHostSelector = createHostSelector('');
  const gpuPicker = orderedPicker('可选 GPU 型号 · 多选，↑↓调整优先级', () => {
    resetImages('选择 GPU 后自动加载镜像');
    resetDrivers();
    newHostSelector.reset();
    refreshNewForm();
    if (gpuPicker.get().length) {
      autoLoad('drivers', loadDrivers);
      autoLoad('images', loadImages);
    }
  });
  const regionPicker = orderedPicker('可选地区 · 多选，↑↓调整地区优先级', () => {
    gpuQueryGeneration++;
    gpuPicker.setOptions([]);
    cancelAuto('gpus');
    gpuHint.textContent = regionPicker.get().length ? '正在加载所选地区的 GPU…' : '请先选择地区。';
    refreshNewForm();
    if (regionPicker.get().length) autoLoad('gpus', loadRegionGpus);
  });

  const taskName = input('text', '', { placeholder: '例如：训练任务 A' });
  const gpuCount = input('number', 1, { min: 1, step: 1 });
  const minMemory = input('number', 0, { min: 0, step: 'any' });
  const minCpu = input('number', 0, { min: 0, step: 'any' });
  const minCpuPerGpu = input('number', 0, { min: 0, step: 'any' });
  const minGpuPrice = input('number', 0, { min: 0, step: '0.001' });
  const maxGpuPrice = input('number', 0, { min: 0, step: '0.001' });
  const minExpand = input('number', 0, { min: 0, step: 1 });
  const expand = input('number', 0, { min: 0, step: 1 });
  const driverMode = el('select', {}, el('option', { value: 'any' }, '不限制'), el('option', { value: 'minimum' }, '最低版本'), el('option', { value: 'exact' }, '指定版本'));
  const driverValue = el('select', {}, el('option', { value: '' }, '先读取已有驱动版本'));
  const driverExact = el('div', { class: 'driver-choices', hidden: true });
  const driverHint = el('p', { class: 'muted' }, '选择 GPU 后读取已有驱动版本与候选主机。');
  let driverVersions = [], driverQueryGeneration = 0;
  const exactVersions = new Set();

  function renderDriverOptions() {
    driverExact.replaceChildren(...driverVersions.map(v => {
      const cb = input('checkbox', '', {
        checked: exactVersions.has(v),
        onchange: () => {
          if (cb.checked) exactVersions.add(v);
          else exactVersions.delete(v);
        }
      });
      return el('label', { class: 'check' }, cb, v);
    }));
  }

  function resetDrivers() {
    cancelAuto('drivers');
    driverQueryGeneration++;
    driverVersions = [];
    exactVersions.clear();
    driverValue.replaceChildren(el('option', { value: '' }, '等待自动加载驱动版本'));
    renderDriverOptions();
    driverHint.textContent = '选择 GPU 后自动加载已有驱动版本与主机列表。';
  }

  async function loadDrivers() {
    const gpus = gpuPicker.get();
    if (!gpus.length) throw new Error('先选择 GPU 型号');
    const generation = ++driverQueryGeneration, account = session().account;
    driverHint.textContent = '正在加载主机列表与显卡驱动…';
    try {
      const c = { gpus: gpus.map(g => g.name), regions: regionPicker.get(), gpuCount: 1 };
      const rows = await api.machines(c, account, true);
      if (generation !== driverQueryGeneration || account !== session().account) return;
      const regionalRows = rows.filter(r => c.gpus.includes(r.gpu_name) && c.regions.some(region => region.signs.includes(r.region_sign)));
      driverVersions = availableDrivers(regionalRows);
      newHostSelector.setMachines(regionalRows);
      exactVersions.clear();
      driverValue.replaceChildren(
        el('option', { value: '' }, driverVersions.length ? '请选择最低驱动版本' : '没有可用的驱动版本'),
        ...driverVersions.map(v => el('option', { value: v }, v))
      );
      renderDriverOptions();
      driverHint.textContent = driverVersions.length
        ? `读取到 ${regionalRows.length} 台主机、${driverVersions.length} 个驱动版本（含当前 0 空闲卡主机）。`
        : '未读到有效驱动版本，可保持“不限制”或稍后重试。';
    } catch (error) {
      if (generation !== driverQueryGeneration || account !== session().account) return;
      driverHint.textContent = '驱动读取失败，请重试。';
      throw error;
    } finally {
      if (generation === driverQueryGeneration) refreshNewForm();
    }
  }

  const imageType = el('select', {}, el('option', { value: 'base' }, '官方基础镜像'), el('option', { value: 'private' }, '我的私有镜像'));
  const imageSelect = el('select', {}, el('option', { value: '' }, '选择 GPU 后自动加载镜像'));
  let images = [], imageQueryGeneration = 0, gpuQueryGeneration = 0;
  const gpuHint = el('p', { class: 'muted' }, '请先选择地区。');

  function resetImages(text) {
    cancelAuto('images');
    imageQueryGeneration++;
    images = [];
    imageSelect.replaceChildren(el('option', { value: '' }, text));
  }
  imageType.addEventListener('change', () => {
    resetImages('正在自动加载镜像…');
    refreshNewForm();
    if (gpuPicker.get().length) autoLoad('images', loadImages);
  });
  imageSelect.addEventListener('change', () => refreshNewForm());

  async function loadRegions() {
    const account = session().account;
    const data = await api.call('/api/v1/region/list', undefined, account);
    if (account !== session().account) return;
    if (!Array.isArray(data)) throw new Error('地区列表结构发生变化');
    regionPicker.setOptions(groupRegions(data));
    regionsLoaded = true;
  }

  async function loadRegionGpus() {
    const regions = regionPicker.get();
    if (!regions.length) throw new Error('请先选择地区');
    const generation = ++gpuQueryGeneration, account = session().account;
    gpuHint.textContent = '正在加载所选地区的 GPU 型号…';
    try {
      const [regional, catalog] = await Promise.all([
        api.call('/api/v1/machine/region/gpu_type', { region_sign_list: [...new Set(regions.flatMap(r => r.signs))] }, account),
        api.call('/api/v1/machine/gpu_type', undefined, account)
      ]);
      if (generation !== gpuQueryGeneration || account !== session().account) return;
      const options = regionalGpuOptions(regional, catalog);
      gpuPicker.setOptions(options);
      gpuHint.textContent = options.length
        ? `所选地区共有 ${options.length} 种 GPU 可选，暂时无空闲卡的型号也可以监控。`
        : '这些地区没有可选 GPU，请更换地区。';
    } catch (error) {
      if (generation !== gpuQueryGeneration || account !== session().account) return;
      gpuHint.textContent = 'GPU 读取失败，请重试。';
      throw error;
    } finally {
      if (generation === gpuQueryGeneration) refreshNewForm();
    }
  }

  async function loadImages() {
    const gpus = gpuPicker.get();
    if (!gpus.length) throw new Error('先选择 GPU 型号');
    const architectures = new Set(gpus.map(g => `${g.chip_corp}/${g.cpu_arch}`));
    if (architectures.size !== 1) throw new Error('同一任务的 GPU 需使用相同芯片厂商和 CPU 架构，以匹配镜像');
    const generation = ++imageQueryGeneration, type = imageType.value;
    const body = { chip_corp: [gpus[0].chip_corp], cpu_arch: [gpus[0].cpu_arch] };
    const data = await api.call(type === 'base' ? '/api/v1/image/all' : '/api/v1/image/private/get', body, session().account);
    if (generation !== imageQueryGeneration || type !== imageType.value) return;
    if (!Array.isArray(data)) throw new Error('镜像列表结构发生变化');
    images = type === 'base'
      ? flattenImages(data)
      : data.map(i => ({
          type: 'private',
          uuid: i.image_uuid,
          name: i.name || i.image_uuid,
          chip_corp: i.chip_corp,
          cpu_arch: i.cpu_arch,
          cuda: i.cuda_v
        }));
    images = images.map(i => ({ ...i, chip_corp: i.chip_corp || gpus[0].chip_corp, cpu_arch: i.cpu_arch || gpus[0].cpu_arch }));
    imageSelect.replaceChildren(
      el('option', { value: '' }, images.length ? '请选择镜像' : '没有可用镜像'),
      ...images.map(i => el('option', { value: i.uuid }, i.name))
    );
    refreshNewForm();
  }

  const minimumDriverField = label('最低驱动版本', driverValue);
  const filtersFields = el(
    'fieldset',
    {},
    el('div', { class: 'grid' }, label('每个实例 GPU 数量', gpuCount), label('实例最低内存（GB，0 不限制）', minMemory)),
    el('div', { class: 'grid' }, label('实例 CPU 至少（核，0 不限制）', minCpu), label('每卡 CPU 至少（核，0 不限制）', minCpuPerGpu)),
    el('div', { class: 'grid' }, label('折后单卡最低价（元/小时，0 不限制）', minGpuPrice), label('折后单卡最高价（元/小时，0 不限制）', maxGpuPrice)),
    label('显卡驱动筛选', driverMode),
    driverHint,
    minimumDriverField,
    driverExact,
    el('div', { class: 'grid' }, label('主机可扩容容量至少（GB）', minExpand), label('实际额外扩容（GB，0 使用基础盘）', expand)),
    newHostSelector.node
  );
  const imageFields = el('fieldset', {}, label('镜像来源', imageType), label('使用的镜像', imageSelect));

  const startNewButton = button('添加并启动新实例任务', safeAction(async () => {
    const image = images.find(i => i.uuid === imageSelect.value && i.type === imageType.value);
    const selectedGpus = gpuPicker.get();
    if (image && selectedGpus.some(g => g.chip_corp !== image.chip_corp || g.cpu_arch !== image.cpu_arch)) {
      throw new Error('GPU 架构已更改，请重新读取镜像');
    }
    const hostFilter = newHostSelector.getValues();
    const c = {
      gpus: selectedGpus.map(g => g.name),
      regions: regionPicker.get(),
      gpuCount: Number(gpuCount.value),
      driver: {
        mode: driverMode.value,
        value: driverMode.value === 'minimum' ? driverValue.value : driverMode.value === 'exact' ? [...exactVersions].join(',') : ''
      },
      minExpandGb: Number(minExpand.value),
      expandGb: Number(expand.value),
      minMemoryGb: Number(minMemory.value),
      minCpuCores: Number(minCpu.value),
      minCpuPerGpu: Number(minCpuPerGpu.value),
      minGpuPriceYuan: Number(minGpuPrice.value),
      maxGpuPriceYuan: Number(maxGpuPrice.value),
      ...hostFilter,
      image
    };
    validateNew(c);
    const account = session().account;
    if (!account) throw new Error('请先登录 AutoDL');
    const id = uid();
    await update(s => {
      s.tasks.push({
        id,
        marker: `ADLH-${id}`,
        kind: 'new',
        name: taskName.value.trim() || `新实例任务 ${s.tasks.length + 1}`,
        account,
        config: c,
        status: 'active',
        createdAt: Date.now(),
        nextAt: 0,
        message: '等待空闲 GPU'
      });
    });
    enableSound().catch(() => {});
    show('tasks');
    loop();
  }), 'primary');

  function refreshNewForm() {
    const hasGpu = gpuPicker.get().length > 0;
    filtersFields.disabled = !hasGpu;
    imageFields.disabled = !hasGpu;
    minimumDriverField.hidden = driverMode.value !== 'minimum';
    driverExact.hidden = driverMode.value !== 'exact';
    driverValue.disabled = driverMode.value !== 'minimum' || !driverVersions.length;
    startNewButton.disabled = !hasGpu || !imageSelect.value;
  }
  driverMode.addEventListener('change', refreshNewForm);

  views.new.append(
    el('p', { class: 'muted' }, '每个任务创建一个实例，可添加多个独立任务。支持指定目标主机 ID、GPU 型号优先级与折后单价区间。'),
    section(1, '选择地区', '地区自动加载，选择需要监控的机房。', regionPicker.node),
    section(2, '选择 GPU', '只展示所选地区中存在的型号。', gpuHint, gpuPicker.node),
    section(3, '设置筛选条件与目标服务器', '选择 GPU 后可设置卡数、内存、价格区间、驱动、扩容与目标主机 ID。', filtersFields),
    section(4, '选择镜像', '支持官方基础镜像和自己的私有镜像。', imageFields),
    section(5, '创建监控任务', '配置完成后自动监控，抢到一个实例即完成此任务。', label('任务名称', taskName), el('div', { class: 'section-footer' }, startNewButton))
  );
  refreshNewForm();

  // ─── 克隆目标筛选编辑器（含系统盘+数据盘、稀疏优化 ft_sparse、指定主机表格、折后价格限制） ───

  clonePanel.className = 'clone-filter-editor';
  let cloneScopeKey = '', cloneScopeGeneration = 0, cloneDriverGeneration = 0, cloneRegions = [], cloneScopeReady = false;
  const cloneScopeHint = el('p', { class: 'muted' }, '先选择源实例，自动加载其所在地区的 GPU 与主机。');
  const cloneDriverHint = el('p', { class: 'muted' }, '选择目标 GPU 后自动加载已有驱动与同地区候选服务器列表。');
  const cloneCount = input('number', 1, { min: 1, step: 1 });
  const cloneMemory = input('number', 0, { min: 0, step: 'any' });
  const cloneMaxPrice = input('number', 0, { min: 0, step: '0.001' });
  const cloneMinExpand = input('number', 0, { min: 0, step: 1 });
  const cloneExpand = input('number', 0, { min: 0, step: 1 });
  const cloneFtSparse = input('checkbox', '', { checked: false });
  const cloneHostSelector = createHostSelector('克隆');

  const cloneDriverMode = el(
    'select',
    {},
    el('option', { value: 'any' }, '不限制'),
    el('option', { value: 'minimum' }, '最低版本'),
    el('option', { value: 'exact' }, '指定版本')
  );
  const cloneDriverMinimum = el('select', {}, el('option', { value: '' }, '选择 GPU 后自动加载'));
  const cloneDriverExact = el('div', { class: 'driver-choices', hidden: true });
  const cloneExactVersions = new Set();
  const cloneMinimumField = label('克隆最低驱动版本', cloneDriverMinimum);

  function updateCloneDriverMode() {
    cloneMinimumField.hidden = cloneDriverMode.value !== 'minimum';
    cloneDriverExact.hidden = cloneDriverMode.value !== 'exact';
  }
  cloneDriverMode.addEventListener('change', updateCloneDriverMode);

  const cloneGpuPicker = orderedPicker('目标 GPU · 多选，↑↓调整优先级', () => {
    cloneDriverGeneration++;
    cancelAuto('clone-drivers');
    cloneExactVersions.clear();
    cloneHostSelector.reset();
    cloneDriverMinimum.replaceChildren(el('option', { value: '' }, '选择 GPU 后自动加载'));
    cloneDriverExact.replaceChildren();
    if (cloneGpuPicker.get().length) autoLoad('clone-drivers', loadCloneDrivers);
    cloneDriverHint.textContent = cloneGpuPicker.get().length
      ? '正在加载目标 GPU 的驱动与同地区服务器列表…'
      : '选择目标 GPU 后自动加载已有驱动与同地区服务器列表。';
  });

  async function loadCloneDrivers() {
    const gpus = cloneGpuPicker.get().map(g => g.name);
    if (!gpus.length || !cloneScopeReady) return;
    const generation = ++cloneDriverGeneration, account = session().account;
    const rows = await api.machines({ gpus, regions: cloneRegions, gpuCount: 1 }, account, true);
    if (generation !== cloneDriverGeneration || account !== session().account) return;
    const regionalRows = rows.filter(r => gpus.includes(r.gpu_name) && cloneRegions.some(region => region.signs.includes(r.region_sign)));
    const versions = availableDrivers(regionalRows);
    cloneHostSelector.setMachines(regionalRows);
    cloneDriverMinimum.replaceChildren(
      el('option', { value: '' }, '请选择最低驱动版本'),
      ...versions.map(v => el('option', { value: v }, v))
    );
    cloneDriverExact.replaceChildren(...versions.map(v => el(
      'label',
      { class: 'check' },
      input('checkbox', '', {
        onchange: e => {
          if (e.target.checked) cloneExactVersions.add(v);
          else cloneExactVersions.delete(v);
        }
      }),
      v
    )));
    cloneDriverHint.textContent = versions.length
      ? `已加载同地区 ${regionalRows.length} 台主机、${versions.length} 个驱动版本（含当前 0 空闲卡机器，可在下方表格点击 [+指定] 锁定目标主机）。`
      : '暂无有效驱动版本，可选择“不限制”。';
  }

  function refreshCloneEditor() {
    const isCloning = existingMode.value === 'clone' || existingMode.value === 'clone_only';
    clonePanel.hidden = !isCloning;
    const rows = [...selectedInstances.values()];
    const key = clonePanel.hidden ? '' : `${session().account}|${rows.map(r => `${r.uuid}:${r.region_sign}`).sort().join('|')}`;
    if (key === cloneScopeKey) return;
    cloneScopeKey = key;
    cloneScopeGeneration++;
    cloneScopeReady = false;
    cancelAuto('clone-gpus');
    cloneGpuPicker.setOptions([]);
    cloneHostSelector.reset();
    cloneRegions = [];
    if (clonePanel.hidden || !rows.length) {
      cloneScopeHint.textContent = '请先选择源实例，地区固定为源实例地区。';
      return;
    }
    cloneScopeHint.textContent = '正在自动加载源实例地区的 GPU…';
    autoLoad('clone-gpus', loadCloneGpus);
  }

  async function loadCloneGpus() {
    const generation = cloneScopeGeneration, account = session().account, sources = [...selectedInstances.values()];
    if (!sources.length || clonePanel.hidden) return;
    const regions = groupRegions(await api.regions(account));
    const selected = sources.map(source => regions.find(r => r.signs.includes(source.region_sign)));
    if (selected.some(r => !r)) throw new Error('无法确定源实例地区，暂不允许克隆');
    const uniqueRegions = [...new Map(selected.map(r => [r.id, r])).values()];
    const [catalog, ...regional] = await Promise.all([
      api.call('/api/v1/machine/gpu_type', undefined, account),
      ...uniqueRegions.map(r => api.call('/api/v1/machine/region/gpu_type', { region_sign_list: r.signs }, account))
    ]);
    if (generation !== cloneScopeGeneration || account !== session().account) return;
    const common = regional.map(rows => new Set(regionalGpuOptions(rows, catalog).map(g => g.id)));
    cloneRegions = uniqueRegions;
    cloneScopeReady = true;
    cloneGpuPicker.setOptions(catalog.filter(g => common.every(set => set.has(g.gpu_name))).map(g => ({ ...g, id: g.gpu_name, name: g.gpu_name })));
    cloneScopeHint.textContent = `地区固定：${uniqueRegions.map(r => r.name).join('、')}。${common.length > 1 ? '仅列出各源地区共同支持的卡型；每个任务在自己的源地区克隆。' : '可选择该地区的任意卡型（如 RTX 5090 / 4090），暂时无空闲卡的主机也能指定监控。'}`;
  }

  function readCloneFilters() {
    if (!cloneScopeReady) throw new Error('请等待克隆目标卡型加载完成');
    const hostFilter = cloneHostSelector.getValues();
    const c = {
      gpus: cloneGpuPicker.get().map(g => g.name),
      gpuCount: Number(cloneCount.value),
      driver: {
        mode: cloneDriverMode.value,
        value: cloneDriverMode.value === 'minimum'
          ? cloneDriverMinimum.value
          : cloneDriverMode.value === 'exact'
            ? [...cloneExactVersions].join(',')
            : ''
      },
      minExpandGb: Number(cloneMinExpand.value),
      expandGb: Number(cloneExpand.value),
      minMemoryGb: Number(cloneMemory.value),
      maxGpuPriceYuan: Number(cloneMaxPrice.value),
      ftSparse: cloneFtSparse.checked,
      ...hostFilter
    };
    validateNew({ ...c, regions: cloneRegions, image: { uuid: 'source-instance' } });
    return c;
  }

  clonePanel.append(
    section(
      null,
      '克隆目标服务器与数据盘配置',
      '固定同时克隆【系统盘 + 数据盘】（源实例保留且不清理数据）。可更换目标 GPU 型号、卡数，并支持指定要抢的目标主机 ID。',
      cloneScopeHint,
      cloneGpuPicker.node,
      el('div', { class: 'grid' }, label('克隆 GPU 数量', cloneCount), label('克隆实例最低内存（GB，0 不限制）', cloneMemory)),
      el('div', { class: 'grid' }, label('克隆折后单卡最高价（元/小时，0 不限制）', cloneMaxPrice), el('label', { class: 'check', style: 'margin-top:24px' }, cloneFtSparse, '优化稀疏文件拷贝 (ft_sparse)')),
      label('克隆显卡驱动筛选', cloneDriverMode),
      cloneDriverHint,
      cloneMinimumField,
      cloneDriverExact,
      el('div', { class: 'grid' }, label('克隆主机可扩容容量至少（GB）', cloneMinExpand), label('克隆实际额外扩容（GB）', cloneExpand)),
      cloneHostSelector.node,
      el('p', { class: 'muted' }, '始终复制系统盘和数据盘。若所选扩容小于源实例系统+数据盘所需容量，会自动补齐目标盘扩容。')
    )
  );
  updateCloneDriverMode();

  // ─── 视图 3：全局设置 ───

  const settings = read().settings;
  const interval = input('number', settings.intervalSeconds, { min: MIN_INTERVAL_SECONDS, step: 1 });
  const sshAliasInput = input('text', settings.sshAlias || 'autodl', { placeholder: '默认 autodl' });
  const sound = input('checkbox', '', { checked: settings.sound });
  const desktop = input('checkbox', '', { checked: settings.desktop });
  const server = input('checkbox', '', { checked: settings.serverChan });
  const sendKey = input('password', settings.sendKey, { placeholder: '可选，填写 Server酱 SendKey', autocomplete: 'off' });

  views.settings.append(
    section(null, '监控频率与 SSH 配置', '所有任务共用一个检查间隔。',
      el('div', { class: 'grid' },
        label('全局检查间隔（秒，最小 1，默认 10）', interval),
        label('SSH Config 主机别名（用于生成切流配置）', sshAliasInput)
      )
    ),
    section(null, '本地提醒', '首次点击“测试提醒”解锁声音；浏览器可能限制后台定时器和声音。',
      el('label', { class: 'check' }, sound, '提示音'),
      el('label', { class: 'check' }, desktop, '浏览器桌面通知')
    ),
    section(null, '微信通知 · 可选', 'SendKey 只保存在本机油猴存储中。请到 Server酱后台绑定微信推送渠道。',
      el('label', { class: 'check' }, server, '启用 Server酱微信通知（可选）'),
      label('Server酱 SendKey', sendKey)
    ),
    el(
      'div',
      { class: 'bar' },
      button('保存设置', safeAction(async () => {
        const n = Number(interval.value);
        if (!Number.isInteger(n) || n < MIN_INTERVAL_SECONDS) throw new Error(`检查间隔应为至少 ${MIN_INTERVAL_SECONDS} 秒的整数`);
        if (server.checked) serverChanUrl(sendKey.value.trim());
        await update(s => {
          s.settings = {
            intervalSeconds: n,
            sshAlias: sshAliasInput.value.trim() || 'autodl',
            sound: sound.checked,
            desktop: desktop.checked,
            serverChan: server.checked,
            sendKey: sendKey.value.trim()
          };
          s.nextCycleAt = 0;
        });
        notice('设置已保存');
        loop();
      }), 'primary'),
      button('测试提醒', safeAction(async () => {
        if (sound.checked) await beep();
        if (desktop.checked) GM_notification({ title: NAME, text: '测试提醒：通知已启用', timeout: 8000 });
        if (server.checked) await sendServer(sendKey.value.trim(), `${NAME}测试`, 'Server酱可选通知已连接');
        notice('测试提醒已发送');
      }))
    )
  );

  show('tasks');
  loop();
  if (session().token) {
    autoLoad('regions', loadRegions, 0);
    autoLoad('instances', loadInstances, 0);
  }
})();
