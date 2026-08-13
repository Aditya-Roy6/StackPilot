// ============================================================
// AgentPolicy.h — server-side enforcement of agent permissions
// ============================================================
// The AI agent drives ordinary API routes (create project, create deployment,
// trigger build). Those calls are indistinguishable from the user clicking the
// same buttons, so the agent marks its own requests with a header and the
// server checks them against the user's stored policy.
//
// The header is cooperative, not a security boundary — a caller can omit it.
// That is the correct threat model here: the risk being managed is *the agent
// acting beyond what the user intended*, not the user attacking their own
// account. Authorization for the account itself is handled by JWT/MCP scopes.
// ============================================================

#pragma once

#include <drogon/HttpRequest.h>
#include <string>

namespace stackpilot {

class AgentPolicy {
public:
    // True when the request declares itself as agent-initiated.
    static bool isAgentRequest(const drogon::HttpRequestPtr& req);

    // The action name the agent declared, for audit purposes ("" if none).
    static std::string declaredAction(const drogon::HttpRequestPtr& req);

    /**
     * Returns true when an agent-initiated, state-changing request may proceed.
     * Non-agent requests always pass. On refusal, `reason` explains why in terms
     * the agent can relay to the user.
     */
    static bool allowsMutation(const drogon::HttpRequestPtr& req,
                               const std::string& userId,
                               std::string& reason);
};

} // namespace stackpilot
