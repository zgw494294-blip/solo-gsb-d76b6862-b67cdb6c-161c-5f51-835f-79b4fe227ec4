"use strict";

const $ = (id) => document.getElementById(id);

const EXAMPLES = {
  assign: `# 赋值示例
x = 1
y = 2
total = x + y
name = "alice"
msg = name + " has " + str(total) + " apples"
print(msg)`,

  func: `# 函数调用示例
def add(a, b):
    result = a + b
    return result

def main():
    x = add(3, 4)
    y = add(x, 10)
    print("y =", y)

main()`,

  loop: `# 循环示例
total = 0
for i in range(5):
    total += i
    print("i =", i, "total =", total)

n = 3
while n > 0:
    n -= 1
print("done", total)`,

  exc: `# 异常示例
def div(a, b):
    return a / b

values = [10, 5, 0]
for v in values:
    print("100 /", v, "=", div(100, v))
print("never reached")`,
};

const STATUS_TEXT = {
  idle: "空闲",
  running: "运行中",
  paused: "已暂停",
  finished: "已结束",
  exception: "异常终止",
  terminated: "已终止",
};

let runId = null;        // run id of the run this page is driving
let pauseSeq = 0;        // pause sequence number of the latest (live) pause
let pollTimer = null;
let liveState = null;    // latest /api/state snapshot for runId
let pauses = [];         // pause snapshots returned by /api/pauses (asc seq)
let viewingSeq = null;   // selected historical pause_seq, or null = live view
let historySig = "";     // dropdown contents signature, to avoid rebuilding

function inHistoryMode() {
  return viewingSeq !== null;
}

function showMessage(text) {
  $("message").textContent = text || "";
}

function updateLineCount() {
  const lines = $("code").value.split("\n").length;
  const el = $("line-count");
  el.textContent = `${lines} / ${MAX_LINES} 行`;
  el.classList.toggle("over", lines > MAX_LINES);
}

function setRunningUI(running) {
  $("code").readOnly = running;               // 运行期间源码只读
  $("examples").disabled = running;
  $("btn-run").disabled = running;
  $("btn-terminate").disabled = !running;
  if (running) {
    $("btn-step").disabled = true;
    $("btn-continue").disabled = true;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 400);
  poll();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function startRun() {
  showMessage("");
  const { ok, data } = await postJSON("/api/run", { code: $("code").value });
  if (!ok) {
    // 启动被拒绝（如活动运行冲突）：不清空既有停顿，也不切走当前视图
    showMessage(data.error || "启动失败");
    return;
  }
  runId = data.run_id;
  pauseSeq = 0;
  liveState = null;
  pauses = [];
  historySig = null;  // 强制下次重建下拉框，清掉上一个运行的停顿条目
  exitHistoryView();
  populateHistory();
  setRunningUI(true);
  startPolling();
}

async function control(kind) {
  if (!runId || inHistoryMode()) return;  // 历史模式禁用步进/继续
  // 同一次停顿只发一次；服务端也会拒绝重复/过期请求
  $("btn-step").disabled = true;
  $("btn-continue").disabled = true;
  const { ok, data } = await postJSON(`/api/${kind}`, {
    run_id: runId,
    pause_seq: pauseSeq,  // 始终用实时 pause_seq，绝不用历史序号推进
  });
  if (!ok) {
    showMessage(data.error || "请求被拒绝");
  } else {
    showMessage("");
  }
  setTimeout(poll, 60);
}

async function terminateRun() {
  if (!runId) return;  // 历史模式下仍作用于当前运行
  const { ok, data } = await postJSON("/api/terminate", { run_id: runId });
  if (!ok) showMessage(data.error || "终止失败");
  poll();
}

async function fetchPauses() {
  try {
    const res = await fetch(`/api/pauses?run_id=${encodeURIComponent(runId)}`);
    if (!res.ok) return null;  // 过期/未知 run_id（409）：保持现有列表
    const data = await res.json();
    return data.pauses || [];
  } catch (e) {
    return null;
  }
}

async function poll() {
  if (!runId) return;
  let data;
  try {
    const res = await fetch("/api/state");
    data = await res.json();
  } catch (e) {
    return;
  }
  // 旧运行的迟到响应不得覆盖新运行：run_id 不匹配直接丢弃
  if (data.run_id !== runId) return;
  liveState = data;
  pauseSeq = data.pause_seq;
  renderStatusBadge(data.status);

  const latest = await fetchPauses();
  if (latest) pauses = latest;
  populateHistory();

  if (inHistoryMode()) {
    const selected = pauses.find((p) => String(p.pause_seq) === viewingSeq);
    if (selected) {
      // 轮询继续更新实时状态（徽标/下拉），但不切走所选历史记录
      renderHistory(selected);
    } else {
      // 所选记录已被淘汰：提示并返回实时视图（liveState 刚刷新过）
      showLive(data, `停顿 #${viewingSeq} 已超出最近保留条数被淘汰，已返回实时视图`);
    }
  } else {
    renderView(data);
  }

  if (["finished", "exception", "terminated"].includes(data.status)) {
    // 结束/异常/终止后停止轮询，但历史停顿仍可回看
    stopPolling();
    setRunningUI(false);
    // 终态后若停在历史视图，保持其控制禁用状态
    if (inHistoryMode()) {
      $("btn-step").disabled = true;
      $("btn-continue").disabled = true;
    }
  }
}

function renderStatusBadge(status) {
  const badge = $("status");
  badge.textContent = STATUS_TEXT[status] || status;
  badge.className = "badge badge-" + status;
}

function renderView(state) {
  renderStatusBadge(state.status);
  renderListing(state.lines, state.current_line, state.status !== "finished");
  renderLocals(state.locals);

  let out = state.stdout || "";
  if (state.stdout_truncated) out = "（输出过长，仅保留末尾部分）\n" + out;
  $("stdout").textContent = out;
  $("exception").textContent = state.exception || "";

  const paused = state.status === "paused";
  $("btn-step").disabled = !paused;
  $("btn-continue").disabled = !paused;
}

function renderHistory(pause) {
  // 历史快照：定格当时的待执行行/局部变量/已保留输出；不改动状态徽标
  const lines = liveState ? liveState.lines : [];
  renderListing(lines, pause.current_line, true);
  renderLocals(pause.locals);
  let out = pause.stdout || "";
  if (pause.stdout_truncated) out = "（输出过长，仅保留末尾部分）\n" + out;
  $("stdout").textContent = out;
  $("exception").textContent = "";
  $("btn-step").disabled = true;
  $("btn-continue").disabled = true;
}

function renderListing(lines, currentLine, highlight) {
  const listing = $("listing");
  listing.textContent = "";
  listing.classList.remove("empty");
  lines.forEach((text, i) => {
    const isCurrent = highlight && i + 1 === currentLine;
    const row = document.createElement("div");
    row.className = "code-line";
    if (isCurrent) row.classList.add("current");
    const gutter = document.createElement("span");
    gutter.className = "gutter";
    gutter.textContent = (isCurrent ? "→ " : "  ")
      + String(i + 1).padStart(2, " ");
    const code = document.createElement("span");
    code.className = "text";
    code.textContent = text || " ";
    row.appendChild(gutter);
    row.appendChild(code);
    listing.appendChild(row);
  });
}

function renderLocals(locals) {
  const tbody = $("locals").querySelector("tbody");
  tbody.textContent = "";
  const names = Object.keys(locals || {});
  if (names.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empty";
    const td = document.createElement("td");
    td.textContent = "（无）";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const name of names) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.className = "var-name";
    tdName.textContent = name;
    const tdVal = document.createElement("td");
    tdVal.className = "var-value";
    tdVal.textContent = locals[name];
    tr.appendChild(tdName);
    tr.appendChild(tdVal);
    tbody.appendChild(tr);
  }
}

// ---- pause history dropdown ---------------------------------------------

function populateHistory() {
  const select = $("history");
  const sig = pauses.map((p) => p.pause_seq).join(",");
  if (sig === historySig) return;  // 无新停顿/无淘汰：不重建，保留当前选择
  historySig = sig;

  select.textContent = "";
  const liveOpt = document.createElement("option");
  liveOpt.value = "";
  liveOpt.textContent = "实时视图（最新状态）";
  select.appendChild(liveOpt);
  for (const p of pauses) {
    const opt = document.createElement("option");
    opt.value = String(p.pause_seq);
    opt.textContent = `停顿 #${p.pause_seq}（第 ${p.current_line} 行）`;
    select.appendChild(opt);
  }
  select.value = inHistoryMode() ? viewingSeq : "";
}

function enterHistoryView(seq) {
  const pause = pauses.find((p) => String(p.pause_seq) === seq);
  if (!pause) return;
  viewingSeq = String(seq);
  $("history").value = viewingSeq;
  $("history-banner").hidden = false;
  renderHistory(pause);
}

function exitHistoryView() {
  viewingSeq = null;
  $("history").value = "";
  $("history-banner").hidden = true;
}

function showLive(state, message) {
  // 用给定（最新）状态切回实时视图并据此重新启用/禁用控制
  exitHistoryView();
  showMessage(message || "");
  renderView(state);
}

async function returnToLive() {
  // 返回实时视图：先获取最新状态再启用控制
  exitHistoryView();
  showMessage("");
  if (runId) {
    await poll();  // poll 此刻处于实时模式，会用最新状态渲染并设置控制
  } else if (liveState) {
    renderView(liveState);
  }
}

$("btn-run").addEventListener("click", startRun);
$("btn-step").addEventListener("click", () => control("step"));
$("btn-continue").addEventListener("click", () => control("continue"));
$("btn-terminate").addEventListener("click", terminateRun);
$("btn-back-live").addEventListener("click", returnToLive);
$("history").addEventListener("change", (e) => {
  const value = e.target.value;
  if (value === "") {
    returnToLive();
  } else {
    enterHistoryView(value);
  }
});
$("code").addEventListener("input", updateLineCount);
$("examples").addEventListener("change", (e) => {
  const code = EXAMPLES[e.target.value];
  if (code) {
    $("code").value = code + "\n";
    updateLineCount();
  }
  e.target.value = "";
});

updateLineCount();
