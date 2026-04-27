(function () {
  "use strict";

  const DAY_START = 8 * 60;
  const partitions = {
    cpu: { label: "cpu", priority: 20 },
    gpu: { label: "gpu", priority: 35 },
    highmem: { label: "highmem", priority: 28 }
  };

  const nodeTemplates = [
    { name: "cpu-a01", partition: "cpu", cpus: 32, mem: 128, gpus: 0 },
    { name: "cpu-a02", partition: "cpu", cpus: 32, mem: 128, gpus: 0 },
    { name: "cpu-a03", partition: "cpu", cpus: 32, mem: 128, gpus: 0 },
    { name: "cpu-a04", partition: "cpu", cpus: 32, mem: 128, gpus: 0 },
    { name: "gpu-b01", partition: "gpu", cpus: 48, mem: 256, gpus: 4 },
    { name: "gpu-b02", partition: "gpu", cpus: 48, mem: 256, gpus: 4 },
    { name: "mem-c01", partition: "highmem", cpus: 64, mem: 512, gpus: 0 },
    { name: "mem-c02", partition: "highmem", cpus: 64, mem: 512, gpus: 0 }
  ];

  const state = {
    minute: DAY_START,
    nextJobId: 1001,
    jobs: [],
    nodes: [],
    logs: [],
    running: false,
    timer: null,
    selectedJobId: null,
    commandTab: "sinfo",
    maintenance: false
  };

  const el = {
    form: document.querySelector("#jobForm"),
    jobName: document.querySelector("#jobName"),
    partition: document.querySelector("#partition"),
    nodes: document.querySelector("#nodes"),
    cpus: document.querySelector("#cpus"),
    memory: document.querySelector("#memory"),
    duration: document.querySelector("#duration"),
    gpus: document.querySelector("#gpus"),
    priority: document.querySelector("#priority"),
    priorityText: document.querySelector("#priorityText"),
    submitBtn: document.querySelector("#submitBtn"),
    scriptPreview: document.querySelector("#scriptPreview"),
    burstBtn: document.querySelector("#burstBtn"),
    maintenanceBtn: document.querySelector("#maintenanceBtn"),
    resetBtn: document.querySelector("#resetBtn"),
    stepBtn: document.querySelector("#stepBtn"),
    playBtn: document.querySelector("#playBtn"),
    speed: document.querySelector("#speed"),
    nodeGrid: document.querySelector("#nodeGrid"),
    queueBody: document.querySelector("#queueBody"),
    log: document.querySelector("#log"),
    clock: document.querySelector("#clock"),
    daemonState: document.querySelector("#daemonState"),
    utilMetric: document.querySelector("#utilMetric"),
    pendingMetric: document.querySelector("#pendingMetric"),
    runningMetric: document.querySelector("#runningMetric"),
    doneMetric: document.querySelector("#doneMetric"),
    commandOutput: document.querySelector("#commandOutput"),
    detailTitle: document.querySelector("#detailTitle"),
    detailText: document.querySelector("#detailText"),
    tabs: document.querySelectorAll(".tab")
  };

  function cloneNodes() {
    return nodeTemplates.map((node) => ({ ...node, alloc: [], maintenance: false }));
  }

  function reset() {
    stop();
    state.minute = DAY_START;
    state.nextJobId = 1001;
    state.jobs = [];
    state.nodes = cloneNodes();
    state.logs = [];
    state.selectedJobId = null;
    state.commandTab = "sinfo";
    state.maintenance = false;
    setForm({ name: "bert-train", partition: "cpu", nodes: 1, cpus: 8, memory: 32, gpus: 0, duration: 45, priority: 45 });
    log("cluster initialized with 8 nodes across 3 partitions");
    render();
  }

  function submitJob(raw) {
    const job = {
      id: state.nextJobId++,
      name: cleanName(raw.name || "job"),
      partition: raw.partition,
      reqNodes: clamp(raw.reqNodes, 1, 4),
      cpusPerNode: clamp(raw.cpusPerNode, 1, 64),
      memGb: clamp(raw.memGb, 4, 512),
      gpus: clamp(raw.gpus, 0, 8),
      duration: clamp(raw.duration, 5, 240),
      priority: clamp(raw.priority, 0, 100),
      submitMinute: state.minute,
      startMinute: null,
      endMinute: null,
      remaining: clamp(raw.duration, 5, 240),
      state: "PD",
      nodes: [],
      reason: "Priority",
      backfilled: false
    };

    state.jobs.push(job);
    state.selectedJobId = job.id;
    log(`accepted job ${job.id} (${job.name}) into ${job.partition}`);
    schedule();
    render();
  }

  function cleanName(value) {
    return String(value)
      .trim()
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 24) || "job";
  }

  function clamp(value, min, max) {
    const num = Number(value);
    if (Number.isNaN(num)) return min;
    return Math.max(min, Math.min(max, num));
  }

  function log(message) {
    state.logs.unshift({ minute: state.minute, message });
    state.logs = state.logs.slice(0, 80);
  }

  function tick() {
    state.minute += 5;

    for (const job of state.jobs.filter((item) => item.state === "R")) {
      job.remaining = Math.max(0, job.remaining - 5);
      if (job.remaining === 0) {
        completeJob(job);
      }
    }

    schedule();
    render();
  }

  function completeJob(job) {
    job.state = "CD";
    job.endMinute = state.minute;
    for (const node of state.nodes) {
      node.alloc = node.alloc.filter((id) => id !== job.id);
    }
    log(`completed job ${job.id}; released ${job.nodes.join(",")}`);
  }

  function schedule() {
    const pending = state.jobs
      .filter((job) => job.state === "PD")
      .sort((a, b) => score(b) - score(a) || a.submitMinute - b.submitMinute);

    for (const job of pending) {
      job.reason = pendingReason(job);
    }

    for (const job of pending) {
      const allocation = findAllocation(job);
      if (!allocation) continue;

      const highestWaiting = highestWaitingScore(job.partition);
      if (score(job) < highestWaiting && job.duration > 35) {
        job.reason = "Priority";
        continue;
      }

      startJob(job, allocation, score(job) < highestWaiting);
    }
  }

  function highestWaitingScore(partition) {
    const scores = state.jobs
      .filter((job) => job.state === "PD" && job.partition === partition)
      .map((job) => score(job));
    return scores.length ? Math.max(...scores) : 0;
  }

  function score(job) {
    const age = Math.floor((state.minute - job.submitMinute) / 10);
    return job.priority + partitions[job.partition].priority + age;
  }

  function pendingReason(job) {
    const partitionNodes = state.nodes.filter((node) => node.partition === job.partition);
    if (!partitionNodes.length) return "PartitionDown";
    if (job.reqNodes > partitionNodes.length) return "ReqNodeNotAvail";
    if (job.gpus > 0 && partitionNodes.every((node) => node.gpus === 0)) return "GRES";
    if (job.cpusPerNode > Math.max(...partitionNodes.map((node) => node.cpus))) return "CPUs";
    if (job.memGb > Math.max(...partitionNodes.map((node) => node.mem))) return "Memory";
    if (partitionNodes.every((node) => node.maintenance)) return "Maintenance";
    return "Resources";
  }

  function findAllocation(job) {
    const candidates = state.nodes
      .filter((node) => node.partition === job.partition && !node.maintenance)
      .map((node) => ({ node, free: freeResources(node) }))
      .filter(({ free }) => free.cpus >= job.cpusPerNode && free.mem >= job.memGb && free.gpus >= gpusPerNode(job));

    if (candidates.length < job.reqNodes) return null;
    candidates.sort((a, b) => nodeFit(a, job) - nodeFit(b, job));
    return candidates.slice(0, job.reqNodes).map(({ node }) => node);
  }

  function gpusPerNode(job) {
    if (job.gpus === 0) return 0;
    return Math.ceil(job.gpus / job.reqNodes);
  }

  function freeResources(node) {
    const used = usedResources(node);
    return {
      cpus: node.cpus - used.cpus,
      mem: node.mem - used.mem,
      gpus: node.gpus - used.gpus
    };
  }

  function usedResources(node) {
    const runningJobs = node.alloc
      .map((id) => state.jobs.find((job) => job.id === id))
      .filter(Boolean);

    return runningJobs.reduce(
      (sum, job) => ({
        cpus: sum.cpus + job.cpusPerNode,
        mem: sum.mem + job.memGb,
        gpus: sum.gpus + gpusPerNode(job)
      }),
      { cpus: 0, mem: 0, gpus: 0 }
    );
  }

  function nodeFit(candidate, job) {
    return (candidate.free.cpus - job.cpusPerNode) + (candidate.free.mem - job.memGb) / 8 + (candidate.free.gpus - gpusPerNode(job)) * 10;
  }

  function startJob(job, nodes, backfilled) {
    job.state = "R";
    job.reason = "";
    job.startMinute = state.minute;
    job.nodes = nodes.map((node) => node.name);
    job.backfilled = backfilled;
    for (const node of nodes) {
      node.alloc.push(job.id);
    }
    log(`${backfilled ? "backfilled" : "started"} job ${job.id} on ${job.nodes.join(",")}`);
  }

  function loadBurst() {
    const samples = [
      ["align-reads", "cpu", 1, 12, 24, 0, 30, 30],
      ["mpi-sim", "cpu", 3, 24, 64, 0, 90, 82],
      ["notebook", "gpu", 1, 8, 32, 1, 25, 40],
      ["llm-pretrain", "gpu", 2, 32, 128, 4, 120, 94],
      ["variant-call", "highmem", 1, 32, 420, 0, 55, 62],
      ["short-qc", "cpu", 1, 4, 8, 0, 15, 25]
    ];

    for (const [name, partition, reqNodes, cpusPerNode, memGb, gpus, duration, priority] of samples) {
      submitJob({ name, partition, reqNodes, cpusPerNode, memGb, gpus, duration, priority });
    }
    log("loaded mixed workload burst");
    render();
  }

  function toggleMaintenance() {
    state.maintenance = !state.maintenance;
    for (const node of state.nodes.filter((item) => item.partition === "cpu").slice(2)) {
      node.maintenance = state.maintenance && node.alloc.length === 0;
    }
    log(state.maintenance ? "cpu-a03,cpu-a04 marked DRAIN for maintenance" : "maintenance cleared on cpu nodes");
    schedule();
    render();
  }

  function play() {
    if (state.running) {
      stop();
      render();
      return;
    }
    state.running = true;
    state.timer = window.setInterval(tick, 950 / Number(el.speed.value));
    render();
  }

  function stop() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
    state.running = false;
  }

  function render() {
    renderClock();
    renderScript();
    renderNodes();
    renderQueue();
    renderMetrics();
    renderLog();
    renderCommand();
    renderDetail();
    el.playBtn.textContent = state.running ? "Pause" : "Run";
    el.daemonState.textContent = state.running ? "slurmctld scheduling" : "slurmctld idle";
  }

  function renderClock() {
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const day = Math.floor((state.minute - DAY_START) / (24 * 60));
    const minuteOfDay = ((state.minute % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
    const minutes = String(minuteOfDay % 60).padStart(2, "0");
    el.clock.textContent = `${dayNames[day % dayNames.length]} ${hours}:${minutes}`;
  }

  function renderScript() {
    const name = cleanName(el.jobName.value);
    const partition = el.partition.value;
    const nodes = clamp(el.nodes.value, 1, 4);
    const cpus = clamp(el.cpus.value, 1, 64);
    const mem = clamp(el.memory.value, 4, 512);
    const duration = clamp(el.duration.value, 5, 240);
    const gpus = clamp(el.gpus.value, 0, 8);
    const hours = String(Math.floor(duration / 60)).padStart(2, "0");
    const minutes = String(duration % 60).padStart(2, "0");
    el.priorityText.textContent = String(el.priority.value);
    el.scriptPreview.textContent = [
      "#!/bin/bash",
      `#SBATCH --job-name=${name}`,
      `#SBATCH --partition=${partition}`,
      `#SBATCH --nodes=${nodes}`,
      `#SBATCH --cpus-per-task=${cpus}`,
      `#SBATCH --mem=${mem}G`,
      `#SBATCH --time=${hours}:${minutes}:00`,
      gpus ? `#SBATCH --gres=gpu:${gpus}` : null,
      "",
      "srun ./workload.sh"
    ].filter((line) => line !== null).join("\n");
  }

  function renderNodes() {
    el.nodeGrid.innerHTML = "";
    for (const node of state.nodes) {
      const used = usedResources(node);
      const card = document.createElement("article");
      card.className = `node node-${node.partition}${node.maintenance ? " maintenance" : ""}`;
      card.innerHTML = `
        <div class="node-head">
          <div>
            <div class="node-name">${node.name}</div>
            <div class="node-partition">${node.partition}${node.maintenance ? " / DRAIN" : ""}</div>
          </div>
          <span class="badge ${node.partition === "gpu" ? "accent" : node.partition === "highmem" ? "info" : ""}">${node.cpus}c</span>
        </div>
        ${bar("CPU", used.cpus, node.cpus, "")}
        ${bar("MEM", used.mem, node.mem, "mem")}
        ${node.gpus ? bar("GPU", used.gpus, node.gpus, "gpu") : ""}
        <div>${node.alloc.map((id) => jobChip(id)).join("") || "<span class=\"job-chip\">idle</span>"}</div>
      `;
      el.nodeGrid.appendChild(card);
    }
  }

  function bar(label, used, total, type) {
    const pct = total ? Math.round((used / total) * 100) : 0;
    return `
      <div class="bar-label"><span>${label}</span><span>${used}/${total}</span></div>
      <div class="bar ${type}"><span style="width:${pct}%"></span></div>
    `;
  }

  function jobChip(id) {
    const job = state.jobs.find((item) => item.id === id);
    return `<button class="job-chip" type="button" data-job="${job.id}">${job.id} ${job.name}</button>`;
  }

  function renderQueue() {
    const visible = state.jobs
      .filter((job) => job.state !== "CD")
      .sort((a, b) => stateOrder(a.state) - stateOrder(b.state) || score(b) - score(a));

    el.queueBody.innerHTML = visible.map((job) => {
      const req = `${job.reqNodes}n ${job.cpusPerNode}c ${job.memGb}G${job.gpus ? ` ${job.gpus}g` : ""}`;
      const time = job.state === "R" ? formatDuration(job.duration - job.remaining) : formatDuration(job.duration);
      const where = job.state === "R" ? compactNodes(job.nodes) : job.reason;
      const selected = job.id === state.selectedJobId ? " class=\"selected\"" : "";
      return `
        <tr${selected} data-job="${job.id}">
          <td>${job.id}</td>
          <td>${job.name}</td>
          <td class="${job.state === "R" ? "state-r" : "state-pd"}">${job.state}</td>
          <td>${job.partition}</td>
          <td>${req}</td>
          <td>${time}</td>
          <td>${where}</td>
        </tr>
      `;
    }).join("");

    if (!visible.length) {
      el.queueBody.innerHTML = "<tr><td colspan=\"7\">No active jobs</td></tr>";
    }
  }

  function stateOrder(value) {
    return value === "R" ? 0 : value === "PD" ? 1 : 2;
  }

  function renderMetrics() {
    const totalCpu = state.nodes.reduce((sum, node) => sum + node.cpus, 0);
    const usedCpu = state.nodes.reduce((sum, node) => sum + usedResources(node).cpus, 0);
    el.utilMetric.textContent = `${Math.round((usedCpu / totalCpu) * 100)}%`;
    el.pendingMetric.textContent = String(state.jobs.filter((job) => job.state === "PD").length);
    el.runningMetric.textContent = String(state.jobs.filter((job) => job.state === "R").length);
    el.doneMetric.textContent = String(state.jobs.filter((job) => job.state === "CD").length);
  }

  function renderLog() {
    el.log.innerHTML = state.logs.map((entry) => (
      `<div class="log-line"><strong>${formatClock(entry.minute)}</strong> ${entry.message}</div>`
    )).join("");
  }

  function renderCommand() {
    syncCommandTabs();
    if (state.commandTab === "sinfo") {
      el.commandOutput.textContent = sinfo();
    } else if (state.commandTab === "squeue") {
      el.commandOutput.textContent = squeue();
    } else {
      el.commandOutput.textContent = sacct();
    }
  }

  function syncCommandTabs() {
    for (const item of el.tabs) {
      item.classList.toggle("active", item.dataset.tab === state.commandTab);
    }
  }

  function sinfo() {
    const rows = ["PARTITION AVAIL NODES CPUS(A/I/O/T) MEMORY STATE NODELIST"];
    for (const part of Object.keys(partitions)) {
      const nodes = state.nodes.filter((node) => node.partition === part);
      const allocated = nodes.reduce((sum, node) => sum + usedResources(node).cpus, 0);
      const total = nodes.reduce((sum, node) => sum + node.cpus, 0);
      const maint = nodes.filter((node) => node.maintenance).length;
      const idle = Math.max(0, total - allocated);
      const stateText = maint === nodes.length ? "drain" : allocated ? "mixed" : "idle";
      rows.push(`${part.padEnd(9)} up    ${String(nodes.length).padStart(2)}    ${allocated}/${idle}/0/${total}       ${Math.max(...nodes.map((node) => node.mem))}G ${stateText.padEnd(5)} ${compactNodes(nodes.map((node) => node.name))}`);
    }
    return rows.join("\n");
  }

  function squeue() {
    const rows = ["JOBID PARTITION NAME       ST TIME     NODES NODELIST(REASON)"];
    for (const job of state.jobs.filter((item) => item.state !== "CD")) {
      const where = job.state === "R" ? compactNodes(job.nodes) : `(${job.reason})`;
      rows.push(`${String(job.id).padEnd(5)} ${job.partition.padEnd(9)} ${job.name.padEnd(10)} ${job.state.padEnd(2)} ${formatDuration(job.state === "R" ? job.duration - job.remaining : 0).padEnd(8)} ${String(job.reqNodes).padStart(2)}    ${where}`);
    }
    if (rows.length === 1) rows.push("no jobs in queue");
    return rows.join("\n");
  }

  function sacct() {
    const rows = ["JobID JobName       Partition State  Elapsed  AllocNodes"];
    for (const job of state.jobs.filter((item) => item.state === "CD").slice(-12)) {
      rows.push(`${String(job.id).padEnd(5)} ${job.name.padEnd(13)} ${job.partition.padEnd(9)} ${job.state.padEnd(6)} ${formatDuration(job.duration).padEnd(8)} ${job.nodes.length}`);
    }
    if (rows.length === 1) rows.push("no completed jobs yet");
    return rows.join("\n");
  }

  function renderDetail() {
    const job = state.jobs.find((item) => item.id === state.selectedJobId);
    if (!job) {
      el.detailTitle.textContent = "Scheduler cycle";
      el.detailText.textContent = "Submit jobs to see Slurm place them on nodes, hold them pending, or backfill them into short gaps.";
      return;
    }

    el.detailTitle.textContent = `Job ${job.id}: ${job.name}`;
    if (job.state === "R") {
      el.detailText.textContent = `${job.partition} job running on ${compactNodes(job.nodes)} with ${job.remaining} minutes left. ${job.backfilled ? "It was backfilled because it fit without delaying higher priority work." : "It won enough priority and resources were available."}`;
    } else if (job.state === "PD") {
      el.detailText.textContent = `Pending reason: ${job.reason}. Effective priority is ${score(job)} from job priority, partition weight, and queue age.`;
    } else {
      el.detailText.textContent = `Completed at ${formatClock(job.endMinute)} after using ${job.nodes.length} node(s).`;
    }
  }

  function setForm(values) {
    if (values.name !== undefined) el.jobName.value = values.name;
    if (values.partition !== undefined) el.partition.value = values.partition;
    if (values.nodes !== undefined) el.nodes.value = values.nodes;
    if (values.cpus !== undefined) el.cpus.value = values.cpus;
    if (values.memory !== undefined) el.memory.value = values.memory;
    if (values.gpus !== undefined) el.gpus.value = values.gpus;
    if (values.duration !== undefined) el.duration.value = values.duration;
    if (values.priority !== undefined) el.priority.value = values.priority;
    renderScript();
  }

  function compactNodes(nodes) {
    if (!nodes.length) return "-";
    return nodes.join(",");
  }

  function formatDuration(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  }

  function formatClock(minute) {
    const minuteOfDay = ((minute % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
    const mins = String(minuteOfDay % 60).padStart(2, "0");
    return `${hours}:${mins}`;
  }

  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitJob({
      name: el.jobName.value,
      partition: el.partition.value,
      reqNodes: el.nodes.value,
      cpusPerNode: el.cpus.value,
      memGb: el.memory.value,
      gpus: el.gpus.value,
      duration: el.duration.value,
      priority: el.priority.value
    });
  });

  for (const input of [el.jobName, el.partition, el.nodes, el.cpus, el.memory, el.duration, el.gpus, el.priority]) {
    input.addEventListener("input", renderScript);
  }

  el.burstBtn.addEventListener("click", loadBurst);
  el.maintenanceBtn.addEventListener("click", toggleMaintenance);
  el.resetBtn.addEventListener("click", reset);
  el.stepBtn.addEventListener("click", tick);
  el.playBtn.addEventListener("click", play);
  el.speed.addEventListener("input", () => {
    if (state.running) {
      stop();
      play();
    }
  });

  el.queueBody.addEventListener("click", (event) => {
    const row = event.target.closest("[data-job]");
    if (!row) return;
    state.selectedJobId = Number(row.dataset.job);
    render();
  });

  el.nodeGrid.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-job]");
    if (!chip) return;
    state.selectedJobId = Number(chip.dataset.job);
    render();
  });

  for (const tab of el.tabs) {
    tab.addEventListener("click", () => {
      state.commandTab = tab.dataset.tab;
      render();
    });
  }

  reset();
})();
