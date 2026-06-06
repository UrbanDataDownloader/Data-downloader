(function () {
  "use strict";

  const core = window.DatasetJobPageCore;
  const DATASET_PAGE_CONFIG = window.__APP_CONFIG__ || {};
  const DATASET_PAGE_API_BASE = String(DATASET_PAGE_CONFIG.API_BASE || "").replace(/\/+$/, "");
  const POLL_INTERVAL_MS = 1600;
  const RUNNING_STATES = new Set(["searching", "judging_bundle", "planning_resources", "downloading"]);
  const AUTH_TOKEN_KEY = "dataset_downloader_auth_token";

  let currentJob = null;
  let candidates = [];
  let addedCandidates = [];
  let pollTimer = null;
  let lastRequirementModel = { candidates: [], requirementModel: null };
  let reviewPrefillJobId = "";
  let reviewSuggestionSource = "";
  let reviewSuggestionSourceDetails = [];
  let createJobInFlight = false;
  let userStoppedTracking = false;
  let authState = { authenticated: false, role: "", username: "", guest_remaining_jobs: 0 };
  let authToken = "";

  const els = {
    llmBadge: document.getElementById("llmBadge"),
    serpBadge: document.getElementById("serpBadge"),
    jobStatusBadge: document.getElementById("jobStatusBadge"),
    datasetShell: document.getElementById("datasetShell"),
    sidebarToggle: document.getElementById("sidebarToggle"),
    newSearchBtn: document.getElementById("newSearchBtn"),
    connectionBadge: document.getElementById("connectionBadge"),
    authBadge: document.getElementById("authBadge"),
    logoutBtn: document.getElementById("logoutBtn"),
    authOverlay: document.getElementById("authOverlay"),
    datasetAuthForm: document.getElementById("datasetAuthForm"),
    authUsername: document.getElementById("authUsername"),
    authPassword: document.getElementById("authPassword"),
    authError: document.getElementById("authError"),
    guestLoginBtn: document.getElementById("guestLoginBtn"),
    inputMode: document.getElementById("inputMode"),
    ideaInputFields: document.getElementById("ideaInputFields"),
    datasetRequirementFields: document.getElementById("datasetRequirementFields"),
    jobDatasetRequirement: document.getElementById("jobDatasetRequirement"),
    jobTitle: document.getElementById("jobTitle"),
    jobAbstract: document.getElementById("jobAbstract"),
    createJobBtn: document.getElementById("createJobBtn"),
    inputCanvas: document.getElementById("inputCanvas"),
    statePanel: document.getElementById("statePanel"),
    currentJobTitle: document.getElementById("currentJobTitle"),
    currentJobId: document.getElementById("currentJobId"),
    stateMessage: document.getElementById("stateMessage"),
    jobActivityIndicator: document.getElementById("jobActivityIndicator"),
    jobActivityText: document.getElementById("jobActivityText"),
    jobActivitySubtext: document.getElementById("jobActivitySubtext"),
    stopSearchBtn: document.getElementById("stopSearchBtn"),
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
    searchMorePrefillPreview: document.getElementById("searchMorePrefillPreview"),
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
    downloadPreviewSummary: document.getElementById("downloadPreviewSummary"),
    downloadConfirmRow: document.getElementById("downloadConfirmRow"),
    resourcePlanRows: document.getElementById("resourcePlanRows"),
    selectionSummary: document.getElementById("selectionSummary"),
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

  function uniqueTextList(value) {
    const seen = new Set();
    return normalizeTextList(value).filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  function normalizeTextValue(value, fallback) {
    return String(value == null ? fallback || "" : value);
  }

  function compactChineseSearchTitle(value) {
    const raw = normalizeTextValue(value, "").trim();
    if (!/[\u4e00-\u9fff]/.test(raw)) return "";
    const geoRules = [
      [/芝加哥|Chicago/i, "Chicago"],
      [/纽约|New York|NYC/i, "New York"],
      [/洛杉矶|Los Angeles|LA/i, "Los Angeles"],
      [/美国|United States|US|USA/i, "US"],
    ];
    const topicRules = [
      [/道路交通事故|交通事故|碰撞|事故热点/i, "Traffic Crashes"],
      [/公共交通|公交|地铁|站点|线路|GTFS|时刻表/i, "Public Transit GTFS"],
      [/睡眠|睡觉|sleep/i, "Sleep Data"],
      [/食品|食物|food/i, "Food Data"],
      [/天气|气象|weather/i, "Weather Data"],
      [/道路条件|照明条件/i, "Road Conditions"],
    ];
    const parts = [];
    geoRules.forEach(([pattern, label]) => {
      if (pattern.test(raw) && !parts.includes(label)) parts.push(label);
    });
    topicRules.forEach(([pattern, label]) => {
      if (pattern.test(raw) && !parts.includes(label)) parts.push(label);
    });
    if (parts.length) return parts.slice(0, 3).join(" ");
    return raw
      .replace(/[，。；、,.!?！？;:：].*$/, "")
      .replace(/\s+/g, "")
      .slice(0, 14) || "Dataset search";
  }

  function compactSearchTitle(value, fallback) {
    const raw = normalizeTextValue(value, "").trim();
    if (!raw) return fallback || "Dataset search";
    const chineseTitle = compactChineseSearchTitle(raw);
    if (chineseTitle) return chineseTitle;
    const cleaned = raw
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const stopWords = new Set([
      "a", "an", "and", "are", "as", "at", "by", "for", "from", "in", "of", "on",
      "or", "the", "to", "with", "about", "need", "needs", "dataset", "datasets",
      "open", "download", "search", "find", "looking",
    ]);
    const words = cleaned.split(" ").filter(Boolean);
    const titleWords = [];
    words.forEach((word) => {
      const normalized = word.toLowerCase();
      if (titleWords.length >= 5) return;
      if (stopWords.has(normalized) && titleWords.length > 0) return;
      titleWords.push(word);
    });
    const selected = titleWords.length ? titleWords : words.slice(0, 5);
    const title = selected
      .join(" ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
    return title || fallback || "Dataset search";
  }

  function displayTitleForJob(job) {
    const titleInput = job && job.input ? job.input : {};
    const isRequirementMode = normalizeTextValue(titleInput.input_mode, "idea") === "dataset_requirement";
    if (!isRequirementMode) {
      const ideaTitle = normalizeTextValue(titleInput.title, "").trim();
      return ideaTitle || "Dataset search";
    }
    const requirementTitle = normalizeTextValue(
      asArray(job && job.requirements)[0] && asArray(job && job.requirements)[0].title,
      ""
    ).trim();
    if (requirementTitle) return requirementTitle;
    return compactSearchTitle(titleInput.dataset_requirement || titleInput.title, "Dataset search");
  }

  function parseJobTime(job) {
    const raw = normalizeTextValue(
      job && (job.updated_at || job.last_updated_at || job.created_at),
      ""
    );
    const value = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(value) ? value : 0;
  }

  function recentGroupLabel(timestamp) {
    if (!timestamp) return "Older";
    const now = new Date();
    const date = new Date(timestamp);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diffDays = Math.round((today - day) / 86400000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return "Previous 7 days";
    return "Older";
  }

  function relativeJobTime(timestamp) {
    if (!timestamp) return "";
    const diffMs = Date.now() - timestamp;
    const minute = 60000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diffMs < minute) return "just now";
    if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
    if (diffMs < day) return `${Math.max(1, Math.floor(diffMs / hour))}h ago`;
    if (diffMs < 7 * day) return `${Math.max(1, Math.floor(diffMs / day))}d ago`;
    return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
    const headers = { ...((options && options.headers) || {}) };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    const res = await fetch(apiUrl(path), {
      credentials: "include",
      ...(options || {}),
      headers,
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showAuthOverlay();
      throw new Error(payload.detail || "Login required");
    }
    if (!res.ok) {
      throw new Error(payload.detail || payload.message || `HTTP ${res.status}`);
    }
    return payload;
  }

  function showAuthOverlay(message) {
    if (els.authOverlay) els.authOverlay.hidden = false;
    if (els.authError) els.authError.textContent = message || "";
    if (els.authUsername) els.authUsername.focus();
  }

  function hideAuthOverlay() {
    if (els.authOverlay) els.authOverlay.hidden = true;
    if (els.authError) els.authError.textContent = "";
  }

  function loadStoredAuthToken() {
    try {
      authToken = sessionStorage.getItem(AUTH_TOKEN_KEY) || "";
    } catch (_) {
      authToken = "";
    }
  }

  function storeAuthToken(token) {
    authToken = String(token || "");
    try {
      if (authToken) {
        sessionStorage.setItem(AUTH_TOKEN_KEY, authToken);
      } else {
        sessionStorage.removeItem(AUTH_TOKEN_KEY);
      }
    } catch (_) {}
  }

  function renderAuthState() {
    if (els.authBadge) {
      if (!authState.authenticated) {
        els.authBadge.textContent = "Not signed in";
      } else if (authState.role === "guest") {
        els.authBadge.textContent = `Guest · ${authState.guest_remaining_jobs || 0} search left`;
      } else {
        els.authBadge.textContent = authState.username || "Signed in";
      }
    }
    if (els.logoutBtn) {
      els.logoutBtn.hidden = !authState.authenticated;
    }
  }

  async function loadAuthState() {
    const payload = await apiFetch("/api/auth/status");
    authState = payload || {};
    if (authState && authState.token) {
      storeAuthToken(authState.token);
    }
    renderAuthState();
    if (authState.authenticated) {
      hideAuthOverlay();
    } else {
      showAuthOverlay();
    }
    return authState;
  }

  async function loginWithPassword(event) {
    event.preventDefault();
    const payload = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: normalizeTextValue(els.authUsername && els.authUsername.value, ""),
        password: normalizeTextValue(els.authPassword && els.authPassword.value, ""),
      }),
    });
    authState = payload || {};
    if (authState && authState.token) {
      storeAuthToken(authState.token);
    }
    renderAuthState();
    hideAuthOverlay();
    await loadRecentJobs();
  }

  async function loginAsGuest() {
    const payload = await apiFetch("/api/auth/guest", { method: "POST" });
    authState = payload || {};
    if (authState && authState.token) {
      storeAuthToken(authState.token);
    }
    renderAuthState();
    hideAuthOverlay();
    await loadRecentJobs();
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => ({}));
    authState = { authenticated: false, role: "", username: "", guest_remaining_jobs: 0 };
    storeAuthToken("");
    renderAuthState();
    resetSearchCanvas();
    showAuthOverlay();
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

  function isJobRunning(job) {
    return RUNNING_STATES.has(normalizeTextValue(job && job.status, ""));
  }

  function setCreateJobLoading(isLoading, label) {
    if (!els.createJobBtn) return;
    els.createJobBtn.disabled = !!isLoading;
    els.createJobBtn.classList.toggle("is-loading", !!isLoading);
    els.createJobBtn.textContent = isLoading ? (label || "Working...") : "Create job";
  }

  function updateActivityState(message) {
    const running = (createJobInFlight || isJobRunning(currentJob)) && !userStoppedTracking;
    const activityText = message || activityTextForJob(currentJob);
    setCreateJobLoading(running, createJobInFlight ? "Creating..." : "Job running...");
    if (els.statePanel) {
      els.statePanel.dataset.running = running ? "true" : "false";
    }
    if (els.jobActivityIndicator) {
      els.jobActivityIndicator.hidden = !running;
    }
    if (els.jobActivityText && running) {
      els.jobActivityText.textContent = activityText;
    }
    if (els.jobActivitySubtext && running) {
      els.jobActivitySubtext.textContent = activitySubtextForJob(currentJob);
    }
  }

  function resetSearchCanvas() {
    userStoppedTracking = false;
    currentJob = null;
    candidates = [];
    addedCandidates = [];
    stopPolling();
    setStatus("Ready", "");
    setProviderBadges(null);
    setMessage("Create a search or load one from recent jobs.");
    if (els.currentJobTitle) els.currentJobTitle.textContent = "No search loaded";
    if (els.currentJobId) els.currentJobId.textContent = "Ready";
    if (els.resourcePlanSection) els.resourcePlanSection.hidden = true;
    if (els.resultSection) els.resultSection.hidden = true;
    if (els.decisionSection) els.decisionSection.hidden = true;
    if (els.confirmationSection) els.confirmationSection.hidden = true;
    updateActivityState();
    if (els.inputCanvas) els.inputCanvas.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function stopTrackingCurrentSearch() {
    userStoppedTracking = true;
    stopPolling();
    setStatus("Stopped tracking", "warning");
    setMessage("This page stopped tracking the current search. The backend job may still be running on the server.");
    updateActivityState();
    if (els.inputCanvas) els.inputCanvas.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function createJob() {
    createJobInFlight = true;
    userStoppedTracking = false;
    updateActivityState("Creating the job and starting search...");
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
      await loadAuthState();
      await loadRecentJobs();
    } finally {
      createJobInFlight = false;
      updateActivityState();
    }
  }

  async function loadJob(jobId) {
    userStoppedTracking = false;
    const previousJobId = normalizeTextValue(currentJob && currentJob.job_id, "");
    currentJob = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (previousJobId && previousJobId !== normalizeTextValue(currentJob && currentJob.job_id, "")) {
      reviewSuggestionSource = "";
      reviewSuggestionSourceDetails = [];
    }
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
    setStatus(statusLabelForJob(currentJob), state);
    els.currentJobTitle.textContent = displayTitleForJob(currentJob);
    els.currentJobId.textContent = statusLabelForJob(currentJob);
    setMessage(messageForJob(currentJob), state === "failed");
    updateActivityState();

    candidates = useRequirementReview ? requirementCandidates : legacyCandidates;
    if (els.requirementsSection && els.requirementRows) {
      renderRequirements(requirements);
    }
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
    prefillReviewFormFromDiagnostics(state);
    updateDecisionSubmitCopy(state);
    if (els.retryFailedStepButton) {
      const hasFailedRequirement = asArray(currentJob.requirements).some(
        (item) => item && item.status === "llm_failed"
      );
      els.retryFailedStepButton.hidden = !hasFailedRequirement;
    }

    const showCandidateSection =
      !requirements.length || isLegacyCandidateFallback;
    if (els.candidateSection) {
      els.candidateSection.hidden = state !== "review" && state !== "confirmation" || !showCandidateSection;
    }
    els.decisionSection.hidden = state !== "review" && state !== "manual_required";
    const hasResourcePlans = asArray(currentJob.resource_plans).length > 0;
    if (els.confirmationSection) {
      els.confirmationSection.hidden = state !== "confirmation" || hasResourcePlans;
    }
    if (els.resourcePlanSection) {
      els.resourcePlanSection.hidden = !hasResourcePlans;
    }
    if (els.downloadConfirmRow) {
      els.downloadConfirmRow.hidden = state !== "confirmation" && state !== "manual_required";
    }
    els.resultSection.hidden = state !== "completed" && !(currentJob.downloaded_files || []).length;
  }

  function prefillReviewFormFromDiagnostics(state) {
    if (!currentJob || (state !== "review" && state !== "manual_required")) {
      renderSearchMorePrefillPreview(null);
      return;
    }
    const jobId = normalizeTextValue(currentJob.job_id, "");
    if (!jobId || reviewPrefillJobId === jobId) return;
    reviewPrefillJobId = jobId;
    applySearchMorePrefill({ force: false, source: "diagnostics_autofill", state });
  }

  function updateDecisionSubmitCopy(state) {
    if (!els.submitReviewBtn) return;
    els.submitReviewBtn.textContent = state === "manual_required"
      ? "Submit manual URLs"
      : "Submit recovery action";
  }

  function applySearchMorePrefill(options) {
    if (!currentJob) return false;
    const force = !!(options && options.force);
    const state = normalizeTextValue(options && options.state, core.classifyJobState(currentJob));
    const prefill = core.searchMorePrefillViewModel
      ? core.searchMorePrefillViewModel(currentJob)
      : null;
    if (!prefill || !prefill.should_prefill) {
      renderSearchMorePrefillPreview(null);
      return false;
    }

    const fieldsAreEmpty =
      !normalizeTextValue(els.missingRequirements && els.missingRequirements.value, "").trim() &&
      !normalizeTextValue(els.suggestedQueries && els.suggestedQueries.value, "").trim() &&
      !normalizeTextValue(els.platformHints && els.platformHints.value, "").trim();
    if (!force && !fieldsAreEmpty) return false;

    const manualSuggestions = asArray(prefill.manual_url_suggestions);
    const decision = state === "manual_required" && manualSuggestions.length
      ? "continue_with_approved"
      : prefill.decision;
    if (decision && els.decisionSelect) {
      els.decisionSelect.value = decision;
    }
    if (els.missingRequirements) {
      els.missingRequirements.value = normalizeTextList(prefill.missing_requirements).join("\n");
    }
    if (els.suggestedQueries) {
      els.suggestedQueries.value = normalizeTextList(prefill.suggested_queries).join("\n");
    }
    if (els.platformHints) {
      els.platformHints.value = normalizeTextList(prefill.platform_hints).join("\n");
    }
    reviewSuggestionSource = normalizeTextValue(
      options && options.source,
      force ? "diagnostics_button" : "diagnostics_autofill"
    ).trim();
    reviewSuggestionSourceDetails = normalizeTextList(prefill.source_details);
    if (force || state === "manual_required") {
      addManualUrlSuggestions(manualSuggestions);
    }
    renderSearchMorePrefillPreview(prefill);
    return true;
  }

  function addManualUrlSuggestions(suggestions) {
    addedCandidates = core.mergeManualUrlSuggestions
      ? asArray(core.mergeManualUrlSuggestions(addedCandidates, asArray(suggestions)))
      : addedCandidates;
    renderAddedCandidates();
  }

  function renderSearchMorePrefillPreview(prefill) {
    if (!els.searchMorePrefillPreview) return;
    const nextPlatforms = normalizeTextList(prefill && (prefill.next_platform_hints || prefill.platform_hints));
    const excludedPlatforms = normalizeTextList(prefill && prefill.excluded_platform_hints);
    const triedPlatforms = normalizeTextList(prefill && prefill.tried_platforms);
    const manualUrls = normalizeTextList(asArray(prefill && prefill.manual_url_suggestions).map((item) => item && item.url));
    if (!nextPlatforms.length && !excludedPlatforms.length && !triedPlatforms.length && !manualUrls.length) {
      els.searchMorePrefillPreview.hidden = true;
      els.searchMorePrefillPreview.innerHTML = "";
      return;
    }
    els.searchMorePrefillPreview.hidden = false;
    els.searchMorePrefillPreview.innerHTML = `
      <span class="requirement-badge">next platform hints: <span class="query-chips">${renderChipList(nextPlatforms, "query-chip")}</span></span>
      <span class="requirement-badge">excluded tried platforms: <span class="query-chips">${renderChipList(excludedPlatforms, "query-chip")}</span></span>
      <span class="requirement-badge">previously tried: <span class="query-chips">${renderChipList(triedPlatforms, "query-chip")}</span></span>
      <span class="requirement-badge">manual URL suggestions: <span class="query-chips">${renderChipList(manualUrls, "query-chip")}</span></span>
    `;
  }

  function renderSearchMoreSuggestionPreview(counts) {
    const queryCount = Number(counts && counts.queryCount || 0) || 0;
    const missingCount = Number(counts && counts.missingCount || 0) || 0;
    const platformCount = Number(counts && counts.platformCount || 0) || 0;
    const manualCount = Number(counts && counts.manualCount || 0) || 0;
    return `
      <span class="requirement-badge">will fill:
        ${esc(queryCount)} queries ·
        ${esc(missingCount)} missing items ·
        ${esc(platformCount)} platform hints ·
        ${esc(manualCount)} manual URLs
      </span>
    `;
  }

  function noDataSuggestionPreviewCounts(summaries) {
    const suggestedQueries = [];
    const platformHints = [];
    let missingCount = 0;
    asArray(summaries).forEach((summary) => {
      suggestedQueries.push(...normalizeTextList(summary && summary.suggested_queries));
      platformHints.push(...normalizeTextList(summary && summary.searched_platforms));
      const status = normalizeTextValue(summary && summary.status, "");
      if (status === "no_candidates_after_search" || status === "platform_failures_without_candidates") {
        missingCount += 1;
      }
    });
    return {
      queryCount: uniqueTextList(suggestedQueries).length,
      missingCount,
      platformCount: uniqueTextList(platformHints).length,
    };
  }

  function downloadSuggestionPreviewCounts(summary) {
    if (!summary || !summary.should_show) {
      return { queryCount: 0, missingCount: 0, platformCount: 0 };
    }
    const platformHints = [];
    let missingCount = 0;
    if (Number(summary.default_download_count || 0) === 0) missingCount += 1;
    if (Number(summary.landing_default_count || 0) > 0) missingCount += 1;
    if (Number(summary.risky_resource_count || 0) > 0) missingCount += 1;
    asArray(summary.problem_bundles).forEach((bundle) => {
      platformHints.push(normalizeTextValue(bundle && bundle.source_layer, ""));
    });
    return {
      queryCount: 0,
      missingCount,
      platformCount: uniqueTextList(platformHints).length,
      manualCount: normalizeTextList(summary.manual_url_suggestions).length,
    };
  }

  function messageForJob(job) {
    const status = normalizeTextValue(job && job.status, "");
    const planCount = asArray(job && job.resource_plans).length;
    const fileCount = asArray(job && job.downloaded_files).length;
    if (status === "searching") return "Searching data sources. The backend is still running and this page will refresh automatically.";
    if (status === "judging_bundle") return "Candidate results were found. The system is checking whether they fit your data request.";
    if (status === "planning_resources") return "Preparing the final dataset list. The page will move to download confirmation when ready.";
    if (status === "downloading") return "Downloading the selected datasets. Please wait for the result list.";
    if (status === "awaiting_review") return "Automatic search did not reach final confirmation. Use Manual recovery only if no download preview is available.";
    if (status === "needs_confirmation") {
      const countText = planCount ? `${planCount} datasets found. ` : "";
      return `${countText}Search is complete. Review the dataset list below, then confirm download.`;
    }
    if (status === "completed") {
      const countText = fileCount ? `${fileCount} download results are available. ` : "";
      return `${countText}The job is complete.`;
    }
    if (status === "manual_required") {
      const needsCredential = (job.downloaded_files || []).some(
        (file) => file && file.status === "credential_required"
      );
      if (needsCredential) {
        return "Some datasets require login or authorized access. Add an accessible URL, then retry.";
      }
      return "Automatic download did not complete. Add an alternate URL or continue recovery search.";
    }
    if (status === "insufficient") return "The current results are insufficient and the job has stopped. Try a clearer data request.";
    if (status === "failed") return core.failureDetailsForJob(job);
    return "The job has been created and is waiting for backend updates.";
  }

  function statusLabelForJob(job) {
    const status = normalizeTextValue(job && job.status, "");
    if (status === "searching") return "Searching";
    if (status === "judging_bundle") return "Checking results";
    if (status === "planning_resources") return "Preparing list";
    if (status === "downloading") return "Downloading";
    if (status === "needs_confirmation") return "Ready to confirm";
    if (status === "completed") return "Completed";
    if (status === "manual_required") return "Recovery needed";
    if (status === "awaiting_review") return "Recovery needed";
    if (status === "insufficient") return "Insufficient";
    if (status === "failed") return "Failed";
    return status || "Ready";
  }

  function activityTextForJob(job) {
    const status = normalizeTextValue(job && job.status, "");
    if (status === "searching") return "Searching across metadata and data platforms...";
    if (status === "judging_bundle") return "Checking whether the results satisfy your request...";
    if (status === "planning_resources") return "Preparing the final dataset list...";
    if (status === "downloading") return "Downloading selected datasets...";
    return "Working on this dataset job...";
  }

  function activitySubtextForJob(job) {
    const status = normalizeTextValue(job && job.status, "");
    if (status === "searching") return "Looking across metadata indexes, open data portals, and platform search results.";
    if (status === "judging_bundle") return "Filtering candidate links into datasets that match your request.";
    if (status === "planning_resources") return "Preparing clean dataset cards for final confirmation.";
    if (status === "downloading") return "Saving selected files on the research server.";
    return "The page will refresh automatically while the server works.";
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
        <td>
          <div class="dataset-title">${esc(safeCandidate.title)}</div>
          <a href="${esc(safeCandidate.url)}" target="_blank" rel="noreferrer">${esc(safeCandidate.url)}</a>
          <div class="muted dataset-reason">${esc(safeCandidate.llm_recommendation_reason || safeCandidate.reason)}</div>
        </td>
        <td>${esc(safeCandidate.source_id || safeCandidate.source_provider || safeCandidate.source_layer)}</td>
        <td>${esc(safeCandidate.role)}</td>
        <td>${esc(formatCoverageTags(safeCandidate.coverage_tags))}</td>
        <td>${esc(Number.isFinite(Number(safeCandidate.llm_fit_score)) ? Number(safeCandidate.llm_fit_score).toFixed(2) : "selected")}</td>
      </tr>
    `;
  }

  function formatCoverageTags(values) {
    return normalizeTextList(values)
      .map((item) => item.startsWith("query:") ? `matched query:${item.slice("query:".length)}` : item)
      .join(", ");
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

  function renderSearchMoreRoundTrace(requirement) {
    const traceRows = asArray(requirement && requirement.rounds)
      .filter((round) => normalizeTextValue(round && round.search_more_source, "").trim())
      .map((round) => {
        const roundIndex = Number(round && round.round_index || 0) || 0;
        const details = normalizeTextList(round && round.search_more_source_details);
        const source = normalizeTextValue(round && round.search_more_source, "search_more");
        const queries = normalizeTextList(round && round.queries).slice(0, 6);
        const split = core.splitRoundCandidates
          ? core.splitRoundCandidates(round)
          : { useful: [], rejected: [], unjudged: [] };
        const usefulCount = asArray(split && split.useful).length;
        const totalCount = asArray(round && round.candidates).length;
        return { roundIndex, details, source, queries, usefulCount, totalCount };
      });
    if (!traceRows.length) return "";
    return `
      <div class="dataset-mini-table-wrap search-more-trace">
        <table class="dataset-mini-table">
          <thead>
            <tr>
              <th>Search more trace</th>
              <th>Source details</th>
              <th>Queries</th>
              <th>Useful / total candidates</th>
            </tr>
          </thead>
          <tbody>
            ${traceRows.map((row) => `
              <tr>
                <td>round ${esc(row.roundIndex || "?")}</td>
                <td><span class="query-chips">${renderChipList(row.details.length ? row.details : [row.source], "query-chip")}</span></td>
                <td><span class="query-chips">${renderChipList(row.queries, "query-chip")}</span></td>
                <td>${esc(row.usefulCount)} / ${esc(row.totalCount)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderRequirements(requirements) {
    if (!els.requirementsSection || !els.requirementRows) return;
    const requirementList = asArray(requirements);

    els.requirementRows.innerHTML = "";
    const searchMoreTraceSummaryNode = renderSearchMoreTraceSummary();
    if (searchMoreTraceSummaryNode) {
      els.requirementRows.appendChild(searchMoreTraceSummaryNode);
    }
    const diagnosticsNode = renderNoDataDiagnostics();
    if (diagnosticsNode) {
      els.requirementRows.appendChild(diagnosticsNode);
    }
    const downloadDiagnosticsNode = renderDownloadDiagnostics();
    if (downloadDiagnosticsNode) {
      els.requirementRows.appendChild(downloadDiagnosticsNode);
    }
    if (!requirementList.length) {
      els.requirementsSection.hidden = !els.requirementRows.children.length;
      return;
    }
    els.requirementsSection.hidden = false;

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
      `;

      item.appendChild(header);
      item.appendChild(descriptionNode);
      item.appendChild(meta);
      const searchMoreTrace = renderSearchMoreRoundTrace(safeRequirement);
      if (searchMoreTrace) {
        item.insertAdjacentHTML("beforeend", searchMoreTrace);
      }
      const requirementModel = asArray(groupedRequirements).find((entry) => Number(entry && entry.requirementIndex) === requirementIndex) || null;
      const queryList = asArray(requirementModel && requirementModel.queries);
      const usefulCandidateCount = queryList.reduce((total, queryGroup) => (
        total + asArray(queryGroup && queryGroup.sourceGroups).reduce(
          (sourceTotal, sourceGroup) => sourceTotal + asArray(sourceGroup && sourceGroup.candidates).length,
          0
        )
      ), 0);
      const rejectedCount = asArray(rejectedByRequirement.get(requirementIndex)).length;
      const summaryMeta = document.createElement("div");
      summaryMeta.className = "requirement-meta requirement-outcome";
      summaryMeta.innerHTML = `
        <span class="requirement-badge">LLM selected: ${esc(usefulCandidateCount)}</span>
        <span class="requirement-badge">LLM rejected: ${esc(rejectedCount)}</span>
      `;
      item.appendChild(summaryMeta);
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
                <th>Dataset</th>
                <th>Provider</th>
                <th>Role</th>
                <th>Coverage</th>
                <th>LLM score</th>
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

      const details = document.createElement("details");
      details.className = "advanced-details";
      if (usefulCandidateCount > 0) {
        const summary = document.createElement("summary");
        summary.textContent = `LLM-selected candidates and query details (${usefulCandidateCount})`;
        details.appendChild(summary);
        details.appendChild(queryGroups);
        item.appendChild(details);
      } else {
        item.appendChild(queryGroups);
      }
      els.requirementRows.appendChild(item);
    });
  }

  function renderSearchMoreTraceSummary() {
    const summary = core.searchMoreTraceSummaryViewModel
      ? core.searchMoreTraceSummaryViewModel(currentJob || {})
      : null;
    if (!summary || !summary.should_show) return null;

    const panel = document.createElement("section");
    panel.className = "requirement-item search-more-trace-summary";
    const heading = document.createElement("div");
    heading.className = "requirement-head";
    heading.innerHTML = `
      <h3 class="requirement-title">Search more outcome</h3>
      <span class="pill requirement-badge">${esc(summary.useful_candidate_count)} useful · ${esc(summary.total_candidate_count)} total candidates</span>
      <span class="requirement-badge">${esc(summary.outcome_message)}</span>
      <span class="requirement-badge">follow-up rounds: ${esc(summary.followup_round_count)}</span>
      <span class="requirement-badge">sources: <span class="query-chips">${renderChipList(summary.source_details, "query-chip")}</span></span>
    `;
    panel.appendChild(heading);

    const requirements = normalizeTextList(summary.requirement_titles);
    if (requirements.length) {
      const meta = document.createElement("div");
      meta.className = "requirement-meta";
      meta.innerHTML = `<span class="requirement-badge">requirements: <span class="query-chips">${renderChipList(requirements, "query-chip")}</span></span>`;
      panel.appendChild(meta);
    }

    const triedPlatforms = normalizeTextList(summary.tried_platforms);
    if (triedPlatforms.length) {
      const meta = document.createElement("div");
      meta.className = "requirement-meta";
      meta.innerHTML = `<span class="requirement-badge">tried platforms: <span class="query-chips">${renderChipList(triedPlatforms, "query-chip")}</span></span>`;
      panel.appendChild(meta);
    }
    return panel;
  }

  function renderNoDataDiagnostics() {
    const summaries = core.noDataDiagnosticsViewModel
      ? asArray(core.noDataDiagnosticsViewModel(currentJob))
      : [];
    if (!summaries.length) return null;

    const panel = document.createElement("details");
    panel.className = "requirement-item no-data-diagnostics advanced-details";
    const recoveredCount = summaries.filter((item) => item.status === "recovered_after_no_data").length;
    const unresolvedCount = summaries.length - recoveredCount;
    const heading = document.createElement("summary");
    heading.innerHTML = `
      <span class="requirement-title">Search diagnostics</span>
      <span class="pill requirement-badge">${esc(unresolvedCount)} unresolved · ${esc(recoveredCount)} recovered</span>
      <span class="requirement-badge">suggestion source: no-data diagnostics</span>
      ${renderSearchMoreSuggestionPreview(noDataSuggestionPreviewCounts(summaries))}
      <button type="button" class="action-btn" data-action="use-search-more-suggestions">Use suggestions</button>
    `;
    panel.appendChild(heading);

    summaries.forEach((summary) => {
      const item = document.createElement("section");
      item.className = "query-group";
      const title = document.createElement("h4");
      title.textContent = `${summary.label}: ${summary.title}`;
      item.appendChild(title);

      const meta = document.createElement("p");
      meta.className = "dataset-mini-note";
      meta.textContent = `${summary.round_count} rounds, ${summary.candidate_count} candidates.`;
      item.appendChild(meta);

      const platforms = document.createElement("div");
      platforms.className = "requirement-meta";
      platforms.innerHTML = `
        <span class="requirement-badge">platforms: <span class="query-chips">${renderChipList(summary.searched_platforms, "query-chip")}</span></span>
        <span class="requirement-badge">reasons: <span class="query-chips">${renderChipList(summary.reasons, "query-chip")}</span></span>
        <span class="requirement-badge">platform search status: <span class="query-chips">${renderChipList(summary.platform_search_statuses, "query-chip")}</span></span>
      `;
      item.appendChild(platforms);

      const statusMessages = normalizeTextList(summary.platform_search_status_messages);
      if (statusMessages.length) {
        const statusLine = document.createElement("div");
        statusLine.className = "requirement-meta";
        statusLine.innerHTML = `<span class="requirement-badge">status notes: <span class="query-chips">${renderChipList(statusMessages, "query-chip")}</span></span>`;
        item.appendChild(statusLine);
      }

      const queries = normalizeTextList(summary.attempted_queries);
      if (queries.length) {
        const queryLine = document.createElement("div");
        queryLine.className = "requirement-meta";
        queryLine.innerHTML = `<span class="requirement-badge">queries tried: <span class="query-chips">${renderChipList(queries.slice(0, 8), "query-chip")}</span></span>`;
        item.appendChild(queryLine);
      }

      const platformRows = asArray(summary.platform_rows);
      if (platformRows.length) {
        const tableWrap = document.createElement("div");
        tableWrap.className = "dataset-mini-table-wrap";
        const table = document.createElement("table");
        table.className = "dataset-mini-table";
        table.innerHTML = `
          <thead>
            <tr>
              <th>Platform diagnostics</th>
              <th>Status</th>
              <th>Results</th>
              <th>Rounds</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${platformRows.map((row) => `
              <tr>
                <td>${esc(row.platform_id)}</td>
                <td>${esc(row.label || row.status)}</td>
                <td>${esc(row.result_count || 0)}</td>
                <td>${esc(normalizeTextList(row.rounds).join(", "))}</td>
                <td><span class="query-chips">${renderChipList(row.notes, "query-chip")}</span></td>
              </tr>
            `).join("")}
          </tbody>
        `;
        tableWrap.appendChild(table);
        item.appendChild(tableWrap);
      }

      const suggestions = normalizeTextList(summary.suggested_queries);
      if (suggestions.length) {
        const suggestionLine = document.createElement("div");
        suggestionLine.className = "requirement-meta";
        suggestionLine.innerHTML = `<span class="requirement-badge">suggested next queries: <span class="query-chips">${renderChipList(suggestions.slice(0, 8), "query-chip")}</span></span>`;
        item.appendChild(suggestionLine);
      }

      panel.appendChild(item);
    });
    return panel;
  }

  function renderDownloadDiagnostics() {
    const summary = core.downloadDiagnosticsViewModel
      ? core.downloadDiagnosticsViewModel(currentJob || {})
      : null;
    if (!summary || !summary.should_show) return null;

    const panel = document.createElement("details");
    panel.className = "requirement-item download-diagnostics advanced-details";
    const heading = document.createElement("summary");
    const manualSuggestionCount = normalizeTextList(
      asArray(summary.manual_url_suggestions).map((item) => item && item.url)
    ).length;
    const actionLabel = manualSuggestionCount
      ? "Use suggestions: add manual URLs"
      : "Use suggestions";
    heading.innerHTML = `
      <span class="requirement-title">Download diagnostics</span>
      <span class="pill requirement-badge">${esc(summary.default_download_count)} default downloads · ${esc(summary.risky_resource_count)} risky resources · ${esc(summary.failed_download_resource_count || 0)} failed downloads</span>
      <span class="requirement-badge">suggestion source: download diagnostics</span>
      ${renderSearchMoreSuggestionPreview(downloadSuggestionPreviewCounts(summary))}
      <button type="button" class="action-btn" data-action="use-search-more-suggestions">${esc(actionLabel)}</button>
    `;
    panel.appendChild(heading);

    const meta = document.createElement("div");
    meta.className = "requirement-meta";
    meta.innerHTML = `
      <span class="requirement-badge">bundles: ${esc(summary.bundle_count)}</span>
      <span class="requirement-badge">landing defaults: ${esc(summary.landing_default_count)}</span>
    `;
    panel.appendChild(meta);

    const followupItems = asArray(summary.manual_followup_items).slice(0, 6);
    if (followupItems.length) {
      const item = document.createElement("section");
      item.className = "query-group";
      const title = document.createElement("h4");
      title.textContent = "Manual follow-up";
      item.appendChild(title);
      const tableWrap = document.createElement("div");
      tableWrap.className = "dataset-mini-table-wrap";
      const table = document.createElement("table");
      table.className = "dataset-mini-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th>Resource</th>
            <th>Suggested role</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Next step</th>
            <th>URL</th>
          </tr>
        </thead>
        <tbody>
          ${followupItems.map((resource) => `
            <tr>
              <td>${esc(resource.title || "Manual resource")}</td>
              <td>${esc(resource.suggested_role || "primary")}</td>
              <td>${esc(resource.status || "")}</td>
              <td>${esc(resource.reason || "")}</td>
              <td>${esc(resource.next_step || "")}</td>
              <td><a href="${esc(resource.url)}" target="_blank" rel="noreferrer">${esc(resource.url)}</a></td>
            </tr>
          `).join("")}
        </tbody>
      `;
      tableWrap.appendChild(table);
      item.appendChild(tableWrap);
      panel.appendChild(item);
    }

    asArray(summary.problem_bundles).slice(0, 6).forEach((bundle) => {
      const item = document.createElement("section");
      item.className = "query-group";
      const title = document.createElement("h4");
      title.textContent = `Bundle needs review: ${bundle.title || bundle.bundle_id}`;
      item.appendChild(title);
      const details = document.createElement("div");
      details.className = "requirement-meta";
      details.innerHTML = `
        <span class="requirement-badge">resources: ${esc(bundle.resource_count)}</span>
        <span class="requirement-badge">default downloads: ${esc(bundle.default_download_count)}</span>
        <span class="requirement-badge">source: ${esc(bundle.source_layer || "unknown")}</span>
      `;
      item.appendChild(details);
      const strategies = normalizeTextList(bundle.download_strategies);
      if (strategies.length) {
        const row = document.createElement("div");
        row.className = "requirement-meta";
        row.innerHTML = `<span class="requirement-badge">strategies: <span class="query-chips">${renderChipList(strategies, "query-chip")}</span></span>`;
        item.appendChild(row);
      }
      const risks = normalizeTextList(bundle.access_risks);
      if (risks.length) {
        const row = document.createElement("div");
        row.className = "requirement-meta";
        row.innerHTML = `<span class="requirement-badge">risks: <span class="query-chips">${renderChipList(risks, "query-chip")}</span></span>`;
        item.appendChild(row);
      }
      panel.appendChild(item);
    });

    const riskyResources = asArray(summary.risky_resources).slice(0, 6);
    if (riskyResources.length) {
      const details = document.createElement("details");
      details.className = "rejected-panel";
      const summaryNode = document.createElement("summary");
      summaryNode.textContent = `Risky resources (${summary.risky_resource_count})`;
      details.appendChild(summaryNode);
      const tableWrap = document.createElement("div");
      tableWrap.className = "dataset-mini-table-wrap";
      const table = document.createElement("table");
      table.className = "dataset-mini-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th>Title</th>
            <th>Risk</th>
            <th>Strategy</th>
            <th>URL</th>
            <th>Preflight</th>
          </tr>
        </thead>
      `;
      const tbody = document.createElement("tbody");
      riskyResources.forEach((resource) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${esc(resource.title)}</td>
          <td>${esc(resource.access_risk)}</td>
          <td>${esc(resource.download_strategy)}</td>
          <td><a href="${esc(resource.url)}" target="_blank" rel="noreferrer">${esc(resource.url)}</a></td>
          <td>${esc(resource.preflight_reason)}</td>
        `;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      details.appendChild(tableWrap);
      panel.appendChild(details);
    }

    const failedDownloads = asArray(summary.failed_download_resources).slice(0, 6);
    if (failedDownloads.length) {
      const details = document.createElement("details");
      details.className = "rejected-panel";
      const summaryNode = document.createElement("summary");
      summaryNode.textContent = `Failed downloads (${summary.failed_download_resource_count})`;
      details.appendChild(summaryNode);
      const tableWrap = document.createElement("div");
      tableWrap.className = "dataset-mini-table-wrap";
      const table = document.createElement("table");
      table.className = "dataset-mini-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th>Title</th>
            <th>Status</th>
            <th>Reason</th>
            <th>URL</th>
          </tr>
        </thead>
      `;
      const tbody = document.createElement("tbody");
      failedDownloads.forEach((resource) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${esc(resource.title || "Failed download")}</td>
          <td>${esc(resource.status || "unknown")}</td>
          <td>${esc(resource.reason || "")}</td>
          <td><a href="${esc(resource.url)}" target="_blank" rel="noreferrer">${esc(resource.url)}</a></td>
        `;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      details.appendChild(tableWrap);
      panel.appendChild(details);
    }
    return panel;
  }

  function renderCandidates() {
    if (!els.candidateRows) return;
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
        <td>${esc(formatCoverageTags(candidate.coverage_tags))}</td>
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
    if (!els.candidateCount) return;
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
      els.candidateDisplayLimit ? els.candidateDisplayLimit.value : candidates.length,
      candidates.length || 1
    );
    if (els.candidateDisplayLimit) {
      els.candidateDisplayLimit.max = String(Math.max(candidates.length, 1));
      els.candidateDisplayLimit.value = String(displayLimit);
    }
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
    if (!els.judgmentBody) return;
    const judgment = currentJob && currentJob.bundle_judgment ? currentJob.bundle_judgment : {};
    const missing = normalizeTextList(judgment.missing_requirements);
    const reasons = normalizeTextList([
      judgment.reason,
      judgment.summary,
      judgment.evidence,
    ]);
    const lines = [
      `LLM sufficiency: ${judgment.sufficient === true ? "sufficient" : judgment.sufficient === false ? "needs confirmation" : "unknown"}`,
      `Missing requirements: ${missing.length ? missing.join("; ") : "none reported"}`,
      `Reason: ${reasons.length ? reasons.join(" ") : "No summary provided."}`,
    ];
    els.judgmentBody.textContent = lines.join("\n");
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
      searchMoreSource: els.decisionSelect.value === "search_more" ? reviewSuggestionSource : "",
      searchMoreSourceDetails: els.decisionSelect.value === "search_more" ? reviewSuggestionSourceDetails : [],
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
    if (asArray(currentJob.resource_plans).length) {
      await apiFetch(`/api/jobs/${encodeURIComponent(currentJob.job_id)}/resource-plans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(core.buildResourcePlanUpdatePayload(currentJob.resource_plans || [])),
      });
    }
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
    const rawPlans = asArray(currentJob && currentJob.resource_plans);
    els.resourcePlanRows.innerHTML = "";
    if (els.downloadPreviewSummary) {
      els.downloadPreviewSummary.innerHTML = "";
    }
    if (!plans.length) return;
    const allResources = rawPlans.flatMap((plan) => asArray(plan && plan.resources));
    const sourceNames = uniqueTextList(allResources.map((resource) => (
      normalizeTextValue(resource && (resource.platform || resource.source_provider || resource.resource_type), "")
    ))).slice(0, 5);
    if (els.downloadPreviewSummary) {
      els.downloadPreviewSummary.innerHTML = `
        <div class="result-summary-line">
          <strong>${esc(countSelectableResources())}</strong>
          <span>datasets found</span>
        </div>
        ${sourceNames.length ? `<div class="source-chip-row">${renderChipList(sourceNames, "query-chip")}</div>` : ""}
      `;
    }
    rawPlans.forEach((plan, planIndex) => {
      const resources = asArray(plan && plan.resources)
        .map((resource, resourceIndex) => ({ resource, resourceIndex }))
        .filter((entry) => {
          const resource = entry.resource || {};
          return normalizeTextValue(resource.url, "") && normalizeTextValue(resource.role, "") !== "reject";
        });
      resources.forEach((entry) => {
        const resource = entry.resource || {};
        if (resource.selected_for_download !== false) {
          resource.selected_for_download = true;
        }
        const article = document.createElement("article");
        article.className = "dataset-result-card";
        const source = normalizeTextValue(
          resource.platform || resource.source_provider || hostnameFromUrl(resource.url),
          "Open data source"
        );
        const linkType = linkTypeLabel(resource);
        article.innerHTML = `
          <label class="dataset-select">
            <input
              type="checkbox"
              data-plan-index="${esc(planIndex)}"
              data-resource-index="${esc(entry.resourceIndex)}"
              data-field="selected_for_download"
              ${resource.selected_for_download ? "checked" : ""}
            />
            <span></span>
          </label>
          <div class="dataset-card-main">
            <div class="dataset-card-head">
              <h3>${esc(resource.title || resource.resource_id || "Untitled dataset")}</h3>
              <div class="dataset-card-tags">
                <span>${esc(source)}</span>
                <span>${esc(linkType)}</span>
              </div>
            </div>
            <p>${esc(resource.reason || resource.expected_format || "Relevant dataset candidate found by the search system.")}</p>
            <a class="dataset-card-url" href="${esc(resource.url)}" target="_blank" rel="noreferrer">${esc(resource.url)}</a>
          </div>
        `;
        els.resourcePlanRows.appendChild(article);
      });
    });
    updateSelectionSummary();
  }

  function hostnameFromUrl(value) {
    try {
      return new URL(String(value || "")).hostname.replace(/^www\./, "");
    } catch (_) {
      return "";
    }
  }

  function linkTypeLabel(resource) {
    const strategy = normalizeTextValue(resource && resource.download_strategy, "").toLowerCase();
    const format = normalizeTextValue(resource && resource.expected_format, "").toLowerCase();
    if (strategy.includes("direct") || /\.(csv|json|geojson|zip|xlsx?|parquet)(\?|$)/i.test(normalizeTextValue(resource && resource.url, ""))) {
      return "Direct file";
    }
    if (format.includes("api")) return "API";
    return "Source page";
  }

  function countSelectableResources() {
    return asArray(currentJob && currentJob.resource_plans)
      .flatMap((plan) => asArray(plan && plan.resources))
      .filter((resource) => resource && normalizeTextValue(resource.url, "") && normalizeTextValue(resource.role, "") !== "reject")
      .length;
  }

  function countSelectedResources() {
    return asArray(currentJob && currentJob.resource_plans)
      .flatMap((plan) => asArray(plan && plan.resources))
      .filter((resource) => (
        resource &&
        normalizeTextValue(resource.url, "") &&
        normalizeTextValue(resource.role, "") !== "reject" &&
        resource.selected_for_download !== false
      ))
      .length;
  }

  function updateSelectionSummary() {
    const selectedCount = countSelectedResources();
    if (els.selectionSummary) {
      els.selectionSummary.textContent = `${selectedCount} datasets selected. Files will be saved to the research server.`;
    }
    if (els.forceDownloadBtn) {
      els.forceDownloadBtn.disabled = selectedCount === 0 || isJobRunning(currentJob);
      els.forceDownloadBtn.textContent = isJobRunning(currentJob) ? "Working..." : "Confirm & Download";
    }
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
      updateSelectionSummary();
      return;
    }
    if (field === "selected_for_download") {
      resource.selected_for_download = !!target.checked;
      updateSelectionSummary();
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
    if (els.connectionBadge) {
      els.connectionBadge.innerHTML = `<span class="connection-dot"></span>Server connected`;
      els.connectionBadge.dataset.state = "success";
    }
    els.recentJobs.innerHTML = "";
    const jobs = asArray(payload.jobs);
    if (!jobs.length) {
      els.recentJobs.innerHTML = `<div class="empty-sidebar-state">No recent searches yet.</div>`;
      return;
    }
    const sortedJobs = jobs
      .slice()
      .sort((left, right) => parseJobTime(right) - parseJobTime(left));
    let currentGroup = "";
    sortedJobs.forEach((job) => {
      const timestamp = parseJobTime(job);
      const group = recentGroupLabel(timestamp);
      if (group !== currentGroup) {
        currentGroup = group;
        const groupNode = document.createElement("div");
        groupNode.className = "recent-group-label";
        groupNode.textContent = group;
        els.recentJobs.appendChild(groupNode);
      }
      const jobLabel = displayTitleForJob(job);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recent-job-item";
      button.innerHTML = `
        <span class="recent-status-dot" data-status="${esc(normalizeTextValue(job.status, ""))}"></span>
        <span class="recent-job-text">
          <strong>${esc(jobLabel)}</strong>
          <small>${esc([statusLabelForJob(job), relativeJobTime(timestamp)].filter(Boolean).join(" · "))}</small>
        </span>
      `;
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
    if (els.connectionBadge) {
      els.connectionBadge.innerHTML = `<span class="connection-dot"></span>Server issue`;
      els.connectionBadge.dataset.state = "error";
    }
    if (els.authError && els.authOverlay && !els.authOverlay.hidden) {
      els.authError.textContent = err && err.message ? err.message : String(err);
    }
  }

  function bindEvents() {
    if (els.sidebarToggle) {
      els.sidebarToggle.addEventListener("click", () => {
        const isOpen = normalizeTextValue(els.datasetShell && els.datasetShell.dataset.sidebar, "open") !== "closed";
        if (els.datasetShell) els.datasetShell.dataset.sidebar = isOpen ? "closed" : "open";
      });
    }
    if (els.newSearchBtn) {
      els.newSearchBtn.addEventListener("click", resetSearchCanvas);
    }
    if (els.stopSearchBtn) {
      els.stopSearchBtn.addEventListener("click", stopTrackingCurrentSearch);
    }
    if (els.datasetAuthForm) {
      els.datasetAuthForm.addEventListener("submit", (event) => loginWithPassword(event).catch(showError));
    }
    if (els.guestLoginBtn) {
      els.guestLoginBtn.addEventListener("click", () => loginAsGuest().catch(showError));
    }
    if (els.logoutBtn) {
      els.logoutBtn.addEventListener("click", () => logout().catch(showError));
    }
    if (els.createJobBtn) {
      els.createJobBtn.addEventListener("click", () => createJob().catch(showError));
    }
    if (els.submitReviewBtn) {
      els.submitReviewBtn.addEventListener("click", () => submitReview().catch(showError));
    }
    if (els.forceDownloadBtn) {
      els.forceDownloadBtn.addEventListener("click", () => forceDownload().catch(showError));
    }
    if (els.retryFailedStepButton) {
      els.retryFailedStepButton.addEventListener("click", () => retryFailedStep().catch(showError));
    }
    if (els.refreshJobsBtn) {
      els.refreshJobsBtn.addEventListener("click", () => loadRecentJobs().catch(showError));
    }
    if (els.inputMode) {
      els.inputMode.addEventListener("change", syncInputMode);
    }
    if (els.candidateDisplayLimit) {
      els.candidateDisplayLimit.addEventListener("input", renderCandidates);
    }
    if (els.addUrlBtn) {
      els.addUrlBtn.addEventListener("click", () => {
        addedCandidates.push({ title: "", url: "", role: "primary", reason: "", coverageTagsText: "" });
        renderAddedCandidates();
      });
    }
    if (els.candidateRows) {
      els.candidateRows.addEventListener("input", handleCandidateInput);
    }
    if (els.requirementRows) {
      els.requirementRows.addEventListener("input", handleCandidateInput);
      els.requirementRows.addEventListener("click", (event) => {
        const action = event.target && event.target.dataset
          ? event.target.dataset.action
          : "";
        if (action !== "use-search-more-suggestions") return;
        const state = currentJob ? core.classifyJobState(currentJob) : "";
        if (applySearchMorePrefill({ force: true, source: "diagnostics_button", state }) && els.decisionSection) {
          els.decisionSection.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    }
    if (els.resourcePlanRows) {
      els.resourcePlanRows.addEventListener("input", handleResourcePlanInput);
      els.resourcePlanRows.addEventListener("click", (event) => {
        if (event.target && event.target.dataset && event.target.dataset.action === "save-resource-plans") {
          saveResourcePlans().catch(showError);
        }
      });
    }
    if (els.addedUrlRows) {
      els.addedUrlRows.addEventListener("input", handleAddedInput);
      els.addedUrlRows.addEventListener("click", (event) => {
        const index = Number(event.target.dataset.removeAdded);
        if (!Number.isFinite(index)) return;
        addedCandidates.splice(index, 1);
        renderAddedCandidates();
      });
    }
    syncInputMode();
  }

  bindEvents();
  loadStoredAuthToken();
  loadAuthState()
    .then((state) => {
      if (state && state.authenticated) {
        return loadRecentJobs();
      }
      return null;
    })
    .catch(() => {
      showAuthOverlay("Backend is not reachable or the session expired.");
    });
})();
