#!/usr/bin/env node
/**
 * 前端跨运行异步链回归测试（无需浏览器 / 第三方依赖，Node >= 18 自带 test runner）。
 *
 * 运行：
 *   node --test test_frontend_races.mjs
 *
 * 背景缺陷：/api/state 与 /api/pauses 是两次独立请求，而 400ms 的
 * setInterval 不会等待在途轮询，因此上一轮可能留下两个并行的旧轮询：
 *
 *   轮询 A：旧 /api/state（终态）已返回，正在等待“服务端早已生成 200”
 *           的旧 /api/pauses 历史响应；
 *   轮询 B：先整体完成；随后用户重跑获准（归属切换、旧历史清空）；
 *   轮询 A：此时才返回 —— 旧代码只在请求发出前比对过 run_id，于是把上一轮
 *           的停顿与终态写进新运行页面：渲染旧历史、stopPolling() 停掉新
 *           轮询、setRunningUI(false) 解除源码只读并启用终止。
 *
 * 同样，重跑前发出的 step/continue/terminate 的迟到响应会写提示、安排
 * 额外轮询。修复方式：页面维护单调递增的“运行归属代号”（runGen），仅在
 * 获准启动时 +1；每条异步链在发起时捕获代号，并在每个 await 之后重新
 * 核对，归属已变即整条丢弃（不渲染、不写历史、不动轮询与按钮、不发提示）；
 * 同一运行内并行轮询再按发起序号采纳，丢弃乱序的旧响应。
 *
 * 本文件用可控的响应顺序（手动放行的 deferred fetch + 假定时器）精确复现：
 *   1. 旧历史 /api/pauses 在重跑获准后才返回，不得污染新运行；
 *   2. 旧 /api/state 在重跑获准后才返回（run_id 已不匹配），同样丢弃；
 *   3. 旧终止响应（成功与失败 409）在重跑后返回，不得改新运行、不追加轮询；
 *   4. 旧步进 409 在重跑后返回，不得覆盖提示、不安排额外轮询；
 *   5. 启动被拒绝时保留当前回看（视图/列表/只读/按钮都不动）；
 *   6. 同一运行内两个并行轮询的历史响应乱序到达，旧的那份不得覆盖新的；
 *   7. 当前运行的正常轮询、历史选择、返回实时前刷新、终止仍然可用。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = fs.readFileSync(path.join(HERE, "static", "app.js"), "utf8");

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 连续排空若干轮微任务（fetch().then -> await res.json() 链有多跳）。
async function drain(n = 8) {
  for (let i = 0; i < n; i++) await flush();
}

// ---- 极简 DOM ------------------------------------------------------------

class ClassList {
  constructor(el) { this._el = el; this._set = new Set((el._cls || "").split(/\s+/).filter(Boolean)); }
  add(...names) { names.forEach((n) => this._set.add(n)); this._sync(); }
  remove(...names) { names.forEach((n) => this._set.delete(n)); this._sync(); }
  toggle(name, force) {
    const on = force === undefined ? !this._set.has(name) : !!force;
    this._set[on ? "add" : "delete"](name);
    this._sync();
    return on;
  }
  contains(name) { return this._set.has(name); }
  _sync() { this._el._cls = [...this._set].join(" "); }
}

class El {
  constructor(id, tag = "div") {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this._cls = "";
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this._value = "";
    this._text = "";
    this.disabled = false;
    this.hidden = false;
    this.readOnly = false;
  }
  get classList() { return new ClassList(this); }
  get className() { return this._cls; }
  set className(v) { this._cls = v || ""; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(event) {
    (this.listeners[event.type] || []).slice().forEach((fn) => fn.call(this, event));
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
  }
  querySelector(sel) {
    const tag = sel.replace(/[<>]/g, "").trim();
    return this.children.find((c) => c.tagName === tag.toUpperCase()) || null;
  }
  get value() { return this._value; }
  set value(v) {
    this._value = v == null ? "" : String(v);
    if (this.tagName === "SELECT") {
      // 真实 select：无匹配 option 时赋值会被忽略
      const match = this.children.some((o) => String(o.value) === this._value);
      if (!match && this._value !== "") this._value = "";
    }
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = v == null ? "" : String(v);
  }
}

// ---- 每个用例一个全新页面环境 ---------------------------------------------

function makeEnv() {
  const env = { requests: [], intervals: new Map(), timeouts: [], timers: [] };
  let nextHandle = 1;

  const ids = [
    "status", "code", "examples", "line-count", "btn-run", "btn-step",
    "btn-continue", "btn-terminate", "message", "history", "history-banner",
    "btn-back-live", "listing", "locals", "stdout", "exception",
  ];
  const byId = new Map();
  ids.forEach((id) => byId.set(id, new El(id)));
  byId.get("locals").appendChild(new El("tbody", "tbody"));
  byId.get("code").value = "x = 1\nprint(x)\n";

  const document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new El("", tag),
  };

  function fakeFetch(url, options = {}) {
    const rec = {
      url,
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null,
      at: env.requests.length,
    };
    env.requests.push(rec);
    return new Promise((resolve, reject) => {
      rec.settle = (value) => {
        rec.settled = true;
        if (value instanceof Error) {
          reject(value);
        } else {
          const body = typeof value.body === "string" ? value.body : JSON.stringify(value.body);
          resolve({ ok: value.status >= 200 && value.status < 300, status: value.status,
                    json: () => Promise.resolve(JSON.parse(body)) });
        }
      };
      if (rec._auto) rec.settle(rec._auto);
    });
  }
  env.fetch = fakeFetch;

  env.setInterval = (fn, ms) => {
    const handle = nextHandle++;
    env.intervals.set(handle, { fn, ms });
    return handle;
  };
  env.clearInterval = (handle) => { env.intervals.delete(handle); };
  env.setTimeout = (fn, ms) => {
    const handle = nextHandle++;
    env.timeouts.push({ handle, fn, ms });
    return handle;
  };
  env.clearTimeout = (handle) => {
    const i = env.timeouts.findIndex((t) => t.handle === handle);
    if (i >= 0) env.timeouts.splice(i, 1);
  };

  const sandbox = {
    console,
    document,
    fetch: env.fetch,
    setInterval: env.setInterval,
    clearInterval: env.clearInterval,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    Promise,
    JSON,
    String,
    Object,
    encodeURIComponent,
    MAX_LINES: 80,
  };
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: "app.js" });
  env.byId = byId;
  env.$ = (id) => byId.get(id);

  env.click = (id, event = {}) => env.$(id).dispatch({ type: "click", ...event });
  env.change = (id, value) => {
    const el = env.$(id);
    el.value = value;
    el.dispatch({ type: "change", target: el });
  };
  // 触发一次 interval 回调，但只排空微任务到“挂起等待 fetch”为止：轮询的
  // promise 要等其 state/pauses 都放行后才解决，测试需要它保持在途。
  env.tickInterval = async () => {
    const [entry] = env.intervals.values();
    assert.ok(entry, "no active poll interval");
    entry.fn();
    await drain();
  };
  env.findReq = (predicate) => env.requests.find(predicate);
  env.allReq = (predicate) => env.requests.filter(predicate);
  env.settle = (predicate, value) => {
    const rec = env.findReq((r) => !r.settled && predicate(r));
    assert.ok(rec, `no pending request matches ${predicate}`);
    rec.settle(value);
  };
  env.stateResp = (runId, overrides = {}) => ({
    status: 200,
    body: {
      run_id: runId,
      status: "paused",
      pause_seq: 1,
      current_line: 1,
      locals: {},
      stdout: "",
      stdout_truncated: false,
      exception: null,
      lines: ["x = 1", "print(x)"],
      ...overrides,
    },
  });
  env.pausesResp = (runId, pauses) => ({ status: 200, body: { run_id: runId, pauses } });

  return env;
}

function currentRows(env) {
  // 高亮行 gutter 文本为 “→ ” + 补空格后的行号（如 “→  1”），统一取箭头标记
  return env.$("listing").children
    .filter((row) => row.classList.contains("current"))
    .map((row) => row.children[0].textContent.replace(/\s+/g, " ").trim());
}
function optionValues(env) {
  return env.$("history").children.map((o) => o.value);
}
function historyOptions(env) {
  return env.$("history").children.slice(1).map((o) => o.textContent);
}

// ---- 1. 旧历史响应在重跑获准后才返回：不得污染新运行 ----------------------

test("两次旧轮询并行：A1 已取得终态、其历史查询等待已生成 200；A2 先完成；重跑获准后 A1 才返回", async () => {
  const env = makeEnv();

  // 旧运行 A：启动并经历一次暂停（下拉里已有停顿 #1）
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run", { status: 200, body: { run_id: "A" } });
  await drain();
  env.settle((r) => r.url === "/api/state", env.stateResp("A"));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses"),
             env.pausesResp("A", [{ pause_seq: 1, current_line: 1, locals: {},
                                    stdout: "", stdout_truncated: false }]));
  await drain();

  // 两个旧轮询并行在途（400ms interval 不等待在途轮询）
  await env.tickInterval(); // A1
  await env.tickInterval(); // A2

  // A1 先取得终态：state（terminated）先放行，其历史查询随后发出并在服务端
  // 生成 200，但该响应一直挂起（模拟“等待已生成200响应的历史查询”）。
  const a1State = env.allReq((r) => r.url === "/api/state").slice(-2)[0];
  const a2State = env.allReq((r) => r.url === "/api/state").slice(-1)[0];
  a1State.settle(env.stateResp("A", { status: "terminated", current_line: 2 }));
  await drain();
  const a1Pauses = env.allReq((r) => r.url.startsWith("/api/pauses")).slice(-1)[0];
  assert.ok(a1Pauses && !a1Pauses.settled, "A1 的历史查询应已发出且挂起");

  // 另一次旧轮询 A2 先整体完成（终态 state + 终态历史）
  a2State.settle(env.stateResp("A", { status: "terminated", current_line: 2 }));
  await drain();
  const a2Pauses = env.allReq(
    (r) => r.url.startsWith("/api/pauses") && !r.settled).find((r) => r.at > a1Pauses.at);
  assert.ok(a2Pauses, "A2 应已发出自己的历史查询（晚于 A1）");
  a2Pauses.settle(env.pausesResp("A", [{ pause_seq: 1, current_line: 1, locals: {},
    stdout: "", stdout_truncated: false }]));
  await drain();
  // A2 的终态收尾停止了 A 的 interval；但 A1 仍卡在历史查询上
  assert.equal(env.intervals.size, 0, "A2 终态应停止 A 的轮询");
  assert.equal(env.$("status").textContent, "已终止");
  assert.equal(env.$("code").readOnly, false);
  assert.equal(env.allReq((r) => r.url.startsWith("/api/pauses") && !r.settled).length,
               1, "只有 A1 的旧历史查询还在途");

  // 用户启动的新运行 B 获准（此时 A1 的历史响应仍未返回）
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run" && !r.settled,
             { status: 200, body: { run_id: "B" } });
  await drain();
  assert.equal(env.$("code").readOnly, true, "获准重跑后源码应恢复只读");
  assert.equal(env.$("btn-terminate").disabled, false);
  assert.equal(env.intervals.size, 1, "新运行 B 应启动自己的轮询");
  assert.deepEqual(optionValues(env), [""], "获准重跑应清空旧历史下拉");
  assert.equal(env.$("message").textContent, "");

  // B1 轮询在途：先放行 B1 的 state，随后 B1 发出自己的历史查询；
  // A1 那个等待已久、服务端早已生成 200 的旧历史仍挂着。
  env.settle((r) => r.url === "/api/state" && !r.settled,
             env.stateResp("B", { current_line: 1, pause_seq: 1 }));
  await drain();
  const pendingAfterBState = env.allReq(
    (r) => r.url.startsWith("/api/pauses") && !r.settled);
  assert.equal(pendingAfterBState.length, 2, "A1 旧历史与 B1 历史应都在途");
  const b1Pauses = pendingAfterBState.find((r) => r.at > a1Pauses.at);
  assert.ok(b1Pauses, "B1 应已发出自己的历史查询（晚于 A1）");

  // B1 的历史先返回并采纳：页面切到 B 的 paused
  b1Pauses.settle(env.pausesResp("B", [{ pause_seq: 1, current_line: 1, locals: {},
    stdout: "", stdout_truncated: false }]));
  await drain();
  assert.equal(env.$("status").textContent, "已暂停");
  assert.deepEqual(currentRows(env), ["→ 1"]);
  assert.deepEqual(historyOptions(env), ["停顿 #1（第 1 行）"]);

  // 前一次旧轮询 A1 此时才返回（旧 run_id、旧停顿与终态配套的历史）——
  // 必须被整条丢弃：不得改动 B 的历史、状态、提示、轮询或按钮。
  a1Pauses.settle(env.pausesResp("A", [{ pause_seq: 1, current_line: 9,
    locals: { old: "'old'" }, stdout: "OLD", stdout_truncated: false }]));
  await drain();

  assert.deepEqual(optionValues(env), ["", "1"], "旧历史不得覆盖新运行的历史");
  assert.equal(env.$("stdout").textContent, "", "旧 stdout 不得渲染到新运行");
  assert.equal(env.intervals.size, 1, "旧轮询的收尾不得停止新运行的轮询");
  assert.equal(env.$("code").readOnly, true, "旧轮询不得解除源码只读");
  assert.equal(env.$("btn-terminate").disabled, false, "旧轮询不得禁用终止");
  assert.equal(env.$("btn-run").disabled, true);
  assert.equal(env.$("btn-step").disabled, false, "B 已暂停，单步应可用");
  assert.equal(env.$("btn-continue").disabled, false, "B 已暂停，继续应可用");
  assert.equal(env.$("status").textContent, "已暂停", "状态徽标应保持 B 的 paused");
  assert.deepEqual(currentRows(env), ["→ 1"]);
});

// ---- 2. 旧 /api/state 在重跑获准后才返回（run_id 已不匹配） ---------------

test("旧 /api/state 在重跑获准之后才返回：gen 与 run_id 双重丢弃，不渲染不查历史", async () => {
  const env = makeEnv();
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run", { status: 200, body: { run_id: "A" } });
  await drain();
  // A1：state 挂起（pauses 尚未发出）
  assert.equal(env.allReq((r) => r.url === "/api/state").length, 1);

  // 直接重跑：A 还在活动态，服务端会 409 —— 但本用例模拟“旧轮询延迟返回”
  // 的真实窗口（A 刚终态），因此先让一个快速轮询把 A 收掉并不必要；直接放行
  // 第二个 /api/run 为 B 获准即可（前端不预判冲突）。
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run" && !r.settled,
             { status: 200, body: { run_id: "B" } });
  await drain();
  const pausesBefore = env.allReq((r) => r.url.startsWith("/api/pauses")).length;

  // 此时 A1 的旧 state 才返回（终态、旧 run_id）：必须丢弃
  env.settle((r) => r.url === "/api/state" && !r.settled,
             env.stateResp("A", { status: "finished", current_line: 7 }));
  await drain();
  assert.equal(env.allReq((r) => r.url.startsWith("/api/pauses")).length, pausesBefore,
               "被丢弃的旧 state 不得再发起 /api/pauses");
  assert.equal(env.intervals.size, 1, "旧 state 不得停掉 B 的轮询");
  assert.equal(env.$("code").readOnly, true);
  assert.equal(env.$("btn-terminate").disabled, false);
  assert.deepEqual(optionValues(env), [""]);

  // B1 正常完成
  env.settle((r) => r.url === "/api/state" && !r.settled, env.stateResp("B"));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses") && !r.settled,
             env.pausesResp("B", [{ pause_seq: 1, current_line: 1, locals: {},
                                    stdout: "", stdout_truncated: false }]));
  await drain();
  assert.deepEqual(currentRows(env), ["→ 1"]);
  assert.deepEqual(historyOptions(env), ["停顿 #1（第 1 行）"]);
});

// ---- 3. 旧终止响应在重跑后返回：成功/失败都不得改新运行 --------------------

async function setupOldControl(env, oldId) {
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run", { status: 200, body: { run_id: oldId } });
  await drain();
  env.settle((r) => r.url === "/api/state", env.stateResp(oldId));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses"), env.pausesResp(oldId, [
    { pause_seq: 1, current_line: 1, locals: {}, stdout: "", stdout_truncated: false },
  ]));
  await drain();
}

test("旧终止成功响应在重跑获准后返回：不提示/不追加轮询/不动按钮", async () => {
  const env = makeEnv();
  await setupOldControl(env, "A");
  env.click("btn-terminate");
  await drain();
  const termReq = env.findReq((r) => r.url === "/api/terminate");
  assert.ok(termReq && !termReq.settled);

  // 重跑 B 获准（旧 terminate 仍在途）
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run" && !r.settled,
             { status: 200, body: { run_id: "B" } });
  await drain();
  env.settle((r) => r.url === "/api/state" && !r.settled, env.stateResp("B"));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses") && !r.settled,
             env.pausesResp("B", [{ pause_seq: 1, current_line: 1, locals: {},
                                    stdout: "", stdout_truncated: false }]));
  await drain();
  const stateReqsBefore = env.allReq((r) => r.url === "/api/state").length;

  // 旧 terminate 200 姗姗来迟
  env.settle((r) => r === termReq, { status: 200, body: { ok: true, status: "terminated" } });
  await drain();
  assert.equal(env.$("message").textContent, "", "旧终止成功不得写提示");
  assert.equal(env.intervals.size, 1, "不得停掉 B 的轮询");
  assert.equal(env.$("code").readOnly, true, "不得解除 B 的源码只读");
  assert.equal(env.$("btn-terminate").disabled, false);
  assert.equal(env.allReq((r) => r.url === "/api/state").length, stateReqsBefore,
               "旧终止响应不得追加 /api/state 轮询");
  assert.deepEqual(currentRows(env), ["→ 1"]);
});

test("旧终止 409 在重跑获准后返回：不得把错误提示写到新运行", async () => {
  const env = makeEnv();
  await setupOldControl(env, "A");
  env.$("message").textContent = ""; // 正常流程无提示
  env.click("btn-terminate");
  await drain();
  const termReq = env.findReq((r) => r.url === "/api/terminate");

  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run" && !r.settled,
             { status: 200, body: { run_id: "B" } });
  await drain();

  termReq.settle({ status: 409, body: { error: "运行不存在或已过期" } });
  await drain();
  assert.equal(env.$("message").textContent, "", "旧终止 409 不得覆盖新运行提示");
  assert.equal(env.intervals.size, 1);
  assert.equal(env.$("code").readOnly, true);
});

// ---- 4. 旧步进 409 在重跑后返回：不覆盖提示、不安排额外轮询 ---------------

test("旧步进 409 在重跑获准后返回：不写错误提示、不安排额外刷新", async () => {
  const env = makeEnv();
  await setupOldControl(env, "A");
  env.click("btn-step");
  await drain();
  const stepReq = env.findReq((r) => r.url === "/api/step");
  assert.ok(stepReq && !stepReq.settled);
  assert.equal(env.allReq((r) => r.method === "POST" && r.url === "/api/step").length, 1);

  // 重跑 B 获准
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run" && !r.settled,
             { status: 200, body: { run_id: "B" } });
  await drain();
  const timeoutsBefore = env.timeouts.length;

  // 旧 step 409 返回：不得安排新的 state 请求（gen 失效后直接返回）
  stepReq.settle({ status: 409, body: { error: "重复或过期的请求，已拒绝且未推进" } });
  await drain();
  assert.equal(env.$("message").textContent, "", "旧步进 409 不得写新运行提示");
  assert.equal(env.intervals.size, 1);
  assert.equal(env.$("code").readOnly, true);
  assert.equal(env.$("btn-terminate").disabled, false);
  assert.equal(env.timeouts.length, timeoutsBefore, "旧步进不得安排 60ms 刷新");
});

// ---- 5. 启动被拒绝：保留当前回看 ------------------------------------------

test("启动被拒绝（409）：保留历史视图、只读与按钮，不清空历史", async () => {
  const env = makeEnv();
  await setupOldControl(env, "A");
  // 进入停顿 #1 的历史回看
  env.change("history", "1");
  await drain();
  assert.equal(env.$("history-banner").hidden, false);
  assert.equal(env.$("btn-step").disabled, true);
  assert.equal(env.$("btn-continue").disabled, true);
  assert.deepEqual(historyOptions(env), ["停顿 #1（第 1 行）"]);

  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run" && !r.settled,
             { status: 409, body: { error: "已有未结束的运行，请先终止或等待其结束" } });
  await drain();

  assert.equal(env.$("message").textContent, "已有未结束的运行，请先终止或等待其结束");
  assert.equal(env.$("history-banner").hidden, false, "拒绝启动不得退出回看");
  assert.equal(env.$("history").value, "1");
  assert.deepEqual(historyOptions(env), ["停顿 #1（第 1 行）"], "拒绝启动不得清空历史");
  assert.equal(env.$("code").readOnly, true);
  assert.equal(env.$("btn-terminate").disabled, false);
  assert.equal(env.intervals.size, 1, "拒绝启动不得重启轮询");
});

// ---- 6. 同运行并行轮询乱序：旧历史响应不得覆盖新历史 ----------------------

test("同一运行内两个并行轮询的 /api/pauses 乱序到达：先采纳新的，旧的那份丢弃", async () => {
  const env = makeEnv();
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run", { status: 200, body: { run_id: "A" } });
  await drain();

  // 轮询 1：state1(paused seq1) 返回，pauses1 挂起
  env.settle((r) => r.url === "/api/state",
             env.stateResp("A", { pause_seq: 1, current_line: 1 }));
  await drain();
  const pauses1 = env.findReq((r) => r.url.startsWith("/api/pauses") && !r.settled);

  // 轮询 2 并行（interval 触发）
  await env.tickInterval();
  // 轮询 2 先整体完成：state2(paused seq2) + pauses2（含两条停顿）
  env.settle((r) => r.url === "/api/state" && !r.settled,
             env.stateResp("A", { pause_seq: 2, current_line: 2, locals: { x: "1" } }));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses") && r !== pauses1,
             env.pausesResp("A", [
               { pause_seq: 1, current_line: 1, locals: {}, stdout: "", stdout_truncated: false },
               { pause_seq: 2, current_line: 2, locals: { x: "1" }, stdout: "", stdout_truncated: false },
             ]));
  await drain();
  assert.deepEqual(optionValues(env), ["", "1", "2"]);
  assert.deepEqual(currentRows(env), ["→ 2"]);

  // 用户正回看 #2；此时轮询 1 的旧历史（只含 seq1）才返回
  env.change("history", "2");
  await drain();
  assert.equal(env.$("history-banner").hidden, false);
  pauses1.settle(env.pausesResp("A", [
    { pause_seq: 1, current_line: 1, locals: {}, stdout: "STALE", stdout_truncated: false },
  ]));
  await drain();

  assert.deepEqual(optionValues(env), ["", "1", "2"], "旧轮询不得淘汰/覆盖 #2");
  assert.equal(env.$("stdout").textContent, "", "旧历史的 stdout 不得覆盖当前回看");
  assert.equal(env.$("history").value, "2", "仍停留在所选历史停顿");
  assert.equal(env.$("history-banner").hidden, false);
  assert.equal(env.intervals.size, 1);
});

// ---- 7. 当前运行的正常链路仍然可用 ----------------------------------------

test("正常链路：轮询、历史选择、返回实时前刷新、终态停止、再重跑", async () => {
  const env = makeEnv();
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run", { status: 200, body: { run_id: "A" } });
  await drain();
  env.settle((r) => r.url === "/api/state",
             env.stateResp("A", { pause_seq: 1, current_line: 1 }));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses"), env.pausesResp("A", [
    { pause_seq: 1, current_line: 1, locals: {}, stdout: "", stdout_truncated: false },
  ]));
  await drain();
  assert.deepEqual(currentRows(env), ["→ 1"]);
  assert.equal(env.$("btn-step").disabled, false);
  assert.equal(env.$("btn-continue").disabled, false);

  // 选择历史停顿 #1：进入回看，步进/继续禁用
  env.change("history", "1");
  assert.equal(env.$("history-banner").hidden, false);
  assert.equal(env.$("btn-step").disabled, true);
  assert.equal(env.$("btn-continue").disabled, true);

  // 返回实时视图：先拉取最新状态（seq2）再启用控制
  env.click("btn-back-live");
  await drain();
  env.settle((r) => r.url === "/api/state" && !r.settled,
             env.stateResp("A", { pause_seq: 2, current_line: 2, locals: { x: "1" } }));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses") && !r.settled, env.pausesResp("A", [
    { pause_seq: 1, current_line: 1, locals: {}, stdout: "", stdout_truncated: false },
    { pause_seq: 2, current_line: 2, locals: { x: "1" }, stdout: "", stdout_truncated: false },
  ]));
  await drain();
  assert.equal(env.$("history-banner").hidden, true);
  assert.deepEqual(currentRows(env), ["→ 2"]);
  assert.equal(env.$("btn-step").disabled, false);
  assert.equal(env.$("btn-continue").disabled, false);

  // 终止：作用于当前运行，成功后轮询把终态带回来并收尾
  env.click("btn-terminate");
  await drain();
  env.settle((r) => r.url === "/api/terminate" && !r.settled,
             { status: 200, body: { ok: true, status: "terminated" } });
  await drain();
  env.settle((r) => r.url === "/api/state" && !r.settled,
             env.stateResp("A", { status: "terminated", current_line: 2 }));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses") && !r.settled, env.pausesResp("A", [
    { pause_seq: 1, current_line: 1, locals: {}, stdout: "", stdout_truncated: false },
    { pause_seq: 2, current_line: 2, locals: { x: "1" }, stdout: "", stdout_truncated: false },
  ]));
  await drain();
  assert.equal(env.intervals.size, 0, "终态后停止轮询");
  assert.equal(env.$("code").readOnly, false, "终态后源码可编辑");
  assert.equal(env.$("btn-terminate").disabled, true);
  assert.deepEqual(historyOptions(env), ["停顿 #1（第 1 行）", "停顿 #2（第 2 行）"],
                   "终态后历史仍可回看");

  // 再重跑：获准才清空旧历史并恢复只读
  env.click("btn-run");
  await drain();
  env.settle((r) => r.url === "/api/run", { status: 200, body: { run_id: "B" } });
  await drain();
  env.settle((r) => r.url === "/api/state" && !r.settled, env.stateResp("B"));
  await drain();
  env.settle((r) => r.url.startsWith("/api/pauses") && !r.settled,
             env.pausesResp("B", []));
  await drain();
  assert.equal(env.$("code").readOnly, true);
  assert.deepEqual(optionValues(env), [""], "获准重跑清空旧历史");
  assert.deepEqual(currentRows(env), ["→ 1"]);
  assert.equal(env.intervals.size, 1);
});
