(function (root) {
  "use strict";

  const HOST_OBJECT = getHostConstructor("Object", Object);
  const HOST_ARRAY = getHostConstructor("Array", Array);
  const HOST_URL = getHostConstructor("URL", typeof URL === "function" ? URL : null);

  function getHostConstructor(name, fallback) {
    try {
      const moduleExports = typeof module === "object" && module ? module.exports : null;
      if (!moduleExports) return fallback;
      const hostFunction = Object.getPrototypeOf(moduleExports).constructor.constructor;
      const value = hostFunction(`return ${name};`)();
      return typeof value === "function" ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function createHostObject(value) {
    const output = new HOST_OBJECT();
    Object.keys(value || {}).forEach((key) => {
      output[key] = value[key];
    });
    return output;
  }

  function createHostArray(items) {
    const output = new HOST_ARRAY();
    (items || []).forEach((item) => output.push(item));
    return output;
  }

  function normalizePlatformHints(text) {
    return createHostArray(splitLines(text));
  }

  function buildCreateJobPayload(title, abstract, platformHintsText) {
    const isOptionsObject = arguments.length === 1 && title && typeof title === "object" && !Array.isArray(title);
    if (!isOptionsObject) {
      const cleanTitle = String(title || "").trim();
      const cleanAbstract = String(abstract || "").trim();
      if (!cleanTitle) {
        throw new Error("title is required");
      }
      if (!cleanAbstract) {
        throw new Error("abstract is required");
      }
      return createHostObject({
        input_mode: "idea",
        title: cleanTitle,
        abstract: cleanAbstract,
        dataset_requirement: "",
        platform_hints: normalizePlatformHints(platformHintsText),
      });
    }

    const options = title || {};
    const inputMode = String(options.inputMode || options.input_mode || "idea");
    const cleanTitle = String(options.title || "").trim();
    const cleanAbstract = String(options.abstract || "").trim();
    const datasetRequirement = String(
      options.datasetRequirement || options.dataset_requirement || ""
    ).trim();

    if (inputMode === "dataset_requirement") {
      if (!datasetRequirement) {
        throw new Error("dataset requirement is required");
      }
      return createHostObject({
        input_mode: inputMode,
        title: "",
        abstract: "",
        dataset_requirement: datasetRequirement,
        platform_hints: normalizePlatformHints(options.platformHintsText),
      });
    }

    if (!cleanTitle) {
      throw new Error("title is required");
    }
    if (!cleanAbstract) {
      throw new Error("abstract is required");
    }
    return createHostObject({
      input_mode: "idea",
      title: cleanTitle,
      abstract: cleanAbstract,
      dataset_requirement: "",
      platform_hints: normalizePlatformHints(options.platformHintsText),
    });
  }

  function splitRoundCandidates(round) {
    const candidates = Array.isArray(round && round.candidates)
      ? round.candidates
      : [];
    const judgments = Array.isArray(
      round &&
        round.llm_judgment &&
        round.llm_judgment.candidate_judgments
    )
      ? round.llm_judgment.candidate_judgments
      : [];
    const useful = [];
    const rejected = [];
    const unjudged = [];

    const judgmentByUrl = new Map();
    judgments.forEach((judgment) => {
      const candidateUrl = String(
        judgment && (judgment.candidate_url || judgment.url)
      ).trim();
      if (candidateUrl && !judgmentByUrl.has(candidateUrl)) {
        judgmentByUrl.set(candidateUrl, judgment);
      }
    });

    candidates.forEach((candidate) => {
      const candidateUrl = String(candidate && candidate.url || "").trim();
      const judgment = candidateUrl ? judgmentByUrl.get(candidateUrl) : undefined;
      const row = createHostObject({ candidate, judgment: judgment || null });
      if (!judgment) {
        unjudged.push(row);
      } else if (judgment.useful) {
        useful.push(row);
      } else {
        rejected.push(row);
      }
    });

    return createHostObject({
      useful: createHostArray(useful),
      rejected: createHostArray(rejected),
      unjudged: createHostArray(unjudged),
    });
  }

  function buildRequirementQuerySourceModel(requirements) {
    function normalizeRoundIndex(round, fallbackIndex) {
      const parsed = Number(round && round.round_index);
      if (Number.isFinite(parsed)) return parsed;
      return fallbackIndex + 1;
    }

    function resolveQueryContext(round, roundIndex, candidate) {
      const candidateQueryId = String(candidate && candidate.query_id || "").trim();
      const candidateQueryText = String(candidate && candidate.query_text || "").trim();
      if (candidateQueryId || candidateQueryText) {
        return {
          query_id: candidateQueryId || candidateQueryText,
          query_text: candidateQueryText || candidateQueryId,
        };
      }

      const queryPlans = Array.isArray(round && round.query_plans) ? round.query_plans : [];
      if (queryPlans.length === 1) {
        const plan = queryPlans[0] || {};
        const planQueryId = String(plan.query_id || "").trim();
        const planQueryText = String(plan.query_text || "").trim();
        return {
          query_id: planQueryId || `round-${roundIndex}-query-1`,
          query_text: planQueryText || `round-${roundIndex}-query-1`,
        };
      }

      const queries = Array.isArray(round && round.queries) ? round.queries : [];
      if (queries.length === 1) {
        const fallback = queries[0] || {};
        const fallbackText = String(
          fallback.query_text || fallback.query || fallback.text || ""
        ).trim();
        return {
          query_id: `round-${roundIndex}-query-1`,
          query_text: fallbackText || `round-${roundIndex}-query-1`,
        };
      }

      return {
        query_id: `round-${roundIndex}-unassigned-query`,
        query_text: `round-${roundIndex}-unassigned-query`,
      };
    }

    const reviewCandidates = [];
    const rejected = [];
    const requirementModels = [];
    (Array.isArray(requirements) ? requirements : []).forEach((requirement, requirementIndex) => {
      const queryMap = new Map();
      (Array.isArray(requirement && requirement.rounds) ? requirement.rounds : []).forEach((round, roundOffset) => {
        const roundIndex = normalizeRoundIndex(round, roundOffset);
        const split = splitRoundCandidates(round);
        split.useful.forEach((entry) => {
          const candidate = entry && entry.candidate ? entry.candidate : {};
          const queryContext = resolveQueryContext(round, roundIndex, candidate);
          const queryId = queryContext.query_id;
          const queryText = queryContext.query_text;
          const sourceId = String(candidate.source_id || candidate.source_provider || "unknown").trim();
          if (!queryMap.has(queryId)) {
            queryMap.set(queryId, {
              query_id: queryId,
              query_text: queryText,
              sourceGroups: new Map(),
            });
          }
          const queryGroup = queryMap.get(queryId);
          if (!queryGroup.sourceGroups.has(sourceId)) {
            queryGroup.sourceGroups.set(sourceId, {
              source_id: sourceId,
              candidates: [],
            });
          }
          const row = Object.assign({}, candidate, {
            approved: candidate.approved !== false,
            rejected: !!candidate.rejected,
            rejectReason: candidate.rejectReason || "",
            _requirementIndex: requirementIndex,
          });
          reviewCandidates.push(row);
          queryGroup.sourceGroups.get(sourceId).candidates.push(row);
        });
        split.rejected.forEach((entry) => {
          const rejectedRow = Object.assign({}, entry, {
            _requirementIndex: requirementIndex,
          });
          rejected.push(rejectedRow);
        });
      });
      const queries = Array.from(queryMap.values()).map((queryGroup) => ({
        query_id: queryGroup.query_id,
        query_text: queryGroup.query_text,
        sourceGroups: Array.from(queryGroup.sourceGroups.values()),
      }));
      requirementModels.push({
        requirement,
        requirementIndex,
        queries,
      });
    });
    return createHostObject({
      requirements: createHostArray(requirementModels),
      reviewCandidates: createHostArray(reviewCandidates),
      rejected: createHostArray(rejected),
    });
  }

  function isHttpUrl(value) {
    const text = String(value || "").trim();
    const URLConstructor = HOST_URL || (typeof URL === "function" ? URL : null);
    if (!URLConstructor || /^https?:\/{3,}/i.test(text)) {
      return false;
    }
    try {
      const parsed = new URLConstructor(text);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname;
    } catch (_) {
      return false;
    }
  }

  function splitLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function normalizeManualCandidate(item) {
    const url = String(item && item.url ? item.url : "").trim();
    if (!isHttpUrl(url)) {
      throw new Error(`Manual candidate URL must use http or https: ${url}`);
    }
    const coverageText = item && item.coverageTagsText ? item.coverageTagsText : "";
    const coverageTags = Array.isArray(item && item.coverage_tags)
      ? item.coverage_tags.map(String).filter(Boolean)
      : splitLines(String(coverageText).replace(/,/g, "\n"));
    return createHostObject({
      title: String((item && item.title) || "Manual candidate").trim(),
      url,
      source_provider: "manual",
      source_layer: "manual",
      role: String((item && item.role) || "primary").trim() || "primary",
      reason: String((item && item.reason) || "").trim(),
      coverage_tags: createHostArray(coverageTags),
    });
  }

  function buildReviewPayload(input) {
    const candidates = input && Array.isArray(input.candidates) ? input.candidates : [];
    const addedCandidates = (input && input.addedCandidates ? input.addedCandidates : [])
      .filter((item) => String((item && item.url) || "").trim())
      .map(normalizeManualCandidate);
    const approvedUrls = candidates
      .filter((candidate) => candidate && candidate.approved && !candidate.rejected && isHttpUrl(candidate.url))
      .map((candidate) => String(candidate.url).trim());
    const rejectedUrls = candidates
      .filter((candidate) => candidate && candidate.rejected && candidate.url)
      .map((candidate) =>
        createHostObject({
          url: String(candidate.url).trim(),
          reason: String(candidate.rejectReason || "Rejected by reviewer.").trim(),
        })
      );
    const orderedUrls = approvedUrls
      .concat(addedCandidates.map((candidate) => candidate.url))
      .filter((url, index, arr) => url && arr.indexOf(url) === index);

    return createHostObject({
      review_decision: String((input && input.decision) || "continue_with_approved"),
      approved_urls: createHostArray(approvedUrls),
      rejected_urls: createHostArray(rejectedUrls),
      ordered_urls: createHostArray(orderedUrls),
      added_candidates: createHostArray(addedCandidates),
      platform_hints: normalizePlatformHints(input && input.platformHintsText),
      missing_requirements: createHostArray(splitLines(input && input.missingRequirementsText)),
      suggested_queries: createHostArray(splitLines(input && input.suggestedQueriesText)),
      reviewer_id: String((input && input.reviewerId) || ""),
      reviewed_at: String((input && input.reviewedAt) || new Date().toISOString()),
      comment: String((input && input.comment) || ""),
    });
  }

  function classifyJobState(job) {
    const status = String((job && job.status) || "");
    if (status === "searching" || status === "judging_bundle" || status === "planning_resources" || status === "downloading") {
      return "running";
    }
    if (status === "awaiting_review") return "review";
    if (status === "needs_confirmation") return "confirmation";
    if (status === "completed") return "completed";
    if (status === "manual_required") return "manual_required";
    if (status === "insufficient") return "insufficient";
    if (status === "failed") return "failed";
    return "draft";
  }

  function resourcePlanViewModel(job) {
    const plans = Array.isArray(job && job.resource_plans) ? job.resource_plans : [];
    const files = Array.isArray(job && job.downloaded_files) ? job.downloaded_files : [];
    const fileByResourceId = new Map();
    files.forEach((file) => {
      const resourceId = String(file && file.resource_id || "").trim();
      if (resourceId && !fileByResourceId.has(resourceId)) {
        fileByResourceId.set(resourceId, file);
      }
    });
    const roleOrder = [
      "primary_data",
      "required_metadata",
      "required_supporting",
      "optional_supporting",
      "documentation",
      "index",
      "sample",
      "reject",
    ];
    const normalizedPlans = plans.map((plan) => {
      const groups = {};
      roleOrder.forEach((role) => {
        groups[role] = [];
      });
      const resources = Array.isArray(plan && plan.resources) ? plan.resources : [];
      resources.forEach((resource) => {
        const role = roleOrder.includes(String(resource && resource.role || ""))
          ? String(resource.role)
          : "documentation";
        const resourceId = String(resource && resource.resource_id || "").trim();
        const file = resourceId ? fileByResourceId.get(resourceId) : null;
        groups[role].push(createHostObject({
          resource_id: resourceId,
          title: String(resource && resource.title || ""),
          url: String(resource && resource.url || ""),
          role,
          required: !!(resource && resource.required),
          reason: String(resource && resource.reason || ""),
          expected_format: String(resource && resource.expected_format || ""),
          platform: String(resource && resource.platform || ""),
          resource_type: String(resource && resource.resource_type || ""),
          download_strategy: String(resource && resource.download_strategy || ""),
          resolver_evidence: formatResolverEvidence(resource && resource.resolver_evidence),
          download_status: file ? String(file.status || "unknown") : "not_downloaded",
          file_name: file ? String(file.file_name || "") : "",
        }));
      });
      return createHostObject({
        plan_id: String(plan && plan.plan_id || ""),
        status: String(plan && plan.status || ""),
        summary: String(plan && plan.summary || ""),
        missing: createHostArray(Array.isArray(plan && plan.missing) ? plan.missing : []),
        roleOrder: createHostArray(roleOrder),
        groups: createHostObject(groups),
      });
    });
    return createHostObject({
      plans: createHostArray(normalizedPlans),
    });
  }

  function formatResolverEvidence(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "";
    }
    return Object.keys(value)
      .sort((a, b) => {
        if (a === "resolver") return -1;
        if (b === "resolver") return 1;
        return a.localeCompare(b);
      })
      .map((key) => `${key}=${String(value[key] == null ? "" : value[key])}`)
      .join("; ");
  }

  function buildResourcePlanUpdatePayload(plans) {
    const normalizedPlans = (Array.isArray(plans) ? plans : []).map((plan) => {
      const resources = (Array.isArray(plan && plan.resources) ? plan.resources : []).map((resource) =>
        createHostObject({
          resource_id: String(resource && resource.resource_id || ""),
          title: String(resource && resource.title || ""),
          url: String(resource && resource.url || ""),
          role: String(resource && resource.role || "documentation"),
          required: !!(resource && resource.required),
          reason: String(resource && resource.reason || ""),
          expected_format: String(resource && resource.expected_format || ""),
          expected_content_type: String(resource && resource.expected_content_type || ""),
          expected_fields: createHostArray(Array.isArray(resource && resource.expected_fields) ? resource.expected_fields : []),
          expected_time_coverage: String(resource && resource.expected_time_coverage || ""),
          expected_geo_coverage: String(resource && resource.expected_geo_coverage || ""),
          source_page_url: String(resource && resource.source_page_url || ""),
          confidence: String(resource && resource.confidence || ""),
        })
      );
      return createHostObject({
        plan_id: String(plan && plan.plan_id || ""),
        requirement_id: String(plan && plan.requirement_id || ""),
        bundle_id: String(plan && plan.bundle_id || ""),
        status: String(plan && plan.status || "planned"),
        summary: String(plan && plan.summary || ""),
        missing: createHostArray(Array.isArray(plan && plan.missing) ? plan.missing : []),
        created_by: String(plan && plan.created_by || ""),
        resources: createHostArray(resources),
      });
    });
    return createHostObject({
      resource_plans: createHostArray(normalizedPlans),
    });
  }

  function candidateReviewHint(candidates, status) {
    const count = Array.isArray(candidates) ? candidates.length : 0;
    if (String(status || "") !== "awaiting_review") {
      return "";
    }
    if (count === 0) {
      return "No candidates were found. Add a manual URL, choose Search more, or stop the job as insufficient.";
    }
    if (count === 1) {
      return "1 candidate is ready for review.";
    }
    return `${count} candidates are ready for review.`;
  }

  function failureDetailsForJob(job) {
    const failed = Array.isArray(job && job.requirements)
      ? job.requirements.find((item) => item && item.status === "llm_failed")
      : null;
    if (!failed) {
      const stage = String((job && job.failure_stage) || "").trim();
      if (stage) {
        const attempts = String((job && job.attempt_count) || 0).trim();
        const errorType = String((job && job.error_type) || "unknown error").trim();
        return `Job failed at ${stage} after ${attempts} attempts: ${errorType}.`;
      }
      return "The job failed. Retry the failed step.";
    }
    const title = String(failed.title || failed.requirement_id || "Requirement").trim();
    const stage = String(failed.failure_stage || "unknown stage").trim();
    const attempts = String(failed.attempt_count || 0).trim();
    const errorType = String(failed.error_type || "unknown error").trim();
    return `${title} failed at ${stage} after ${attempts} attempts: ${errorType}.`;
  }

  function normalizeCandidateDisplayLimit(value, maxCount) {
    const max = Math.max(1, Number(maxCount || 1));
    const parsed = Number.parseInt(String(value || ""), 10);
    if (!Number.isFinite(parsed)) {
      return max;
    }
    return Math.min(max, Math.max(1, parsed));
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  const api = {
    buildCreateJobPayload,
    buildReviewPayload,
    splitRoundCandidates,
    buildRequirementQuerySourceModel,
    candidateReviewHint,
    classifyJobState,
    formatBytes,
    resourcePlanViewModel,
    buildResourcePlanUpdatePayload,
    failureDetailsForJob,
    isHttpUrl,
    normalizePlatformHints,
    normalizeCandidateDisplayLimit,
    splitLines,
  };

  root.DatasetJobPageCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
