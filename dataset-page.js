(function () {
  "use strict";

  const core = window.DatasetJobPageCore;
  const POLL_INTERVAL_MS = 1600;
  const RUNNING_STATES = new Set(["searching", "judging_bundle", "downloading"]);
  const APP_CONFIG = window.__APP_CONFIG__ || {};
  const API_BASE = String(APP_CONFIG.API_BASE || "").replace(/\/+$/, "");

  let currentJob = null;
  let candidates = [];
  let addedCandidates = [];
  let pollTimer = null;

  const els = {
    llmBadge: document.getElementById("llmBadge"),
    serpBadge: document.getElementById("serpBadge"),
    jobStatusBadge: document.getElementById("jobStatusBadge"),
    jobTitle: document.getElementById("jobTitle"),
    jobAbstract: document.getElementById("jobAbstract"),
    createJobBtn: document.getElementById("createJobBtn"),
    statePanel: document.getElementById("statePanel"),
    currentJobTitle: document.getElementById("currentJobTitle"),
    currentJobId: document.getElementById("currentJobId"),
    stateMessage: document.getElementById("stateMessage"),
    candidateSection: document.getElementById("candidateSection"),
    candidateRows: document.getElementById("candidateRows"),
    candidateDisplayLimit: document.getElementById("candidateDisplayLimit"),
    candidateCount: document.getElementById("candidateCount"),
    decisionSection: document.getElementById("decisionSection"),
    decisionSelect: document.getElementById("decisionSelect"),
    jobPlatformHints: document.getElementById("jobPlatformHints"),
    platformHints: document.getElementById("platformHints"),
    missingRequirements: document.getElementById("missingRequirements"),
    suggestedQueries: document.getElementById("suggestedQueries"),
    reviewComment: document.getElementById("reviewComment"),
    addUrlBtn: document.getElementById("addUrlBtn"),
    addedUrlRows: document.getElementById("addedUrlRows"),
    submitReviewBtn: document.getElementById("submitReviewBtn"),
    confirmationSection: document.getElementById("confirmationSection"),
    judgmentBody: document.getElementById("judgmentBody"),
    forceDownloadBtn: document.getElementById("forceDownloadBtn"),
    resultSection: document.getElementById("resultSection"),
    fileRows: document.getElementById("fileRows"),
    recentJobs: document.getElementById("recentJobs"),
    refreshJobsBtn: document.getElementById("refreshJobsBtn"),
  };

  function esc(value) {
    const div = document.createElement("div");
    div.textContent = String(value == null ? "" : value);
    return div.innerHTML;
  }

  function apiUrl(path) {
    if (!API_BASE) return path;
    if (/^https?:\/\//i.test(path)) return path;
    return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async function apiFetch(path, options) {
    const res = await fetch(apiUrl(path), options);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.detail || payload.message || `HTTP ${res.status}`);
    }
    return payload;
  }

  function setStatus(label, state) {
    els.jobStatusBadge.textContent = label;
    els.jobStatusBadge.dataset.state = state || "";
  }

  function setMessage(message, isError) {
    els.stateMessage.textContent = String(message || "");
    els.stateMessage.classList.toggle("error", !!isError);
    els.stateMessage.classList.toggle("muted", !isError);
  }

  function setProviderBadges(job) {
    els.llmBadge.textContent = job && job.llm_enabled ? "LLM enabled" : "LLM disabled";
    els.llmBadge.dataset.state = job && job.llm_enabled ? "success" : "warning";
    els.serpBadge.textContent = job && job.serp_enabled ? "SERP enabled" : "SERP disabled";
    els.serpBadge.dataset.state = job && job.serp_enabled ? "success" : "warning";
  }

  async function createJob() {
    const originalLabel = els.createJobBtn.textContent;
    els.createJobBtn.disabled = true;
    els.createJobBtn.textContent = "Creating...";
    try {
      const body = core.buildCreateJobPayload(
        els.jobTitle.value,
        els.jobAbstract.value,
        els.jobPlatformHints.value
      );
      setStatus("Creating", "running");
      setMessage("Creating dataset job...");
      els.statePanel.scrollIntoView({ behavior: "smooth", block: "start" });
      const created = await apiFetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await loadJob(created.job_id);
      await loadRecentJobs();
    } finally {
      els.createJobBtn.disabled = false;
      els.createJobBtn.textContent = originalLabel;
    }
  }

  async function loadJob(jobId) {
    currentJob = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    renderJob();
    if (RUNNING_STATES.has(currentJob.status)) {
      startPolling();
    } else {
      stopPolling();
    }
  }

  function renderJob() {
    if (!currentJob) return;
    const state = core.classifyJobState(currentJob);
    setProviderBadges(currentJob);
    setStatus(currentJob.status || "draft", state);
    els.currentJobTitle.textContent = currentJob.input ? currentJob.input.title : "Dataset job";
    els.currentJobId.textContent = currentJob.job_id || "";
    setMessage(messageForJob(currentJob), state === "failed");

    candidates = normalizeCandidates(currentJob.candidates || []);
    renderCandidates();
    renderAddedCandidates();
    renderJudgment();
    renderFiles();

    els.candidateSection.hidden = state !== "review" && state !== "confirmation";
    els.decisionSection.hidden = state !== "review";
    els.confirmationSection.hidden = state !== "confirmation";
    els.resultSection.hidden = state !== "completed" && !(currentJob.downloaded_files || []).length;
  }

  function messageForJob(job) {
    if (job.status === "awaiting_review") return "Review candidates, add URLs if needed, then submit a decision.";
    if (job.status === "needs_confirmation") return "The bundle judgment is not sufficient. You can force download or search more.";
    if (job.status === "completed") return "Download flow completed.";
    if (job.status === "manual_required") return "Manual access is required.";
    if (job.status === "insufficient") return "The job was stopped as insufficient.";
    if (job.status === "failed") return "The job failed. Inspect persisted job artifacts for details.";
    return "Job is running.";
  }

  function normalizeCandidates(rows) {
    return rows.map((row) => ({
      ...row,
      approved: row.approved !== false,
      rejected: !!row.rejected,
      rejectReason: row.rejectReason || "",
    }));
  }

  function renderCandidates() {
    els.candidateRows.innerHTML = "";
    if (!candidates.length && currentJob && currentJob.status === "awaiting_review") {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="7" class="dataset-empty-row">${esc(core.candidateReviewHint(candidates, currentJob.status))}</td>`;
      els.candidateRows.appendChild(tr);
      updateCandidateCount();
      return;
    }
    const visibleCandidates = getVisibleCandidates();
    visibleCandidates.forEach((candidate, index) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><label class="dataset-checkline"><input type="checkbox" data-index="${index}" data-field="approved" ${candidate.approved ? "checked" : ""}>Approve</label></td>
        <td>
          <div class="dataset-title">${esc(candidate.title)}</div>
          <a href="${esc(candidate.url)}" target="_blank" rel="noreferrer">${esc(candidate.url)}</a>
          <div class="muted dataset-reason">${esc(candidate.reason)}</div>
        </td>
        <td>${esc(candidate.source_provider || candidate.source_layer)}</td>
        <td>${esc(candidate.role)}</td>
        <td>${Number(candidate.score || 0).toFixed(2)}</td>
        <td>${esc((candidate.coverage_tags || []).join(", "))}</td>
        <td>
          <label class="dataset-checkline"><input type="checkbox" data-index="${index}" data-field="rejected" ${candidate.rejected ? "checked" : ""}>Reject</label>
          <input class="dataset-inline-input" data-index="${index}" data-field="rejectReason" value="${esc(candidate.rejectReason)}" placeholder="Reason">
        </td>
      `;
      els.candidateRows.appendChild(tr);
    });
    updateCandidateCount();
  }

  function updateCandidateCount() {
    const visibleCandidates = getVisibleCandidates();
    const selected = visibleCandidates.filter((candidate) => candidate.approved && !candidate.rejected).length;
    const hint = currentJob ? core.candidateReviewHint(candidates, currentJob.status) : "";
    const visibleCount = visibleCandidates.length;
    els.candidateCount.textContent = hint
      ? `${hint} Showing ${visibleCount} of ${candidates.length}; ${selected} selected.`
      : `${selected} selected`;
  }

  function getVisibleCandidates() {
    const displayLimit = core.normalizeCandidateDisplayLimit(
      els.candidateDisplayLimit.value,
      candidates.length || 1
    );
    els.candidateDisplayLimit.max = String(Math.max(candidates.length, 1));
    els.candidateDisplayLimit.value = String(displayLimit);
    return candidates.slice(0, displayLimit);
  }

  function renderAddedCandidates() {
    els.addedUrlRows.innerHTML = "";
    addedCandidates.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "added-url-row";
      row.innerHTML = `
        <input data-added-index="${index}" data-field="title" value="${esc(item.title || "")}" placeholder="Title">
        <input data-added-index="${index}" data-field="url" value="${esc(item.url || "")}" placeholder="https://...">
        <select data-added-index="${index}" data-field="role">
          <option value="primary" ${item.role === "primary" ? "selected" : ""}>primary</option>
          <option value="feature_source" ${item.role === "feature_source" ? "selected" : ""}>feature_source</option>
          <option value="label_source" ${item.role === "label_source" ? "selected" : ""}>label_source</option>
        </select>
        <input data-added-index="${index}" data-field="reason" value="${esc(item.reason || "")}" placeholder="Reason">
        <input data-added-index="${index}" data-field="coverageTagsText" value="${esc(item.coverageTagsText || "")}" placeholder="coverage tags">
        <button type="button" class="action-btn" data-remove-added="${index}">Remove</button>
      `;
      els.addedUrlRows.appendChild(row);
    });
  }

  function renderJudgment() {
    els.judgmentBody.textContent = JSON.stringify(currentJob.bundle_judgment || {}, null, 2);
  }

  function renderFiles() {
    els.fileRows.innerHTML = "";
    (currentJob.downloaded_files || []).forEach((file) => {
      const sizeText = file.size_bytes || !file.expected_size_bytes
        ? core.formatBytes(file.size_bytes)
        : `0 B (remote ${core.formatBytes(file.expected_size_bytes)})`;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(file.file_name)}</td>
        <td>${esc(sizeText)}</td>
        <td>${esc(file.format || file.content_type || "")}</td>
        <td>${esc(file.status)}</td>
        <td>${esc(file.reason || "")}</td>
        <td><a href="${esc(file.source_url)}" target="_blank" rel="noreferrer">${esc(file.source_url)}</a></td>
        <td>${esc(file.local_path)}</td>
      `;
      els.fileRows.appendChild(tr);
    });
  }

  async function submitReview() {
    if (!currentJob) return;
    const payload = core.buildReviewPayload({
      candidates: getVisibleCandidates(),
      addedCandidates,
      decision: els.decisionSelect.value,
      platformHintsText: els.platformHints.value,
      missingRequirementsText: els.missingRequirements.value,
      suggestedQueriesText: els.suggestedQueries.value,
      comment: els.reviewComment.value,
      reviewedAt: new Date().toISOString(),
    });
    setStatus("Submitting", "running");
    const job = await apiFetch(`/api/jobs/${encodeURIComponent(currentJob.job_id)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    currentJob = job;
    renderJob();
    if (RUNNING_STATES.has(currentJob.status)) {
      startPolling();
    }
  }

  async function forceDownload() {
    if (!currentJob) return;
    const job = await apiFetch(`/api/jobs/${encodeURIComponent(currentJob.job_id)}/confirm-download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true, comment: "Forced from local web UI." }),
    });
    currentJob = job;
    renderJob();
    if (RUNNING_STATES.has(currentJob.status)) {
      startPolling();
    }
  }

  async function loadRecentJobs() {
    const payload = await apiFetch("/api/jobs");
    els.recentJobs.innerHTML = "";
    (payload.jobs || []).forEach((job) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-btn";
      button.textContent = `${job.status}: ${job.input ? job.input.title : job.job_id}`;
      button.addEventListener("click", () => loadJob(job.job_id).catch(showError));
      els.recentJobs.appendChild(button);
    });
  }

  function startPolling() {
    stopPolling();
    pollTimer = window.setTimeout(async () => {
      try {
        await loadJob(currentJob.job_id);
      } catch (err) {
        showError(err);
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function handleCandidateInput(event) {
    const target = event.target;
    const index = Number(target.dataset.index);
    const field = target.dataset.field;
    if (!Number.isFinite(index) || !field || !candidates[index]) return;
    if (field === "approved" || field === "rejected") {
      candidates[index][field] = !!target.checked;
      if (field === "approved" && target.checked) candidates[index].rejected = false;
      if (field === "rejected" && target.checked) candidates[index].approved = false;
      renderCandidates();
      return;
    }
    if (field === "rejectReason") candidates[index].rejectReason = target.value;
  }

  function handleAddedInput(event) {
    const target = event.target;
    const index = Number(target.dataset.addedIndex);
    const field = target.dataset.field;
    if (!Number.isFinite(index) || !field || !addedCandidates[index]) return;
    addedCandidates[index][field] = target.value;
  }

  function showError(err) {
    console.error(err);
    setStatus("Error", "failed");
    setMessage(err && err.message ? err.message : String(err), true);
  }

  function bindEvents() {
    els.createJobBtn.addEventListener("click", () => createJob().catch(showError));
    els.submitReviewBtn.addEventListener("click", () => submitReview().catch(showError));
    els.forceDownloadBtn.addEventListener("click", () => forceDownload().catch(showError));
    els.refreshJobsBtn.addEventListener("click", () => loadRecentJobs().catch(showError));
    els.candidateDisplayLimit.addEventListener("input", renderCandidates);
    els.addUrlBtn.addEventListener("click", () => {
      addedCandidates.push({ title: "", url: "", role: "primary", reason: "", coverageTagsText: "" });
      renderAddedCandidates();
    });
    els.candidateRows.addEventListener("input", handleCandidateInput);
    els.addedUrlRows.addEventListener("input", handleAddedInput);
    els.addedUrlRows.addEventListener("click", (event) => {
      const index = Number(event.target.dataset.removeAdded);
      if (!Number.isFinite(index)) return;
      addedCandidates.splice(index, 1);
      renderAddedCandidates();
    });
  }

  bindEvents();
  loadRecentJobs().catch(() => {
    setMessage("Backend is not reachable. Start the FastAPI server and refresh.", true);
  });
})();
