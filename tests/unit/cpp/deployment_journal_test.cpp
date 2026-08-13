// Unit tests for the pure half of src/services/DeploymentJournal.cpp.
//
// extractPortAdjustments parses build output with hand-rolled string offsets.
// It is the kind of code that is right for the happy path and wrong at every
// boundary — a marker at end-of-input with no trailing newline, a truncated
// payload, two markers on adjacent lines. It fed the deployment summary from
// inside an anonymous namespace, so none of that was reachable from a test.
//
// The database-backed members (appendLine, loadSummary, broadcastSummary) are
// covered end-to-end by tests/integration/test_platform.py instead.

#include "testing.h"

#include "../../../src/services/DeploymentJournal.h"

using namespace stackpilot;

namespace {

const char* kMarker = "__STACKPILOT_PORT_ADJUSTED__=";

std::string marker(const std::string& payload) {
    return std::string(kMarker) + payload + "\n";
}

}  // namespace

TEST(PortAdjustments, EmptyLogsYieldAnEmptyArray) {
    const Json::Value result = DeploymentJournal::extractPortAdjustments("");
    EXPECT_TRUE(result.isArray());
    EXPECT_EQ(result.size(), 0u);
}

TEST(PortAdjustments, LogsWithNoMarkersYieldAnEmptyArray) {
    const Json::Value result = DeploymentJournal::extractPortAdjustments(
        "Step 1/5 : FROM node:20\nSuccessfully built abc123\n");
    EXPECT_EQ(result.size(), 0u);
}

TEST(PortAdjustments, ParsesASingleAdjustment) {
    const Json::Value result = DeploymentJournal::extractPortAdjustments(marker("PORT:3000:3001"));
    EXPECT_EQ(result.size(), 1u);
    EXPECT_EQ(result[0]["key"].asString(), std::string("PORT"));
    EXPECT_EQ(result[0]["from"].asString(), std::string("3000"));
    EXPECT_EQ(result[0]["to"].asString(), std::string("3001"));
}

TEST(PortAdjustments, ParsesSeveralAdjustments) {
    const Json::Value result = DeploymentJournal::extractPortAdjustments(
        "building...\n" + marker("PORT:3000:3001") + "more output\n" + marker("DB_PORT:5432:5433"));
    EXPECT_EQ(result.size(), 2u);
    EXPECT_EQ(result[0]["key"].asString(), std::string("PORT"));
    EXPECT_EQ(result[1]["key"].asString(), std::string("DB_PORT"));
    EXPECT_EQ(result[1]["to"].asString(), std::string("5433"));
}

TEST(PortAdjustments, ParsesAdjacentMarkers) {
    const Json::Value result = DeploymentJournal::extractPortAdjustments(
        marker("A:1:2") + marker("B:3:4"));
    EXPECT_EQ(result.size(), 2u);
    EXPECT_EQ(result[1]["key"].asString(), std::string("B"));
}

TEST(PortAdjustments, HandlesAMarkerAtEndOfInputWithNoTrailingNewline) {
    // The scan looks for '\n' to bound the payload; without one it must read
    // to end-of-string rather than returning nothing or running past the end.
    const Json::Value result = DeploymentJournal::extractPortAdjustments(
        std::string(kMarker) + "PORT:3000:3001");
    EXPECT_EQ(result.size(), 1u);
    EXPECT_EQ(result[0]["to"].asString(), std::string("3001"));
}

TEST(PortAdjustments, TrimsCarriageReturnsFromWindowsStyleOutput) {
    // Build output that crossed a CRLF boundary would otherwise yield "3001\r"
    // as the port, which reaches the UI as a broken URL.
    const Json::Value result = DeploymentJournal::extractPortAdjustments(
        std::string(kMarker) + "PORT:3000:3001\r\n");
    EXPECT_EQ(result.size(), 1u);
    EXPECT_EQ(result[0]["to"].asString(), std::string("3001"));
}

TEST(PortAdjustments, SkipsMalformedMarkersRatherThanPartiallyReporting) {
    // One colon, no colons, and empty payloads are all incomplete. Reporting
    // half an adjustment is worse than reporting none.
    const Json::Value result = DeploymentJournal::extractPortAdjustments(
        marker("PORT:3000") + marker("JUSTKEY") + marker("") + marker("OK:1:2"));
    EXPECT_EQ(result.size(), 1u);
    EXPECT_EQ(result[0]["key"].asString(), std::string("OK"));
}

TEST(PortAdjustments, KeepsEverythingAfterTheSecondColon) {
    // Split is key:from:rest — "from" is bounded by the second colon and "to"
    // takes the entire remainder, so a value containing colons (an addr:port,
    // an IPv6 literal) is preserved rather than truncated at the third colon.
    const Json::Value result = DeploymentJournal::extractPortAdjustments(marker("ADDR:a:b:c"));
    EXPECT_EQ(result.size(), 1u);
    EXPECT_EQ(result[0]["key"].asString(), std::string("ADDR"));
    EXPECT_EQ(result[0]["from"].asString(), std::string("a"));
    EXPECT_EQ(result[0]["to"].asString(), std::string("b:c"));
}

TEST(PortAdjustments, IgnoresMarkerTextInTheMiddleOfALine) {
    // A build that echoes the marker name in prose should still parse the real
    // marker that follows.
    const Json::Value result = DeploymentJournal::extractPortAdjustments(
        "note: look for " + std::string(kMarker) + "KEY:1:2\n");
    EXPECT_EQ(result.size(), 1u);
    EXPECT_EQ(result[0]["key"].asString(), std::string("KEY"));
}

TEST(PortAdjustments, DoesNotLoopForeverOnRepeatedMarkers) {
    // The scan advances past each marker; a bug there would hang the request
    // thread rather than fail it.
    std::string logs;
    for (int i = 0; i < 200; ++i) {
        logs += marker("K" + std::to_string(i) + ":1:2");
    }
    EXPECT_EQ(DeploymentJournal::extractPortAdjustments(logs).size(), 200u);
}
