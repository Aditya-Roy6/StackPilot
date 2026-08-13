// Unit tests for src/services/DriftDetector.cpp.
//
// A drift detector that returns "no drift" for the wrong reason is worse than
// none: it converts an unmonitored system into one that looks monitored. Most
// of these tests exist to make sure silence means "we looked and it matched",
// not "we could not tell".

#include "testing.h"

#include "../../../src/services/DriftDetector.h"

using namespace stackpilot;

namespace {

Json::Value desiredState() {
    Json::Value state(Json::objectValue);
    state["replicas"] = 3;
    state["image"] = "registry.local/app:v7";
    state["namespace"] = "team-a-web";
    state["deployment_name"] = "web";
    state["service_name"] = "web-svc";
    state["exposure"] = "ingress";
    state["runtime_url"] = "https://app.example.com";
    return state;
}

bool hasFinding(const DriftReport& report, const std::string& field) {
    for (const auto& item : report.findings) {
        if (item["field"].asString() == field) return true;
    }
    return false;
}

std::string severityOf(const DriftReport& report, const std::string& field) {
    for (const auto& item : report.findings) {
        if (item["field"].asString() == field) return item["severity"].asString();
    }
    return "";
}

}  // namespace

TEST(Drift, IdenticalStatesReportOk) {
    const DriftReport report = DriftDetector::compare(desiredState(), desiredState());
    EXPECT_EQ(report.status, "ok");
    EXPECT_EQ(report.findings.size(), 0u);
    EXPECT_FALSE(report.drifted());
}

TEST(Drift, AnUnreadableClusterIsUnreachableNotClean) {
    // The distinction that matters most. If a failed inspect returned "ok",
    // an unreachable cluster would look identical to a healthy one.
    const DriftReport nullState = DriftDetector::compare(desiredState(), Json::Value());
    EXPECT_EQ(nullState.status, "unreachable");
    EXPECT_FALSE(nullState.drifted());

    const DriftReport emptyState = DriftDetector::compare(desiredState(), Json::Value(Json::objectValue));
    EXPECT_EQ(emptyState.status, "unreachable");
}

TEST(Drift, FewerReplicasThanRequestedIsHighSeverity) {
    Json::Value observed = desiredState();
    observed["replicas"] = 1;
    const DriftReport report = DriftDetector::compare(desiredState(), observed);
    EXPECT_TRUE(report.drifted());
    EXPECT_EQ(severityOf(report, "replicas"), drift::kSeverityHigh);
}

TEST(Drift, MoreReplicasThanRequestedIsAWarning) {
    // Someone scaled by hand. Not urgent, but the next deploy will undo it,
    // which is worth knowing before it happens rather than after.
    Json::Value observed = desiredState();
    observed["replicas"] = 8;
    EXPECT_EQ(severityOf(DriftDetector::compare(desiredState(), observed), "replicas"),
              drift::kSeverityWarning);
}

TEST(Drift, ReplicaMismatchDuringARolloutIsOnlyInformational) {
    // Replica counts always diverge mid-rollout. Paging on that would train
    // people to ignore the detector.
    Json::Value observed = desiredState();
    observed["replicas"] = 2;
    observed["rolling_out"] = true;
    EXPECT_EQ(severityOf(DriftDetector::compare(desiredState(), observed), "replicas"),
              drift::kSeverityInfo);
}

TEST(Drift, AMismatchedImageIsHighSeverity) {
    Json::Value observed = desiredState();
    observed["image"] = "registry.local/app:v6";
    const DriftReport report = DriftDetector::compare(desiredState(), observed);
    EXPECT_TRUE(hasFinding(report, "image"));
    EXPECT_EQ(severityOf(report, "image"), drift::kSeverityHigh);
}

TEST(Drift, IdentityMismatchesAreHighSeverity) {
    // If the platform is managing a different object than it reports on,
    // scaling and teardown act on the wrong thing.
    Json::Value observed = desiredState();
    observed["namespace"] = "team-a-web-old";
    observed["deployment_name"] = "web-canary";
    const DriftReport report = DriftDetector::compare(desiredState(), observed);
    EXPECT_EQ(severityOf(report, "namespace"), drift::kSeverityHigh);
    EXPECT_EQ(severityOf(report, "deployment_name"), drift::kSeverityHigh);
}

TEST(Drift, RoutingMismatchesAreWarnings) {
    Json::Value observed = desiredState();
    observed["exposure"] = "nodeport";
    observed["runtime_url"] = "http://10.0.0.4:32100";
    const DriftReport report = DriftDetector::compare(desiredState(), observed);
    EXPECT_EQ(severityOf(report, "exposure"), drift::kSeverityWarning);
    EXPECT_EQ(severityOf(report, "runtime_url"), drift::kSeverityWarning);
}

TEST(Drift, FieldsTheClusterDidNotReportAreSkipped) {
    // A partial inspect must not be read as "everything is empty". Reporting
    // image drift because the field was absent would be a false alarm on every
    // check that timed out halfway.
    Json::Value observed(Json::objectValue);
    observed["replicas"] = 3;
    const DriftReport report = DriftDetector::compare(desiredState(), observed);
    EXPECT_EQ(report.status, "ok");
    EXPECT_FALSE(hasFinding(report, "image"));
}

TEST(Drift, AnUnpinnedDesiredValueMatchesAnything) {
    // An empty desired value means we never specified it, so the cluster
    // cannot be wrong about it.
    Json::Value desired = desiredState();
    desired["runtime_url"] = "";
    Json::Value observed = desiredState();
    observed["runtime_url"] = "http://whatever.local";
    EXPECT_FALSE(hasFinding(DriftDetector::compare(desired, observed), "runtime_url"));
}

TEST(Drift, WhitespaceDoesNotCountAsDrift) {
    Json::Value observed = desiredState();
    observed["image"] = "  registry.local/app:v7  ";
    EXPECT_FALSE(hasFinding(DriftDetector::compare(desiredState(), observed), "image"));
}

TEST(Drift, EveryFindingCarriesAnExplanation) {
    // The summary is what a person reads at 3am; a finding without a detail
    // string is a puzzle rather than a report.
    Json::Value observed = desiredState();
    observed["replicas"] = 1;
    observed["image"] = "registry.local/app:v6";
    const DriftReport report = DriftDetector::compare(desiredState(), observed);
    EXPECT_TRUE(report.findings.size() >= 2u);
    for (const auto& item : report.findings) {
        EXPECT_FALSE(item["detail"].asString().empty());
        EXPECT_FALSE(item["severity"].asString().empty());
        EXPECT_FALSE(item["field"].asString().empty());
    }
}

TEST(Summarize, ReportsNothingWhenClean) {
    EXPECT_EQ(DriftDetector::summarize(Json::Value(Json::arrayValue)), "No drift detected");
}

TEST(Summarize, CountsFindingsAndFlagsTheUrgentOnes) {
    Json::Value observed = desiredState();
    observed["replicas"] = 1;          // high
    observed["exposure"] = "nodeport"; // warning
    const DriftReport report = DriftDetector::compare(desiredState(), observed);
    EXPECT_CONTAINS(report.summary, "2 differences");
    EXPECT_CONTAINS(report.summary, "1 needing attention");
}

TEST(Summarize, UsesSingularForOneFinding) {
    Json::Value observed = desiredState();
    observed["exposure"] = "nodeport";
    EXPECT_CONTAINS(DriftDetector::compare(desiredState(), observed).summary, "1 difference between");
}
