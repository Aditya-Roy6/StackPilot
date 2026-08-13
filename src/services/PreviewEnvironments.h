// ============================================================
// PreviewEnvironments.h — short-lived deployments for pull requests
// ============================================================
// A preview is a normal deployment with three extra properties: it is tied to
// a PR, it replaces its predecessor instead of stacking, and it expires.
//
// The naming and expiry rules live here as pure functions because they are the
// part that goes wrong quietly. A namespace that collides puts two PRs in the
// same cluster objects; a TTL that never fires turns previews into a permanent
// bill. Neither surfaces as an error — you find out weeks later.

#pragma once

#include <json/json.h>
#include <string>

namespace stackpilot {

struct PreviewRequest {
    std::string projectId;
    std::string projectName;
    int prNumber = 0;
    std::string branch;
    std::string commitSha;
    std::string title;
    std::string author;
    // open | reopened | synchronize | closed
    std::string action;
};

struct PreviewDecision {
    // deploy | teardown | ignore
    std::string action;
    std::string reason;

    bool shouldDeploy() const { return action == "deploy"; }
    bool shouldTeardown() const { return action == "teardown"; }
};

class PreviewEnvironments {
public:
    /// Parses the parts of a GitHub `pull_request` webhook this needs.
    /// Returns prNumber == 0 when the payload is not a usable PR event.
    static PreviewRequest parseWebhook(const Json::Value& payload);

    /// What to do about a PR event, given whether the project opted in.
    /// Unknown actions are ignored rather than treated as opens — GitHub adds
    /// new `pull_request` actions regularly (labeled, assigned, edited...) and
    /// redeploying on every one of them would be a rebuild storm.
    static PreviewDecision decide(const PreviewRequest& request, bool previewsEnabled);

    /// DNS-safe namespace for a PR's runtime, stable across pushes to the same
    /// PR so redeploys replace rather than accumulate.
    static std::string namespaceFor(const std::string& projectName, int prNumber);

    /// Deployment version label, e.g. "pr-42".
    static std::string versionFor(int prNumber);

    /// Clamps a project's configured TTL into something sane. Zero or negative
    /// would mean "expires immediately"; unbounded would defeat the purpose.
    static int clampTtlHours(int configured);
};

}  // namespace stackpilot
