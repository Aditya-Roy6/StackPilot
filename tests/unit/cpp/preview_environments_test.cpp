// Unit tests for src/services/PreviewEnvironments.cpp.
//
// Two failure modes drive these tests. A namespace that collides puts two pull
// requests into the same cluster objects, so one PR's deploy silently destroys
// another's. A decision table that treats unknown GitHub actions as "deploy"
// rebuilds on every label change — a rebuild storm that looks like the
// platform being busy rather than the platform being wrong.

#include "testing.h"

#include "../../../src/services/PreviewEnvironments.h"

using namespace stackpilot;

namespace {

Json::Value prPayload(const std::string& action, int number, const std::string& sha = "abc123") {
    Json::Value head(Json::objectValue);
    head["ref"] = "feature/login";
    head["sha"] = sha;

    Json::Value user(Json::objectValue);
    user["login"] = "octocat";

    Json::Value pr(Json::objectValue);
    pr["number"] = number;
    pr["title"] = "Add login";
    pr["head"] = head;
    pr["user"] = user;

    Json::Value payload(Json::objectValue);
    payload["action"] = action;
    payload["pull_request"] = pr;
    return payload;
}

bool isValidDnsLabel(const std::string& label) {
    if (label.empty() || label.size() > 63) return false;
    const auto alnum = [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); };
    if (!alnum(label.front()) || !alnum(label.back())) return false;
    for (const char c : label) {
        if (!alnum(c) && c != '-') return false;
    }
    return true;
}

}  // namespace

// ─── webhook parsing ────────────────────────────────────────────

TEST(PreviewParse, ExtractsTheFieldsADeployNeeds) {
    const PreviewRequest request = PreviewEnvironments::parseWebhook(prPayload("opened", 42));
    EXPECT_EQ(request.prNumber, 42);
    EXPECT_EQ(request.action, "opened");
    EXPECT_EQ(request.branch, "feature/login");
    EXPECT_EQ(request.commitSha, "abc123");
    EXPECT_EQ(request.author, "octocat");
    EXPECT_EQ(request.title, "Add login");
}

TEST(PreviewParse, NonPullRequestPayloadsYieldNoPrNumber) {
    EXPECT_EQ(PreviewEnvironments::parseWebhook(Json::Value()).prNumber, 0);
    EXPECT_EQ(PreviewEnvironments::parseWebhook(Json::Value(Json::objectValue)).prNumber, 0);

    Json::Value push(Json::objectValue);
    push["ref"] = "refs/heads/main";
    EXPECT_EQ(PreviewEnvironments::parseWebhook(push).prNumber, 0);
}

TEST(PreviewParse, SurvivesAPayloadMissingOptionalObjects) {
    // GitHub omits fields on some event variants; a missing user must not
    // crash the webhook handler for every project.
    Json::Value pr(Json::objectValue);
    pr["number"] = 7;
    Json::Value payload(Json::objectValue);
    payload["action"] = "opened";
    payload["pull_request"] = pr;

    const PreviewRequest request = PreviewEnvironments::parseWebhook(payload);
    EXPECT_EQ(request.prNumber, 7);
    EXPECT_EQ(request.author, "");
    EXPECT_EQ(request.commitSha, "");
}

TEST(PreviewParse, LowercasesTheAction) {
    EXPECT_EQ(PreviewEnvironments::parseWebhook(prPayload("OPENED", 1)).action, "opened");
}

// ─── decision table ─────────────────────────────────────────────

TEST(PreviewDecide, DeploysOnOpenReopenAndPush) {
    for (const char* action : {"opened", "reopened", "synchronize"}) {
        const auto request = PreviewEnvironments::parseWebhook(prPayload(action, 42));
        EXPECT_TRUE(PreviewEnvironments::decide(request, true).shouldDeploy());
    }
}

TEST(PreviewDecide, TearsDownOnClose) {
    const auto request = PreviewEnvironments::parseWebhook(prPayload("closed", 42));
    EXPECT_TRUE(PreviewEnvironments::decide(request, true).shouldTeardown());
}

TEST(PreviewDecide, IgnoresActionsThatDoNotChangeTheCode) {
    // The rebuild-storm guard. GitHub keeps adding pull_request actions, and
    // anything not explicitly handled must be inert.
    for (const char* action : {"labeled", "unlabeled", "assigned", "edited",
                               "review_requested", "auto_merge_enabled", "converted_to_draft"}) {
        const auto request = PreviewEnvironments::parseWebhook(prPayload(action, 42));
        const auto decision = PreviewEnvironments::decide(request, true);
        if (decision.shouldDeploy() || decision.shouldTeardown()) {
            STACKPILOT_FAIL(std::string("action '") + action + "' should be inert but was '" +
                            decision.action + "'");
        }
    }
}

TEST(PreviewDecide, DoesNothingWhenTheProjectHasNotOptedIn) {
    const auto request = PreviewEnvironments::parseWebhook(prPayload("opened", 42));
    EXPECT_FALSE(PreviewEnvironments::decide(request, false).shouldDeploy());
    // Teardown is also suppressed: with previews off there is nothing to tear
    // down, and acting on the event could destroy an unrelated deployment.
    const auto closed = PreviewEnvironments::parseWebhook(prPayload("closed", 42));
    EXPECT_FALSE(PreviewEnvironments::decide(closed, false).shouldTeardown());
}

TEST(PreviewDecide, RefusesToDeployWithoutAHeadCommit) {
    const auto request = PreviewEnvironments::parseWebhook(prPayload("opened", 42, ""));
    EXPECT_FALSE(PreviewEnvironments::decide(request, true).shouldDeploy());
}

TEST(PreviewDecide, AlwaysExplainsItself) {
    const auto request = PreviewEnvironments::parseWebhook(prPayload("labeled", 42));
    EXPECT_FALSE(PreviewEnvironments::decide(request, true).reason.empty());
}

// ─── naming ─────────────────────────────────────────────────────

TEST(PreviewNaming, ProducesAValidDnsLabel) {
    EXPECT_TRUE(isValidDnsLabel(PreviewEnvironments::namespaceFor("My Project", 42)));
    EXPECT_TRUE(isValidDnsLabel(PreviewEnvironments::namespaceFor("!!!", 1)));
    EXPECT_TRUE(isValidDnsLabel(PreviewEnvironments::namespaceFor("日本語", 9)));
    EXPECT_TRUE(isValidDnsLabel(PreviewEnvironments::namespaceFor(std::string(200, 'a'), 12345)));
}

TEST(PreviewNaming, IsStableAcrossPushesToTheSamePr) {
    // Redeploys must reuse the namespace, otherwise every push leaks a whole
    // set of cluster objects.
    EXPECT_EQ(PreviewEnvironments::namespaceFor("shop", 42),
              PreviewEnvironments::namespaceFor("shop", 42));
}

TEST(PreviewNaming, DiffersBetweenPullRequests) {
    EXPECT_FALSE(PreviewEnvironments::namespaceFor("shop", 42) ==
                 PreviewEnvironments::namespaceFor("shop", 43));
}

TEST(PreviewNaming, DiffersBetweenProjectsWithTheSamePrNumber) {
    EXPECT_FALSE(PreviewEnvironments::namespaceFor("shop", 42) ==
                 PreviewEnvironments::namespaceFor("blog", 42));
}

TEST(PreviewNaming, LongProjectNamesDoNotCollapseIntoOneNamespace) {
    // Truncating the project name before appending the PR suffix would make
    // every long-named project share a namespace per PR number.
    const std::string a(60, 'a');
    const std::string b = std::string(59, 'a') + "b";
    EXPECT_FALSE(PreviewEnvironments::namespaceFor(a, 1) == PreviewEnvironments::namespaceFor(b, 2));
}

TEST(PreviewNaming, VersionLabel) {
    EXPECT_EQ(PreviewEnvironments::versionFor(42), "pr-42");
    EXPECT_EQ(PreviewEnvironments::versionFor(-1), "pr-0");
}

// ─── expiry ─────────────────────────────────────────────────────

TEST(PreviewTtl, KeepsAReasonableValue) {
    EXPECT_EQ(PreviewEnvironments::clampTtlHours(72), 72);
    EXPECT_EQ(PreviewEnvironments::clampTtlHours(1), 1);
}

TEST(PreviewTtl, NeverExpiresImmediately) {
    // A zero or negative TTL would tear a preview down the moment it was
    // created, which reads as "deploys are broken" rather than "TTL is wrong".
    EXPECT_TRUE(PreviewEnvironments::clampTtlHours(0) >= 1);
    EXPECT_TRUE(PreviewEnvironments::clampTtlHours(-5) >= 1);
}

TEST(PreviewTtl, NeverBecomesEffectivelyInfinite) {
    // "Never expires" must not be reachable through configuration; that is how
    // preview environments turn into a permanent bill.
    EXPECT_TRUE(PreviewEnvironments::clampTtlHours(1000000) <= 24 * 30);
}
