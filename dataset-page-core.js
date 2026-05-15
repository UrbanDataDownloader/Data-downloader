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
    const cleanTitle = String(title || "").trim();
    const cleanAbstract = String(abstract || "").trim();
    if (!cleanTitle) {
      throw new Error("title is required");
    }
    if (!cleanAbstract) {
      throw new Error("abstract is required");
    }
    return createHostObject({
      title: cleanTitle,
      abstract: cleanAbstract,
      platform_hints: normalizePlatformHints(platformHintsText),
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
    if (status === "searching" || status === "judging_bundle" || status === "downloading") {
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
    candidateReviewHint,
    classifyJobState,
    formatBytes,
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
