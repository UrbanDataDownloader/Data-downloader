(function () {
  "use strict";

  const core = window.DatasetJobPageCore;
  const DATASET_PAGE_CONFIG = window.__APP_CONFIG__ || {};
  const DATASET_PAGE_API_BASE = String(DATASET_PAGE_CONFIG.API_BASE || "").replace(/\/+$/, "");
  const POLL_INTERVAL_MS = 1600;
  const RUNNING_STATES = new Set(["searching", "judging_bundle", "planning_resources", "downloading"]);

  let currentJob = null;
  let candidates = [];
  let addedCandidates = [];
  let pollTimer = null;
  let lastRequirementModel = { candidates: [], requirementModel: null };

  const els = {
    llmBadge: document.getElementById("llmBadge"),
    serpBadge: document.getElementById("serpBadge"),
    jobStatusBadge: document.getElementById("jobStatusBadge"),
    inputMode: document.getElementById("inputMode"),
    ideaInputFields: document.getElementById("ideaInputFields"),
    datasetRequirementFields: document.getElementById("datasetRequirementFields"),
    jobDatasetRequirement: document.getElementById("jobDatasetRequirement"),
    jobTitle: document.getElementById("jobTitle"),
    jobAbstract: document.getElementById("jobAbstract"),
    createJobBtn: document.getElementById("createJobBtn"),
    statePanel: document.getElementById("statePanel"),
    currentJobTitle: document.getElementById("currentJobTitle"),
    currentJobId: document.getElementById("currentJobId"),
    stateMessage: document.getElementById("stateMessage"),
    requirementsSection: document.getElementById("requirementsSection"),
    requirementRows: document.getElementById("requirementRows"),
    candidateSection: document.getElementById("candidateSection"),
    candidateRows: document.getElementById("candidateRows"),
    candidateDisplayLimit: document.getElementById("candidateDisplayLimit"),
    candidateCount: document.getElementById("candidateCount"),
    decisionSection: document.getElementById("decisionSection"),
    decisionSelect: document.getElementById("decisionSelect"),
    jobPlatformHints: document.getElementById("jobPlatformHints"),
    retryFailedStepButton: document.getElementById("retryFailedStepButton"),
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
    resourcePlanSection: document.getElementById("resourcePlanSection"),
    resourcePlanRows: document.getElementById("resourcePlanRows"),
    fileRows: document.getElementById("fileRows"),
    recentJobs: document.getElementById("recentJobs"),
    refreshJobsBtn: document.getElementById("refreshJobsBtn"),
  };

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeTextList(value) {
    return asArray(value)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  function normalizeTextValue(value, fallback) {
    return String(value == null ? fallback || "" : value);
  }

  function syncInputMode() {
    const mode = normalizeTextValue(els.inputMode && els.inputMode.value, "idea");
    const useIdeaFields = String(mode).trim() !== "dataset_requirement";
    if (els.ideaInputFields) {
      els.ideaInputFields.hidden = !useIdeaFields;
    }
    if (els.datasetRequirementFields) {
      els.datasetRequirementFields.hidden = useIdeaFields;
    }
  }

  function esc(value) {
    const div = document.createElement("div");
    div.textContent = String(value == null ? "" : value);
    return div.innerHTML;
  }

  function apiUrl(path) {
    return `${DATASET_PAGE_API_BASE}${path}`;
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
      const body = core.buildCreateJobPayload({
        inputMode: normalizeTextValue(els.inputMode && els.inputMode.value, "idea"),
        title: normalizeTextValue(els.jobTitle && els.jobTitle.value, ""),
        abstract: normalizeTextValue(els.jobAbstract && els.jobAbstract.value, ""),
        datasetRequirement: normalizeTextValue(
          els.jobDatasetRequirement && els.jobDatasetRequirement.value,
          ""
        ),
        platformHintsText: normalizeTextValue(els.jobPlatformHints && els.jobPlatformHints.value, ""),
      });
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
    const requirements = asArray(currentJob.requirements);
    const requirementReviewModel = buildRequirementReviewModel(requirements);
    const requirementCandidates = asArray(requirementReviewModel.candidates);
    const legacyCandidates = normalizeCandidates(currentJob.candidates);
    const useRequirementReview = requirements.length > 0 && requirementCandidates.length > 0;
    const isLegacyCandidateFallback =
      !useRequirementReview && requirements.length > 0 && legacyCandidates.length > 0;
    lastRequirementModel = {
      candidates: requirementCandidates,
      requirementModel: requirementReviewModel,
    };

    setProviderBadges(currentJob);
    setStatus(currentJob.status || "draft", state);
    const titleInput = currentJob.input || {};
    const isRequirementMode = normalizeTextValue(titleInput.input_mode, "idea") === "dataset_requirement";
    const fallbackTitle = isRequirementMode
      ? normalizeTextValue(
          titleInput.dataset_requirement || titleInput.title,
          "Dataset requirement"
        )
      : normalizeTextValue(titleInput.title, "Dataset job");
    els.currentJobTitle.textContent = fallbackTitle;
    els.currentJobId.textContent = currentJob.job_id || "";
    setMessage(messageForJob(currentJob), state === "failed");

    candidates = useRequirementReview ? requirementCandidates : legacyCandidates;
    renderRequirements(requirements);
    if (isLegacyCandidateFallback || !requirements.length) {
      renderCandidates();
    } else if (els.candidateRows) {
      els.candidateRows.innerHTML = "";
      updateCandidateCount();
    }
    renderAddedCandidates();
    renderJudgment();
    renderResourcePlans();
    renderFiles();
    if (els.retryFailedStepButton) {
      const hasFailedRequirement = asArray(currentJob.requirements).some(
        (item) => item && item.status === "llm_failed"
      );
      els.retryFailedStepButton.hidden = !hasFailedRequirement;
    }

    const showCandidateSection =
      !requirements.length || isLegacyCandidateFallback;
    els.candidateSection.hidden = state !== "review" && state !== "confirmation" || !showCandidateSection;
    els.decisionSection.hidden = state !== "review";
    els.confirmationSection.hidden = state !== "confirmation";
    if (els.resourcePlanSection) {
      els.resourcePlanSection.hidden = !asArray(currentJob.resource_plans).length;
    }
    els.resultSection.hidden = state !== "completed" && !(currentJob.downloaded_files || []).length;
    if (els.requirementsSection) {
      els.requirementsSection.hidden = !requirements.length;
    }
  }

  function messageForJob(job) {
    if (job.status === "awaiting_review") return "Review candidates, add URLs if needed, then submit a decision.";
    if (job.status === "needs_confirmation") return "The bundle judgment is not sufficient. You can force download or search more.";
    if (job.status === "completed") return "Download flow completed.";
    if (job.status === "manual_required") {
      const needsCredential = (job.downloaded_files || []).some(
        (file) => file && file.status === "credential_required"
      );
      if (needsCredential) return "Manual access is required: provide API credentials or choose another resource.";
      return "Manual access is required.";
    }
    if (job.status === "insufficient") return "The job was stopped as insufficient.";
    if (job.status === "failed") return core.failureDetailsForJob(job);
    return "Job is running.";
  }

  function normalizeCandidates(rows) {
    return asArray(rows).map((row) => ({
      ...row,
      approved: row.approved !== false,
      rejected: !!row.rejected,
      rejectReason: row.rejectReason || "",
    }));
  }

  function buildRequirementReviewModel(requirements) {
    const groupedModel = core.buildRequirementQuerySourceModel(requirements);
    const reviewCandidates = [];
    asArray(groupedModel.reviewCandidates).forEach((candidate, index) => {
      if (!candidate || typeof candidate !== "object") return;
      candidate.approved = candidate.approved !== false;
      candidate.rejected = !!candidate.rejected;
      candidate.rejectReason = candidate.rejectReason || "";
      candidate._reviewIndex = index;
      reviewCandidates.push(candidate);
    });

    return {
      requirements: asArray(groupedModel.requirements),
      candidates: reviewCandidates,
      rejected: asArray(groupedModel.rejected),
    };
  }

  function createCandidateRow(candidate, index) {
    const safeCandidate = candidate || {};
    const unjudgedClass = safeCandidate._isUnjudged
      ? " dataset-mini-row-unjudged"
      : "";
    return `
      <tr class="${unjudgedClass}">
        <td><label class="dataset-checkline"><input type="checkbox" data-index="${index}" data-field="approved" ${safeCandidate.approved ? "checked" : ""}>Approve</label></td>
        <td>
          <div class="dataset-title">${esc(safeCandidate.title)}</div>
          <a href="${esc(safeCandidate.url)}" target="_blank" rel="noreferrer">${esc(safeCandidate.url)}</a>
          <div class="muted dataset-reason">${esc(safeCandidate.llm_recommendation_reason || safeCandidate.reason)}</div>
        </td>
        <td>${esc(safeCandidate.source_id || safeCandidate.source_provider || safeCandidate.source_layer)}</td>
        <td>${esc(safeCandidate.role)}</td>
        <td>${esc((safeCandidate.coverage_tags || []).join(", "))}</td>
        <td>
          <label class="dataset-checkline"><input type="checkbox" data-index="${index}" data-field="rejected" ${safeCandidate.rejected ? "checked" : ""}>Reject</label>
          <input class="dataset-inline-input" data-index="${index}" data-field="rejectReason" value="${esc(safeCandidate.rejectReason)}" placeholder="Reason">
        </td>
      </tr>
    `;
  }

  function renderChipList(values, chipClass) {
    const chipItems = normalizeTextList(values);
    if (!chipItems.length) {
      return `<span class="query-chip">none</span>`;
    }
    return chipItems
      .map((value) => `<span class="${chipClass}">${esc(value)}</span>`)
      .join("");
  }

  function renderRequirements(requirements) {
    if (!els.requirementsSection || !els.requirementRows) return;
    const requirementList = asArray(requirements);

    if (!requirementList.length) {
      els.requirementRows.innerHTML = "";
      els.requirementsSection.hidden = true;
      return;
    }
    els.requirementsSection.hidden = false;
    els.requirementRows.innerHTML = "";

    const model = lastRequirementModel && lastRequirementModel.requirementModel
      ? lastRequirementModel.requirementModel
      : buildRequirementReviewModel(requirementList);
    const groupedRequirements = asArray(model.requirements);
    const reviewCandidates = asArray(model.candidates);
    const candidateIndexByRef = new Map();
    reviewCandidates.forEach((candidate, index) => {
      candidateIndexByRef.set(candidate, index);
    });
    const rejectedByRequirement = new Map();
    asArray(model.rejected).forEach((entry) => {
      const key = Number(entry && entry._requirementIndex);
      const listKey = Number.isFinite(key) ? key : -1;
      const bucket = rejectedByRequirement.get(listKey) || [];
      bucket.push(entry);
      rejectedByRequirement.set(listKey, bucket);
    });

    requirementList.forEach((requirement, requirementIndex) => {
      const item = document.createElement("article");
      item.className = "requirement-item";
      const safeRequirement = requirement || {};
      const title = normalizeTextValue(
        safeRequirement.title,
        `Requirement ${requirementIndex + 1}`
      );
      const role = normalizeTextValue(safeRequirement.role, "primary");
      const priority = Number.isFinite(Number(safeRequirement.priority))
        ? Number(safeRequirement.priority)
        : 1;
      const status = normalizeTextValue(safeRequirement.status, "searching");
      const initialQueries = renderChipList(safeRequirement.initial_queries, "query-chip");
      const description = normalizeTextValue(safeRequirement.description, "No description.");

      const header = document.createElement("div");
      header.className = "requirement-head";
      header.innerHTML = `
        <h3 class="requirement-title">${esc(title)}</h3>
        <span class="pill requirement-badge">status: ${esc(status)}</span>
      `;

      const descriptionNode = document.createElement("p");
      descriptionNode.className = "requirement-description";
      descriptionNode.textContent = description;

      const meta = document.createElement("div");
      meta.className = "requirement-meta";
      meta.innerHTML = `
        <span class="requirement-badge">role: ${esc(role)}</span>
        <span class="requirement-badge">priority: ${esc(priority)}</span>
        <span class="requirement-badge">queries: <span class="query-chips">${initialQueries}</span></span>
      `;

      item.appendChild(header);
      item.appendChild(descriptionNode);
      item.appendChild(meta);
      const requirementModel = asArray(groupedRequirements).find((entry) => Number(entry && entry.requirementIndex) === requirementIndex) || null;
      const queryList = asArray(requirementModel && requirementModel.queries);
      const queryGroups = document.createElement("div");
      queryGroups.className = "requirement-rounds";
      if (!queryList.length) {
        const noCandidates = document.createElement("p");
        noCandidates.className = "dataset-mini-note";
        noCandidates.textContent = "No useful candidates for this requirement yet.";
        queryGroups.appendChild(noCandidates);
      }

      queryList.forEach((queryGroup) => {
        const queryNode = document.createElement("section");
        queryNode.className = "query-group";
        const queryText = normalizeTextValue(
          queryGroup && queryGroup.query_text,
          queryGroup && queryGroup.query_id ? queryGroup.query_id : "Unassigned query"
        );
        const queryHeading = document.createElement("h4");
        queryHeading.textContent = `Query: ${queryText}`;
        queryNode.appendChild(queryHeading);

        asArray(queryGroup && queryGroup.sourceGroups).forEach((sourceGroup) => {
          const sourceNode = document.createElement("section");
          sourceNode.className = "source-group";
          const sourceHeading = document.createElement("h5");
          sourceHeading.className = "source-title";
          sourceHeading.textContent = normalizeTextValue(
            sourceGroup && sourceGroup.source_id,
            "unknown"
          );
          sourceNode.appendChild(sourceHeading);

          const tableWrap = document.createElement("div");
          tableWrap.className = "dataset-mini-table-wrap";
          const table = document.createElement("table");
          table.className = "dataset-mini-table";
          table.innerHTML = `
            <thead>
              <tr>
                <th>Approve</th>
                <th>Dataset</th>
                <th>Provider</th>
                <th>Role</th>
                <th>Coverage</th>
                <th>Reject</th>
              </tr>
            </thead>
          `;
          const tbody = document.createElement("tbody");

          const sourceCandidates = asArray(sourceGroup && sourceGroup.candidates)
            .slice()
            .sort((left, right) => {
              const leftScore = Number(left && left.llm_fit_score);
              const rightScore = Number(right && right.llm_fit_score);
              const leftValue = Number.isFinite(leftScore) ? leftScore : 0;
              const rightValue = Number.isFinite(rightScore) ? rightScore : 0;
              return rightValue - leftValue;
            });

          sourceCandidates.forEach((sourceCandidate) => {
            const rowIndex = candidateIndexByRef.get(sourceCandidate);
            const candidateRow = asArray(model.candidates)[rowIndex];
            if (!candidateRow) return;
            tbody.insertAdjacentHTML(
              "beforeend",
              createCandidateRow(candidateRow, rowIndex)
            );
          });

          table.appendChild(tbody);
          tableWrap.appendChild(table);
          sourceNode.appendChild(tableWrap);
          queryNode.appendChild(sourceNode);
        });

        queryGroups.appendChild(queryNode);
      });

      if (asArray(rejectedByRequirement.get(requirementIndex)).length > 0) {
        const rejectedRows = asArray(rejectedByRequirement.get(requirementIndex));
        const details = document.createElement("details");
        details.className = "rejected-panel";
        const summary = document.createElement("summary");
        summary.textContent = `Rejected by LLM (${rejectedRows.length})`;
        details.appendChild(summary);
        const tableWrap = document.createElement("div");
        tableWrap.className = "dataset-mini-table-wrap";
        const table = document.createElement("table");
        table.className = "dataset-mini-table";
        table.innerHTML = `
          <thead>
            <tr>
              <th>Title</th>
              <th>URL</th>
              <th>Reason</th>
              <th>Exclude key</th>
            </tr>
          </thead>
        `;
        const tbody = document.createElement("tbody");
        rejectedRows.forEach((row) => {
          const candidate = (row && row.candidate) || {};
          const judgment = row && row.judgment ? row.judgment : {};
          const reason = judgment.reason;
          const excludeKey = judgment.exclude_key;
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td>${esc(candidate.title)}</td>
            <td><a href="${esc(candidate.url)}" target="_blank" rel="noreferrer">${esc(candidate.url)}</a></td>
            <td>${esc(reason || "No reason provided.")}</td>
            <td>${esc(excludeKey)}</td>
          `;
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        details.appendChild(tableWrap);
        queryGroups.appendChild(details);
      }

      item.appendChild(queryGroups);
      els.requirementRows.appendChild(item);
    });
  }

  function renderCandidates() {
    els.candidateRows.innerHTML = "";
    if (!candidates.length && currentJob && currentJob.status === "awaiting_review") {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" class="dataset-empty-row">${esc(core.candidateReviewHint(candidates, currentJob.status))}</td>`;
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

  function getReviewCandidatesForSubmit() {
    const hasRequirements = asArray(currentJob && currentJob.requirements).length > 0;
    const requirementCandidates = asArray(
      lastRequirementModel && lastRequirementModel.candidates
    );
    if (hasRequirements && requirementCandidates.length > 0) {
      return requirementCandidates;
    }
    return getVisibleCandidates();
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
      candidates: getReviewCandidatesForSubmit(),
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

  function renderResourcePlans() {
    if (!els.resourcePlanRows) return;
    const model = core.resourcePlanViewModel(currentJob || {});
    const plans = asArray(model.plans);
    els.resourcePlanRows.innerHTML = "";
    if (!plans.length) return;
    const labels = {
      primary_data: "Primary data",
      required_metadata: "Required metadata",
      required_supporting: "Required supporting",
      optional_supporting: "Optional supporting",
      documentation: "Documentation",
      index: "Index",
      sample: "Sample",
      reject: "Rejected",
    };
    plans.forEach((plan) => {
      const article = document.createElement("article");
      article.className = "resource-plan-card";
      const missing = asArray(plan.missing);
      article.innerHTML = `
        <div class="requirement-head">
          <h3 class="requirement-title">${esc(plan.plan_id || "Resource plan")}</h3>
          <span class="pill requirement-badge">status: ${esc(plan.status || "planned")}</span>
        </div>
        <p class="requirement-description">${esc(plan.summary || "")}</p>
        ${missing.length ? `<p class="dataset-mini-note">Missing: ${esc(missing.join(", "))}</p>` : ""}
      `;
      asArray(plan.roleOrder).forEach((role) => {
        const resources = asArray(plan.groups && plan.groups[role]);
        if (!resources.length) return;
        const section = document.createElement("section");
        section.className = "resource-role-group";
        section.innerHTML = `<h4>${esc(labels[role] || role)}</h4>`;
        resources.forEach((resource) => {
          const planIndex = asArray(currentJob.resource_plans).findIndex(
            (item) => item && item.plan_id === plan.plan_id
          );
          const resourceIndex = planIndex >= 0
            ? asArray(currentJob.resource_plans[planIndex].resources).findIndex(
                (item) => item && item.resource_id === resource.resource_id
              )
            : -1;
          const row = document.createElement("div");
          row.className = `resource-row resource-row-${role}`;
          row.innerHTML = `
            <select class="dataset-inline-input" data-plan-index="${planIndex}" data-resource-index="${resourceIndex}" data-field="role">
              ${Object.keys(labels).map((key) => `<option value="${esc(key)}" ${resource.role === key ? "selected" : ""}>${esc(labels[key])}</option>`).join("")}
            </select>
            <label class="dataset-checkline"><input type="checkbox" data-plan-index="${planIndex}" data-resource-index="${resourceIndex}" data-field="required" ${resource.required ? "checked" : ""}>required</label>
            <span class="requirement-badge">${esc(resource.download_status)}</span>
            <div>
              <div class="dataset-title">${esc(resource.title || resource.resource_id)}</div>
              <a href="${esc(resource.url)}" target="_blank" rel="noreferrer">${esc(resource.url)}</a>
              <div class="muted dataset-reason">${esc(resource.reason || resource.expected_format || "")}</div>
              <div class="muted dataset-resource-meta">
                ${[resource.platform, resource.resource_type, resource.download_strategy].filter(Boolean).map(esc).join(" · ")}
              </div>
              ${resource.resolver_evidence ? `<div class="muted dataset-resource-evidence">${esc(resource.resolver_evidence)}</div>` : ""}
            </div>
          `;
          section.appendChild(row);
        });
        article.appendChild(section);
      });
      const actions = document.createElement("div");
      actions.className = "dataset-submit-row";
      actions.innerHTML = `<button type="button" class="action-btn" data-action="save-resource-plans">Save resource plan</button>`;
      article.appendChild(actions);
      els.resourcePlanRows.appendChild(article);
    });
  }

  function handleResourcePlanInput(event) {
    const target = event.target;
    const planIndex = Number(target.dataset.planIndex);
    const resourceIndex = Number(target.dataset.resourceIndex);
    const field = target.dataset.field;
    if (!Number.isFinite(planIndex) || !Number.isFinite(resourceIndex) || !field) return;
    const plan = asArray(currentJob && currentJob.resource_plans)[planIndex];
    const resource = plan && asArray(plan.resources)[resourceIndex];
    if (!resource) return;
    if (field === "required") {
      resource.required = !!target.checked;
      return;
    }
    if (field === "role") {
      resource.role = target.value;
    }
  }

  async function saveResourcePlans() {
    if (!currentJob) return;
    const payload = core.buildResourcePlanUpdatePayload(currentJob.resource_plans || []);
    const job = await apiFetch(`/api/jobs/${encodeURIComponent(currentJob.job_id)}/resource-plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    currentJob = job;
    renderJob();
  }

  async function retryFailedStep() {
    if (!currentJob || !currentJob.job_id) return;
    const failedRequirement = asArray(currentJob.requirements).find(
      (item) => item && item.status === "llm_failed"
    );
    const job = await apiFetch(`/api/jobs/${encodeURIComponent(currentJob.job_id)}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirement_id: failedRequirement ? failedRequirement.requirement_id : "" }),
    });
    currentJob = job;
    renderJob();
  }

  async function loadRecentJobs() {
    const payload = await apiFetch("/api/jobs");
    els.recentJobs.innerHTML = "";
    (payload.jobs || []).forEach((job) => {
      const jobInput = job && job.input ? job.input : {};
      const jobInputMode = normalizeTextValue(jobInput.input_mode, "idea");
      const jobLabel = jobInputMode === "dataset_requirement"
        ? normalizeTextValue(jobInput.dataset_requirement || jobInput.title, job.job_id)
        : normalizeTextValue(jobInput.title, job.job_id);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-btn";
      button.textContent = `${job.status}: ${jobLabel}`;
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
      refreshCandidateSurfaces();
      return;
    }
    if (field === "rejectReason") candidates[index].rejectReason = target.value;
  }

  function refreshCandidateSurfaces() {
    if (!currentJob) return;
    if (els.requirementsSection && !els.requirementsSection.hidden) {
      renderRequirements(currentJob.requirements);
    }
    if (els.candidateSection && !els.candidateSection.hidden) {
      renderCandidates();
    }
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
    if (els.retryFailedStepButton) {
      els.retryFailedStepButton.addEventListener("click", () => retryFailedStep().catch(showError));
    }
    els.refreshJobsBtn.addEventListener("click", () => loadRecentJobs().catch(showError));
    if (els.inputMode) {
      els.inputMode.addEventListener("change", syncInputMode);
    }
    els.candidateDisplayLimit.addEventListener("input", renderCandidates);
    els.addUrlBtn.addEventListener("click", () => {
      addedCandidates.push({ title: "", url: "", role: "primary", reason: "", coverageTagsText: "" });
      renderAddedCandidates();
    });
    els.candidateRows.addEventListener("input", handleCandidateInput);
    if (els.requirementRows) {
      els.requirementRows.addEventListener("input", handleCandidateInput);
    }
    if (els.resourcePlanRows) {
      els.resourcePlanRows.addEventListener("input", handleResourcePlanInput);
      els.resourcePlanRows.addEventListener("click", (event) => {
        if (event.target && event.target.dataset && event.target.dataset.action === "save-resource-plans") {
          saveResourcePlans().catch(showError);
        }
      });
    }
    els.addedUrlRows.addEventListener("input", handleAddedInput);
    els.addedUrlRows.addEventListener("click", (event) => {
      const index = Number(event.target.dataset.removeAdded);
      if (!Number.isFinite(index)) return;
      addedCandidates.splice(index, 1);
      renderAddedCandidates();
    });
    syncInputMode();
  }

  bindEvents();
  loadRecentJobs().catch(() => {
    setMessage("Backend is not reachable. Start the FastAPI server and refresh.", true);
  });
})();
