// ============================================================
// DriftDetector.cpp
// ============================================================

#include "DriftDetector.h"

#include "../utils/StringUtils.h"

#include <sstream>

namespace stackpilot {
namespace {

using strings::trim;

bool has(const Json::Value& obj, const std::string& key) {
    return obj.isObject() && obj.isMember(key) && !obj[key].isNull();
}

std::string asText(const Json::Value& value) {
    if (value.isString()) return value.asString();
    if (value.isIntegral()) return std::to_string(value.asInt64());
    if (value.isBool()) return value.asBool() ? "true" : "false";
    return "";
}

Json::Value finding(const std::string& field,
                    const std::string& desired,
                    const std::string& actual,
                    const std::string& severity,
                    const std::string& detail) {
    Json::Value item(Json::objectValue);
    item["field"] = field;
    item["desired"] = desired;
    item["actual"] = actual;
    item["severity"] = severity;
    item["detail"] = detail;
    return item;
}

/// Compares a string field, skipping when either side was not observed.
void compareText(const Json::Value& desired,
                 const Json::Value& observed,
                 const std::string& key,
                 const std::string& severity,
                 const std::string& detail,
                 Json::Value& findings) {
    if (!has(desired, key) || !has(observed, key)) {
        return;
    }
    const std::string want = trim(asText(desired[key]));
    const std::string got = trim(asText(observed[key]));
    // An empty desired value means we never pinned it, so anything is fine.
    if (want.empty() || want == got) {
        return;
    }
    findings.append(finding(key, want, got, severity, detail));
}

}  // namespace

DriftReport DriftDetector::compare(const Json::Value& desired, const Json::Value& observed) {
    DriftReport report;
    report.findings = Json::Value(Json::arrayValue);

    if (!observed.isObject() || observed.empty()) {
        report.status = "unreachable";
        report.summary = "Could not read live state from the runtime";
        return report;
    }

    // Replicas: the most common and most consequential drift. Fewer than asked
    // for is a capacity problem; more usually means someone scaled by hand and
    // the next deploy will silently undo it.
    if (has(desired, "replicas") && has(observed, "replicas")) {
        const int want = desired["replicas"].asInt();
        const int got = observed["replicas"].asInt();
        if (want != got) {
            const bool rollingOut = has(observed, "rolling_out") && observed["rolling_out"].asBool();
            report.findings.append(finding(
                "replicas",
                std::to_string(want),
                std::to_string(got),
                rollingOut ? drift::kSeverityInfo
                           : (got < want ? drift::kSeverityHigh : drift::kSeverityWarning),
                rollingOut
                    ? "A rollout is in progress; replica counts converge on their own."
                    : (got < want
                           ? "Fewer replicas are running than requested. Capacity is reduced."
                           : "More replicas are running than requested. A manual scale will be "
                             "reverted by the next deploy.")));
        }
    }

    // Image: the deployment is not running the code we think it is. Always
    // high — every other signal on the page becomes untrustworthy.
    compareText(desired, observed, "image", drift::kSeverityHigh,
                "The running image does not match the recorded build. "
                "Logs and diagnostics may describe different code than the dashboard.",
                report.findings);

    // Identity fields. Divergence here means the platform is managing a
    // different object than the one it is reporting on, so cleanup and scaling
    // would act on the wrong thing.
    compareText(desired, observed, "namespace", drift::kSeverityHigh,
                "The runtime is in a different namespace than recorded.", report.findings);
    compareText(desired, observed, "deployment_name", drift::kSeverityHigh,
                "The Kubernetes Deployment name does not match. Scale and teardown would "
                "target the wrong object.", report.findings);
    compareText(desired, observed, "service_name", drift::kSeverityWarning,
                "The Service name does not match the recorded value.", report.findings);

    // Routing. Wrong but reachable, so a warning rather than high.
    compareText(desired, observed, "exposure", drift::kSeverityWarning,
                "The exposure mode differs, so the runtime URL may not be reachable "
                "the way the project expects.", report.findings);
    compareText(desired, observed, "runtime_url", drift::kSeverityWarning,
                "The live runtime URL differs from the recorded one.", report.findings);

    report.status = report.findings.empty() ? "ok" : "drifted";
    report.summary = summarize(report.findings);
    return report;
}

std::string DriftDetector::summarize(const Json::Value& findings) {
    if (!findings.isArray() || findings.empty()) {
        return "No drift detected";
    }

    int high = 0;
    for (const auto& item : findings) {
        if (item.isObject() && item["severity"].asString() == drift::kSeverityHigh) {
            ++high;
        }
    }

    std::ostringstream out;
    out << findings.size() << (findings.size() == 1 ? " difference" : " differences")
        << " between desired and live state";
    if (high > 0) {
        out << " (" << high << " needing attention)";
    }
    return out.str();
}

}  // namespace stackpilot
