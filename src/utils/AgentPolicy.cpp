// ============================================================
// AgentPolicy.cpp
// ============================================================

#include "AgentPolicy.h"

#include "../db/Database.h"

#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

namespace stackpilot {
namespace {

constexpr const char* kAgentHeader = "x-stackpilot-agent-action";
constexpr const char* kApprovalHeader = "x-stackpilot-agent-approved";

std::string loadAgentMode(const std::string& userId) {
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT agent_access_mode FROM ai_preferences WHERE user_id = $1",
            userId
        );
        txn.commit();
        if (rows.empty() || rows[0][0].is_null()) {
            return "ask";  // fail closed for users with no stored preference
        }
        return rows[0][0].as<std::string>();
    } catch (const std::exception& e) {
        spdlog::warn("Agent policy lookup failed, defaulting to 'ask': {}", e.what());
        return "ask";
    }
}

} // namespace

bool AgentPolicy::isAgentRequest(const drogon::HttpRequestPtr& req) {
    return !req->getHeader(kAgentHeader).empty();
}

std::string AgentPolicy::declaredAction(const drogon::HttpRequestPtr& req) {
    return req->getHeader(kAgentHeader);
}

bool AgentPolicy::allowsMutation(const drogon::HttpRequestPtr& req,
                                 const std::string& userId,
                                 std::string& reason) {
    if (!isAgentRequest(req)) {
        return true;  // a human clicking buttons is not governed by this policy
    }

    const std::string mode = loadAgentMode(userId);
    const std::string action = declaredAction(req);

    if (mode == "full_access") {
        return true;
    }

    if (mode == "auto_review") {
        // The UI sets this only after the user confirms the specific action.
        if (req->getHeader(kApprovalHeader) == "true") {
            return true;
        }
        reason = "Agent permissions are set to 'Review before acting'. Approve this "
                 "action (" + action + ") to continue, or switch to Full access in the AI settings.";
        return false;
    }

    reason = "Agent permissions are set to 'Ask first', so the agent cannot perform "
             "'" + action + "'. Change this in AI settings if you want the agent to act autonomously.";
    return false;
}

} // namespace stackpilot
