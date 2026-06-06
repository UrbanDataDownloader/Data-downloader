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

  function mergeManualUrlSuggestions(existingCandidates, suggestions) {
    const merged = Array.isArray(existingCandidates)
      ? existingCandidates.map((item) => ({ ...(item || {}) }))
      : [];
    const seen = new Set(
      merged
        .map((item) => String((item && item.url) || "").trim().toLowerCase())
        .filter(Boolean)
    );
    (Array.isArray(suggestions) ? suggestions : []).forEach((suggestion) => {
      const url = String((suggestion && suggestion.url) || "").trim();
      const key = url.toLowerCase();
      if (!isHttpUrl(url) || seen.has(key)) return;
      seen.add(key);
      const rawRole = String((suggestion && suggestion.role) || "primary").trim();
      merged.push({
        title: String((suggestion && suggestion.title) || "Manual download review").trim(),
        url,
        role: rawRole === "primary_data" ? "primary" : rawRole || "primary",
        reason: String(
          (suggestion && suggestion.reason) || "Suggested from download diagnostics"
        ).trim(),
        coverageTagsText: String((suggestion && suggestion.coverageTagsText) || "").trim(),
      });
    });
    return createHostArray(merged);
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
      search_more_source: String((input && input.searchMoreSource) || (input && input.search_more_source) || "").trim(),
      search_more_source_details: createHostArray(uniqueStrings(
        (input && (input.searchMoreSourceDetails || input.search_more_source_details)) || []
      )),
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
    const diagnostics = job && job.review_diagnostics && typeof job.review_diagnostics === "object"
      ? job.review_diagnostics
      : {};
    const validations = Array.isArray(diagnostics.resource_plan_validations)
      ? diagnostics.resource_plan_validations
      : [];
    const validationByPlanId = new Map();
    validations.forEach((validation) => {
      const planId = String(validation && validation.plan_id || "").trim();
      if (planId && !validationByPlanId.has(planId)) {
        validationByPlanId.set(planId, validation);
      }
    });
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
    const normalizedPlans = plans.map((plan, planIndex) => {
      const planId = String(plan && plan.plan_id || "").trim();
      const matchedValidation = planId ? validationByPlanId.get(planId) : null;
      const validation = matchedValidation && typeof matchedValidation === "object"
        ? matchedValidation
        : validations[planIndex] && typeof validations[planIndex] === "object"
          ? validations[planIndex]
          : {};
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
          selected_for_download: resource && resource.selected_for_download !== false,
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
      const missing = Array.isArray(plan && plan.missing) ? plan.missing : [];
      const validationMissing = Array.isArray(validation.missing_required_resources)
        ? validation.missing_required_resources
        : [];
      const allMissing = uniqueStrings(missing.concat(validationMissing));
      const manualActions = [];
      allMissing.forEach((item) => {
        const text = String(item || "").trim();
        if (!text) return;
        manualActions.push(createHostObject({
          type: "missing",
          label: `Missing: ${text}`,
          next_step: "Add or reclassify a resource that satisfies this missing item",
          resource_id: "",
          role: "",
          url: "",
        }));
      });
      if (!groups.primary_data.length) {
        manualActions.push(createHostObject({
          type: "missing_primary_data",
          label: "No primary data resource selected",
          next_step: "Change the best data file/export resource role to Primary data or add a manual URL",
          resource_id: "",
          role: "primary_data",
          url: "",
        }));
      }
      roleOrder.forEach((role) => {
        groups[role].forEach((resource) => {
          const status = String(resource && resource.download_status || "").trim();
          if (!resource.required || ["downloaded", "ok", "success"].includes(status)) return;
          manualActions.push(createHostObject({
            type: "required_download_not_ready",
            label: `${resource.title || resource.resource_id || "Required resource"} is ${status || "not downloaded"}`,
            next_step: "Replace with a working direct URL or uncheck required if it is only supporting evidence",
            resource_id: resource.resource_id,
            role: resource.role,
            url: resource.url,
          }));
        });
      });
      const flatResources = [];
      roleOrder.forEach((role) => {
        groups[role].forEach((resource) => {
          flatResources.push(resource);
        });
      });
      return createHostObject({
        plan_id: planId,
        title: String(plan && plan.title || ""),
        status: String(plan && plan.status || ""),
        summary: String(plan && plan.summary || ""),
        missing: createHostArray(allMissing),
        validation: createHostObject({
          primary_target_downloaded: !!validation.primary_target_downloaded,
          required_resource_set_downloaded: !!validation.required_resource_set_downloaded,
          requirement_satisfied_after_download: !!validation.requirement_satisfied_after_download,
          downloaded_resource_ids: createHostArray(uniqueStrings(validation.downloaded_resource_ids)),
          missing_required_resources: createHostArray(uniqueStrings(validationMissing)),
        }),
        manual_actions: createHostArray(manualActions),
        resources: createHostArray(flatResources),
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
          selected_for_download: resource && resource.selected_for_download !== false,
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

  function uniqueStrings(values) {
    const output = [];
    const seen = new Set();
    (Array.isArray(values) ? values : []).forEach((value) => {
      const text = String(value || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      output.push(text);
    });
    return output;
  }

  function platformDiagnosticNoteLabel(value) {
    const text = String(value || "").trim();
    if (text === "recommended_platforms_returned_no_candidates") {
      return "Recommended platforms returned no candidates; fallback searched this platform";
    }
    if (text === "no_recommended_platforms") {
      return "No recommended platforms were available; default platform search was used";
    }
    return text;
  }

  function noDataDiagnosticsViewModel(job) {
    const diagnostics = job && job.review_diagnostics && typeof job.review_diagnostics === "object"
      ? job.review_diagnostics
      : {};
    const summaries = Array.isArray(diagnostics.no_data_summary)
      ? diagnostics.no_data_summary
      : [];
    return createHostArray(
      summaries
        .filter((item) => item && typeof item === "object")
        .map((item) => {
          const status = String(item.status || "").trim();
          const title = String(item.title || item.requirement_id || "Requirement").trim();
          const candidateCount = Number(item.candidate_count || 0);
          const exhausted = !!item.exhausted_rounds;
          const label = status === "recovered_after_no_data"
            ? "Recovered after empty search"
            : status === "platform_failures_without_candidates"
              ? "Platform failures without candidates"
              : "No candidates after search";
          return createHostObject({
            requirement_id: String(item.requirement_id || "").trim(),
            title,
            status,
            label,
            exhausted_rounds: exhausted,
            candidate_count: Number.isFinite(candidateCount) ? candidateCount : 0,
            round_count: Number(item.round_count || 0) || 0,
            attempted_queries: createHostArray(uniqueStrings(item.attempted_queries)),
            searched_platforms: createHostArray(uniqueStrings(item.searched_platforms)),
            platform_rows: createHostArray(platformRowsForNoDataSummary(diagnostics, item)),
            suggested_queries: createHostArray(uniqueStrings(item.suggested_queries)),
            reasons: createHostArray(uniqueStrings(item.reasons)),
            platform_search_statuses: createHostArray(uniqueStrings(item.platform_search_statuses)),
            platform_search_status_messages: createHostArray(uniqueStrings(item.platform_search_status_messages)),
          });
        })
    );
  }

  function platformRowsForNoDataSummary(diagnostics, summary) {
    const requirementRounds = Array.isArray(diagnostics && diagnostics.requirement_rounds)
      ? diagnostics.requirement_rounds
      : [];
    const requirementId = String(summary && summary.requirement_id || "").trim();
    const title = String(summary && summary.title || "").trim();
    const matchingRequirement = requirementRounds.find((requirement) => {
      if (!requirement || typeof requirement !== "object") return false;
      const currentId = String(requirement.requirement_id || "").trim();
      const currentTitle = String(requirement.title || "").trim();
      return (requirementId && currentId === requirementId) || (!requirementId && title && currentTitle === title);
    });
    if (!matchingRequirement) {
      return uniqueStrings(summary && summary.searched_platforms).map((platformId) =>
        createHostObject({
          platform_id: platformId,
          status: "searched",
          label: "Searched",
          result_count: 0,
          failure_count: 0,
          rounds: createHostArray([]),
          notes: createHostArray([]),
        })
      );
    }

    const byPlatform = new Map();
    function rowFor(platformId) {
      const cleanPlatform = String(platformId || "").trim();
      if (!cleanPlatform) return null;
      if (!byPlatform.has(cleanPlatform)) {
        byPlatform.set(cleanPlatform, {
          platform_id: cleanPlatform,
          result_count: 0,
          failure_count: 0,
          rounds: [],
          notes: [],
        });
      }
      return byPlatform.get(cleanPlatform);
    }

    (Array.isArray(matchingRequirement.rounds) ? matchingRequirement.rounds : []).forEach((round) => {
      if (!round || typeof round !== "object") return;
      const roundIndex = Number(round.round_index || 0) || 0;
      (Array.isArray(round.platform_summaries) ? round.platform_summaries : []).forEach((platformSummary) => {
        if (!platformSummary || typeof platformSummary !== "object") return;
        const selectedPlatforms = uniqueStrings(platformSummary.selected_platforms);
        const resultCounts = platformSummary.result_counts_by_platform && typeof platformSummary.result_counts_by_platform === "object"
          ? platformSummary.result_counts_by_platform
          : {};
        const fallbackReason = String(platformSummary.fallback_reason || "").trim();
        selectedPlatforms.forEach((platformId) => {
          const row = rowFor(platformId);
          if (!row) return;
          if (roundIndex && row.rounds.indexOf(roundIndex) === -1) {
            row.rounds.push(roundIndex);
          }
          const count = Number(resultCounts[platformId] || 0) || 0;
          row.result_count += count;
          const fallbackNote = platformDiagnosticNoteLabel(fallbackReason);
          if (fallbackNote && row.notes.indexOf(fallbackNote) === -1) {
            row.notes.push(fallbackNote);
          }
        });
        (Array.isArray(platformSummary.failures) ? platformSummary.failures : []).forEach((failure) => {
          if (!failure || typeof failure !== "object") return;
          const platformId = String(failure.adapter_id || failure.platform_id || "").trim();
          const row = rowFor(platformId);
          if (!row) return;
          row.failure_count += 1;
          const error = String(failure.error || "").trim();
          if (error && row.notes.indexOf(error) === -1) {
            row.notes.push(error);
          }
        });
      });
    });

    return Array.from(byPlatform.values()).map((row) => {
      const status = row.result_count > 0
        ? "found_results"
        : row.failure_count > 0
          ? "failed"
          : "no_results";
      const label = status === "found_results"
        ? "Found results"
        : status === "failed"
          ? "Failed"
          : "No results";
      return createHostObject({
        platform_id: row.platform_id,
        status,
        label,
        result_count: row.result_count,
        failure_count: row.failure_count,
        rounds: createHostArray(row.rounds.sort((a, b) => a - b)),
        notes: createHostArray(uniqueStrings(row.notes)),
      });
    });
  }

  function downloadDiagnosticsViewModel(job) {
    const diagnostics = job && job.review_diagnostics && typeof job.review_diagnostics === "object"
      ? job.review_diagnostics
      : {};
    const bundleSummaries = Array.isArray(diagnostics.bundle_summaries)
      ? diagnostics.bundle_summaries
      : [];
    const riskyResources = Array.isArray(diagnostics.risky_resources)
      ? diagnostics.risky_resources
      : [];
    const failedDownloadResources = Array.isArray(diagnostics.failed_download_resources)
      ? diagnostics.failed_download_resources
      : [];
    const defaultDownloadCount = Number(diagnostics.default_download_count || 0) || 0;
    const landingDefaultCount = Number(diagnostics.landing_default_count || 0) || 0;
    const bundleCount = Number(diagnostics.bundle_count || 0) || bundleSummaries.length;
    const problemBundles = bundleSummaries
      .filter((bundle) => {
        const resourceCount = Number(bundle && bundle.resource_count || 0) || 0;
        const defaultCount = Number(bundle && bundle.default_download_count || 0) || 0;
        return resourceCount > 0 && (defaultCount === 0 || !(bundle && bundle.has_non_landing_default));
      })
      .map((bundle) =>
        createHostObject({
          bundle_id: String(bundle && bundle.bundle_id || ""),
          title: String(bundle && bundle.title || ""),
          source_layer: String(bundle && bundle.source_layer || ""),
          default_download_count: Number(bundle && bundle.default_download_count || 0) || 0,
          resource_count: Number(bundle && bundle.resource_count || 0) || 0,
          has_non_landing_default: !!(bundle && bundle.has_non_landing_default),
          default_download_urls: createHostArray(uniqueStrings(bundle && bundle.default_download_urls)),
          access_risks: createHostArray(uniqueStrings(bundle && bundle.access_risks)),
          download_strategies: createHostArray(uniqueStrings(bundle && bundle.download_strategies)),
        })
      );
    const riskRows = riskyResources.map((resource) =>
      createHostObject({
        bundle_id: String(resource && resource.bundle_id || ""),
        title: String(resource && resource.title || ""),
        url: String(resource && resource.url || ""),
        kind: String(resource && resource.kind || ""),
        access_risk: String(resource && resource.access_risk || ""),
        download_strategy: String(resource && resource.download_strategy || ""),
        preflight_reason: String(
          resource && resource.preflight && resource.preflight.reason || ""
        ),
      })
    );
    const failedDownloadRows = failedDownloadResources.map((resource) =>
      createHostObject({
        title: String(resource && resource.title || ""),
        url: String(resource && resource.url || ""),
        status: String(resource && resource.status || ""),
        reason: String(resource && resource.reason || ""),
        content_type: String(resource && resource.content_type || ""),
        format: String(resource && resource.format || ""),
        resource_id: String(resource && resource.resource_id || ""),
        resource_role: String(resource && resource.resource_role || ""),
        resource_required: !!(resource && resource.resource_required),
        platform: String(resource && resource.platform || ""),
        resource_type: String(resource && resource.resource_type || ""),
        download_strategy: String(resource && resource.download_strategy || ""),
        access_risk: String(resource && resource.access_risk || ""),
      })
    );
    function followupActionFor(resource, fallback) {
      const status = String(resource && resource.status || "").trim();
      const accessRisk = String(resource && resource.access_risk || "").trim();
      const strategy = String(resource && resource.download_strategy || "").trim();
      if (status === "credential_required" || accessRisk === "requires_signed_url") {
        return "Add credentialed or alternate direct URL";
      }
      if (status || accessRisk || strategy === "manual") {
        return "Add alternate direct file or export URL";
      }
      return fallback;
    }
    const manualFollowupItems = riskRows
      .filter((resource) => isHttpUrl(resource.url))
      .map((resource) =>
        createHostObject({
          title: resource.title || "Manual download review",
          url: resource.url,
          suggested_role: resource.kind || "primary",
          status: resource.access_risk || "access_risk",
          reason: uniqueStrings([
            resource.access_risk,
            resource.download_strategy,
            resource.preflight_reason,
          ]).join("; "),
          next_step: followupActionFor(resource, "Review access and add direct file URL"),
          platform: "",
        })
      )
      .concat(
        failedDownloadRows
          .filter((resource) => isHttpUrl(resource.url))
          .map((resource) =>
            createHostObject({
              title: resource.title || "Failed download review",
              url: resource.url,
              suggested_role: resource.resource_role || "primary",
              status: resource.status || "failed",
              reason: uniqueStrings([
                resource.reason,
                resource.download_strategy,
                resource.access_risk,
              ]).join("; "),
              next_step: followupActionFor(resource, "Add alternate direct URL"),
              platform: resource.platform || "",
            })
          )
      );
    const manualUrlSuggestions = riskRows
      .filter((resource) => isHttpUrl(resource.url))
      .map((resource) =>
        createHostObject({
          title: resource.title || "Manual download review",
          url: resource.url,
          role: resource.kind || "primary",
          reason: uniqueStrings([
            "Suggested from download diagnostics",
            resource.access_risk ? `access risk: ${resource.access_risk}` : "",
            resource.download_strategy ? `strategy: ${resource.download_strategy}` : "",
            resource.preflight_reason ? `preflight: ${resource.preflight_reason}` : "",
          ]).join("; "),
          coverageTagsText: uniqueStrings([
            resource.bundle_id,
            resource.kind,
            resource.access_risk,
            resource.download_strategy,
          ]).join(", "),
        })
      )
      .concat(
        failedDownloadRows
          .filter((resource) => isHttpUrl(resource.url))
          .map((resource) =>
            createHostObject({
              title: resource.title || "Failed download review",
              url: resource.url,
              role: resource.resource_role || "primary",
              reason: uniqueStrings([
                "Suggested from failed download diagnostics",
                resource.status ? `status: ${resource.status}` : "",
                resource.reason ? `reason: ${resource.reason}` : "",
                resource.download_strategy ? `strategy: ${resource.download_strategy}` : "",
              ]).join("; "),
              coverageTagsText: uniqueStrings([
                resource.resource_id,
                resource.resource_role,
                resource.platform,
                resource.resource_type,
                resource.access_risk,
                resource.download_strategy,
              ]).join(", "),
            })
          )
      );
    const shouldShow = (
      defaultDownloadCount === 0 ||
      landingDefaultCount > 0 ||
      problemBundles.length > 0 ||
      riskRows.length > 0 ||
      failedDownloadRows.length > 0
    ) && (bundleCount > 0 || failedDownloadRows.length > 0);
    return createHostObject({
      should_show: shouldShow,
      bundle_count: bundleCount,
      default_download_count: defaultDownloadCount,
      landing_default_count: landingDefaultCount,
      risky_resource_count: riskRows.length,
      failed_download_resource_count: failedDownloadRows.length,
      problem_bundles: createHostArray(problemBundles),
      risky_resources: createHostArray(riskRows),
      failed_download_resources: createHostArray(failedDownloadRows),
      manual_followup_items: createHostArray(manualFollowupItems),
      manual_url_suggestions: createHostArray(manualUrlSuggestions),
    });
  }

  function searchMoreTraceSummaryViewModel(job) {
    const diagnostics = job && job.review_diagnostics && typeof job.review_diagnostics === "object"
      ? job.review_diagnostics
      : {};
    const diagnosticRequirements = Array.isArray(diagnostics.requirement_rounds)
      ? diagnostics.requirement_rounds
      : [];
    const requirements = Array.isArray(job && job.requirements) && job.requirements.length
      ? job.requirements
      : diagnosticRequirements;
    let followupRoundCount = 0;
    let usefulCandidateCount = 0;
    let totalCandidateCount = 0;
    const sourceDetails = [];
    const requirementTitles = [];
    const triedPlatforms = [];

    requirements.forEach((requirement) => {
      let requirementHasTrace = false;
      (Array.isArray(requirement && requirement.rounds) ? requirement.rounds : []).forEach((round) => {
        const source = String(round && round.search_more_source || "").trim();
        if (!source) return;
        followupRoundCount += 1;
        const split = splitRoundCandidates(round);
        usefulCandidateCount += split.useful.length;
        totalCandidateCount += Array.isArray(round && round.candidates) ? round.candidates.length : 0;
        sourceDetails.push(...uniqueStrings(round && round.search_more_source_details));
        triedPlatforms.push(...uniqueStrings(round && round.platform_hints));
        (Array.isArray(round && round.platform_summaries) ? round.platform_summaries : []).forEach((summary) => {
          if (summary && typeof summary === "object") {
            triedPlatforms.push(...uniqueStrings(summary.selected_platforms));
          }
        });
        requirementHasTrace = true;
      });
      if (requirementHasTrace) {
        requirementTitles.push(String(requirement && (requirement.title || requirement.requirement_id) || "Requirement").trim());
      }
    });

    const outcomeStatus = usefulCandidateCount > 0
      ? "recovered_useful_candidates"
      : followupRoundCount > 0
        ? "no_useful_candidates_recovered"
        : "";
    const outcomeMessage = outcomeStatus === "recovered_useful_candidates"
      ? `Diagnostic follow-up recovered ${usefulCandidateCount} useful candidate${usefulCandidateCount === 1 ? "" : "s"} across ${followupRoundCount} follow-up round${followupRoundCount === 1 ? "" : "s"}.`
      : outcomeStatus === "no_useful_candidates_recovered"
        ? `Diagnostic follow-up did not recover useful candidates across ${followupRoundCount} follow-up round${followupRoundCount === 1 ? "" : "s"}.`
        : "";

    return createHostObject({
      should_show: followupRoundCount > 0,
      outcome_status: outcomeStatus,
      outcome_message: outcomeMessage,
      followup_round_count: followupRoundCount,
      useful_candidate_count: usefulCandidateCount,
      total_candidate_count: totalCandidateCount,
      source_details: createHostArray(uniqueStrings(sourceDetails)),
      requirement_titles: createHostArray(uniqueStrings(requirementTitles)),
      tried_platforms: createHostArray(uniqueStrings(triedPlatforms)),
    });
  }

  function searchMorePrefillViewModel(job) {
    const noDataItems = noDataDiagnosticsViewModel(job);
    const downloadDiagnostics = downloadDiagnosticsViewModel(job);
    const traceSummary = searchMoreTraceSummaryViewModel(job);
    const suggestedQueries = [];
    const missingRequirements = [];
    const platformHints = [];
    const sourceDetails = [];

    noDataItems.forEach((item) => {
      suggestedQueries.push(...item.suggested_queries);
      if (item.status === "no_candidates_after_search") {
        missingRequirements.push(`${item.title}: no candidates after ${item.round_count} rounds`);
      } else if (item.status === "platform_failures_without_candidates") {
        missingRequirements.push(`${item.title}: platform failures without candidates`);
      }
      platformHints.push(...item.searched_platforms);
    });
    if (noDataItems.length) {
      sourceDetails.push("no_data_diagnostics");
    }

    if (downloadDiagnostics.should_show) {
      sourceDetails.push("download_diagnostics");
      if (downloadDiagnostics.default_download_count === 0) {
        missingRequirements.push("Approved candidates do not include a default direct download resource");
      }
      if (downloadDiagnostics.landing_default_count > 0) {
        missingRequirements.push("Some default resources are landing pages rather than direct downloads");
      }
      if (downloadDiagnostics.risky_resource_count > 0) {
        missingRequirements.push("Some resources have access or preflight risks");
      }
      downloadDiagnostics.problem_bundles.forEach((bundle) => {
        platformHints.push(bundle.source_layer);
      });
    }
    if (traceSummary.outcome_status === "no_useful_candidates_recovered") {
      missingRequirements.push(
        "Previous diagnostic follow-up produced 0 useful candidates; change search terms, platforms, or use manual source review"
      );
      sourceDetails.push(...traceSummary.source_details);
    }
    const triedPlatformKeys = new Set(
      uniqueStrings(traceSummary.tried_platforms).map((platform) => platform.toLowerCase())
    );
    const uniquePlatformHints = uniqueStrings(platformHints);
    const filteredPlatformHints = traceSummary.outcome_status === "no_useful_candidates_recovered"
      ? uniquePlatformHints.filter(
          (platform) => !triedPlatformKeys.has(String(platform || "").trim().toLowerCase())
        )
      : uniquePlatformHints;
    const filteredPlatformKeys = new Set(
      filteredPlatformHints.map((platform) => String(platform || "").trim().toLowerCase())
    );
    const excludedPlatformHints = traceSummary.outcome_status === "no_useful_candidates_recovered"
      ? uniquePlatformHints.filter(
          (platform) => !filteredPlatformKeys.has(String(platform || "").trim().toLowerCase())
        )
      : [];

    const manualUrlSuggestions = downloadDiagnostics && downloadDiagnostics.manual_url_suggestions
      ? downloadDiagnostics.manual_url_suggestions
      : [];

    return createHostObject({
      should_prefill:
        suggestedQueries.length > 0 ||
        missingRequirements.length > 0 ||
        filteredPlatformHints.length > 0 ||
        manualUrlSuggestions.length > 0,
      suggested_queries: createHostArray(uniqueStrings(suggestedQueries)),
      missing_requirements: createHostArray(uniqueStrings(missingRequirements)),
      platform_hints: createHostArray(filteredPlatformHints),
      next_platform_hints: createHostArray(filteredPlatformHints),
      excluded_platform_hints: createHostArray(excludedPlatformHints),
      tried_platforms: createHostArray(uniqueStrings(traceSummary.tried_platforms)),
      manual_url_suggestions: createHostArray(manualUrlSuggestions),
      source_details: createHostArray(uniqueStrings(sourceDetails)),
      decision: suggestedQueries.length > 0 || missingRequirements.length > 0 ? "search_more" : "",
    });
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
        return `The job failed: ${friendlyFailureStage(stage)}. Tried ${attempts} times. Error: ${friendlyFailureType(errorType)}. You can retry the failed step.`;
      }
      return "The job failed. You can retry the failed step.";
    }
    const title = String(failed.title || failed.requirement_id || "Requirement").trim();
    const stage = String(failed.failure_stage || "unknown stage").trim();
    const attempts = String(failed.attempt_count || 0).trim();
    const errorType = String(failed.error_type || "unknown error").trim();
    return `${title} failed: ${friendlyFailureStage(stage)}. Tried ${attempts} times. Error: ${friendlyFailureType(errorType)}. You can retry the failed step.`;
  }

  function friendlyFailureStage(stage) {
    const value = String(stage || "").trim();
    if (value === "requirement_extraction_failed") return "the system could not parse the data request";
    if (value === "search_failed") return "an error occurred while searching data sources";
    if (value === "judge_failed") return "an error occurred while checking candidate results";
    if (value === "resource_planning_failed") return "an error occurred while preparing the download list";
    if (value === "download_failed") return "an error occurred while downloading datasets";
    return value || "unknown stage";
  }

  function friendlyFailureType(errorType) {
    const value = String(errorType || "").trim();
    if (value === "urlerror") return "an external service or URL could not be reached";
    if (value === "timeout") return "an external service timed out";
    if (value === "json_parse_error") return "the model response could not be parsed";
    return value || "unknown error";
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
    noDataDiagnosticsViewModel,
    downloadDiagnosticsViewModel,
    searchMoreTraceSummaryViewModel,
    searchMorePrefillViewModel,
    mergeManualUrlSuggestions,
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
