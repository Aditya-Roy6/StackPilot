// ============================================================
// PreviewEnvironments.cpp
// ============================================================

#include "PreviewEnvironments.h"

#include "ComposeKubernetesPlanner.h"
#include "../utils/StringUtils.h"

#include <algorithm>

namespace stackpilot {
namespace {

using strings::toLower;
using strings::trim;

std::string jsonText(const Json::Value& parent, const std::string& key) {
    if (!parent.isObject() || !parent.isMember(key) || !parent[key].isString()) {
        return "";
    }
    return trim(parent[key].asString());
}

}  // namespace

PreviewRequest PreviewEnvironments::parseWebhook(const Json::Value& payload) {
    PreviewRequest request;
    if (!payload.isObject() || !payload.isMember("pull_request")) {
        return request;
    }

    const Json::Value& pr = payload["pull_request"];
    if (!pr.isObject()) {
        return request;
    }

    request.action = toLower(jsonText(payload, "action"));
    request.prNumber = pr.isMember("number") && pr["number"].isIntegral() ? pr["number"].asInt() : 0;
    request.title = jsonText(pr, "title");

    if (pr.isMember("head") && pr["head"].isObject()) {
        request.branch = jsonText(pr["head"], "ref");
        request.commitSha = jsonText(pr["head"], "sha");
    }
    if (pr.isMember("user") && pr["user"].isObject()) {
        request.author = jsonText(pr["user"], "login");
    }

    // A merged PR arrives as action "closed" with merged=true. Both mean the
    // preview should go away, so they are not distinguished here.
    return request;
}

PreviewDecision PreviewEnvironments::decide(const PreviewRequest& request, bool previewsEnabled) {
    if (request.prNumber <= 0) {
        return {"ignore", "Not a pull request event"};
    }
    if (!previewsEnabled) {
        return {"ignore", "Preview environments are not enabled for this project"};
    }

    const std::string action = toLower(trim(request.action));

    if (action == "closed") {
        return {"teardown", "Pull request closed"};
    }
    if (action == "opened" || action == "reopened" || action == "synchronize") {
        if (request.commitSha.empty()) {
            return {"ignore", "Pull request event carried no head commit"};
        }
        return {"deploy", "Pull request " + action};
    }

    // labeled, assigned, edited, review_requested, and whatever GitHub adds
    // next. Redeploying on these would rebuild on every label change.
    return {"ignore", "Pull request action '" + action + "' does not affect the preview"};
}

std::string PreviewEnvironments::namespaceFor(const std::string& projectName, int prNumber) {
    const std::string safeProject = ComposeKubernetesPlanner::sanitizeDnsLabel(projectName, 40);
    const std::string suffix = "-pr-" + std::to_string(std::max(0, prNumber));
    // Sanitize the whole thing again: the PR suffix is safe by construction,
    // but re-running the check keeps the guarantee in one place rather than
    // relying on the concatenation staying valid.
    return ComposeKubernetesPlanner::sanitizeDnsLabel(safeProject + suffix, 63);
}

std::string PreviewEnvironments::versionFor(int prNumber) {
    return "pr-" + std::to_string(std::max(0, prNumber));
}

int PreviewEnvironments::clampTtlHours(int configured) {
    // One hour minimum so a preview is never dead on arrival; 30 days maximum
    // so "never expires" is not reachable through configuration.
    return std::clamp(configured, 1, 24 * 30);
}

}  // namespace stackpilot
