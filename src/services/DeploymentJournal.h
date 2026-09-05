// ============================================================
// DeploymentJournal.h — a deployment's log, and the state derived from it
// ============================================================
// Appending to the log and publishing the deployment summary live together
// because they are not actually separable: the summary reports port
// adjustments, and the only record of those is a marker line the build wrote
// into the log. Splitting them would mean one module parsing the other's
// output across a boundary that buys nothing.
//
// Extracted from DeploymentController's anonymous namespace. extractPortAdjustments
// is the reason this is worth having as its own unit — it parses build output
// with hand-rolled string offsets, is trivially wrong at boundaries, and was
// previously unreachable from a test.

#pragma once

#include <json/json.h>
#include <pqxx/pqxx>
#include <string>

namespace stackpilot {

class DeploymentJournal {
public:
    /// Appends one line. Failures are logged, never thrown: losing a log line
    /// must not abort the deployment that was writing it.
    static void appendLine(const std::string& deploymentId, const std::string& line);

    /// Splits a block on newlines and appends each non-empty line.
    static void appendBlock(const std::string& deploymentId, const std::string& block);

    /// Flushes any buffered log lines for deploymentId (or all deployments if empty).
    static void flush(const std::string& deploymentId = "");

    /// Parses `__STACKPILOT_PORT_ADJUSTED__=key:from:to` markers out of build
    /// output. Pure; returns an array of {key, from, to} objects. Malformed
    /// markers are skipped rather than partially reported.
    static Json::Value extractPortAdjustments(const std::string& logs);

    /// Fills the runtime fields on a deployment JSON object from a row,
    /// preferring the runtime_snapshot over the flat columns where both exist.
    static void hydrateRuntimeFields(Json::Value& deployment, const pqxx::row& row);

    /// Full deployment summary, or a null value when the id does not exist.
    /// Carries `__owner_user_id` for routing; broadcastSummary strips it.
    static Json::Value loadSummary(const std::string& deploymentId);

    /// Pushes the summary to the owner's WebSocket channel.
    static void broadcastSummary(const std::string& deploymentId);
};

}  // namespace stackpilot
