// ============================================================
// DriftDetector.h — desired state vs what the cluster actually has
// ============================================================
// A deployment record says what we asked for. The cluster says what happened.
// They diverge constantly and quietly: someone runs `kubectl scale`, an
// OOMKill drops replicas, a node drains, an image tag gets repointed. None of
// that updates our row, so the dashboard keeps reporting the intent while the
// reality has moved.
//
// compare() is deliberately pure — two JSON objects in, findings out. Drift
// detection that can only be tested against a live cluster is drift detection
// nobody tests, and a detector that silently returns "no drift" is
// indistinguishable from a healthy system right up until it isn't.

#pragma once

#include <json/json.h>
#include <string>

namespace stackpilot {

namespace drift {
// A finding that changes what the platform would do next.
inline constexpr const char* kSeverityHigh = "high";
// Real divergence, safe to leave until someone looks.
inline constexpr const char* kSeverityWarning = "warning";
// Divergence we expect and can explain (a rollout in progress).
inline constexpr const char* kSeverityInfo = "info";
}  // namespace drift

struct DriftReport {
    // ok | drifted | unreachable
    std::string status;
    Json::Value findings;  // array of {field, desired, actual, severity, detail}
    std::string summary;

    bool drifted() const { return status == "drifted"; }
};

class DriftDetector {
public:
    /**
     * Compares a desired-state object against an observed-state object.
     *
     * `desired` keys: replicas, image, namespace, deployment_name,
     * service_name, exposure, runtime_url.
     * `observed` uses the same keys; a missing key means "not observed" and is
     * skipped rather than reported as drift to empty — the difference between
     * "the cluster says zero" and "we could not see the cluster" matters.
     *
     * Pass observed as null to record an unreachable check.
     */
    static DriftReport compare(const Json::Value& desired, const Json::Value& observed);

    /// Human-readable one-liner for the findings array.
    static std::string summarize(const Json::Value& findings);
};

}  // namespace stackpilot
