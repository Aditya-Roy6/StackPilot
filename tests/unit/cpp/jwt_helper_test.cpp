// Unit tests for src/utils/JwtHelper.cpp.
//
// Focus is the scope gate. MCP tokens are handed to third-party IDEs, and
// before mcpTokenPermitsRequest existed the `permissions` array was written to
// the database and never read — every MCP token was an unscoped, full-account
// credential. These tests pin the gate closed.
//
// createToken/verifyToken are covered as a round trip plus the tamper cases;
// verifyRequestToken and verifyMcpToken are not tested here because they hit
// the database (see tests/integration/test_platform.py for those paths).

#include "testing.h"

#include "../../../src/utils/JwtHelper.h"

#include <cstdlib>
#include <drogon/HttpRequest.h>

using namespace stackpilot;

namespace {

/// Every test needs a valid signing key; getSecretKey() throws below 32 chars.
struct SecretFixture {
    SecretFixture() {
        ::setenv("JWT_SECRET", "unit-test-secret-key-at-least-32-chars-long", 1);
    }
};
const SecretFixture kSecret;

drogon::HttpRequestPtr requestWithMethod(drogon::HttpMethod method) {
    auto req = drogon::HttpRequest::newHttpRequest();
    req->setMethod(method);
    req->setPath("/api/v1/projects");
    return req;
}

Json::Value payloadWithScopes(const std::vector<std::string>& scopes) {
    Json::Value payload(Json::objectValue);
    Json::Value perms(Json::arrayValue);
    for (const auto& scope : scopes) {
        perms.append(scope);
    }
    payload["permissions"] = perms;
    return payload;
}

}  // namespace

// ─── token round trip ───────────────────────────────────────────

TEST(JwtToken, RoundTripsUserIdAndEmail) {
    // The claim is `user_id`, not `userId`. Pinned here because handlers read
    // it by string key: a rename would compile fine and log every request out.
    const std::string token = JwtHelper::createToken("user-123", "someone@example.com");
    const Json::Value payload = JwtHelper::verifyToken(token);
    EXPECT_EQ(payload["user_id"].asString(), std::string("user-123"));
    EXPECT_EQ(payload["email"].asString(), std::string("someone@example.com"));
    EXPECT_TRUE(payload.isMember("iat"));
    EXPECT_TRUE(payload.isMember("exp"));
}

TEST(JwtToken, IssuedTokenIsNotAlreadyExpired) {
    const Json::Value payload = JwtHelper::verifyToken(
        JwtHelper::createToken("user-123", "someone@example.com"));
    EXPECT_FALSE(JwtHelper::isExpired(payload));
}

TEST(JwtToken, RejectsATamperedPayload) {
    std::string token = JwtHelper::createToken("user-123", "someone@example.com");
    // Flip a byte in the payload segment; the signature must no longer verify.
    const auto firstDot = token.find('.');
    token[firstDot + 3] = token[firstDot + 3] == 'A' ? 'B' : 'A';
    EXPECT_TRUE(JwtHelper::verifyToken(token).isNull() ||
                !JwtHelper::verifyToken(token).isMember("user_id"));
}

TEST(JwtToken, RejectsAStrippedSignature) {
    const std::string token = JwtHelper::createToken("user-123", "someone@example.com");
    const std::string unsigned_ = token.substr(0, token.rfind('.') + 1);
    const Json::Value payload = JwtHelper::verifyToken(unsigned_);
    EXPECT_TRUE(payload.isNull() || !payload.isMember("user_id"));
}

TEST(JwtToken, RejectsGarbage) {
    EXPECT_TRUE(JwtHelper::verifyToken("not-a-token").isNull() ||
                !JwtHelper::verifyToken("not-a-token").isMember("user_id"));
    EXPECT_TRUE(JwtHelper::verifyToken("").isNull() ||
                !JwtHelper::verifyToken("").isMember("user_id"));
}

// ─── isExpired ──────────────────────────────────────────────────

TEST(JwtExpiry, MissingExpClaimCountsAsExpired) {
    // Fail closed: a token with no expiry must not be treated as eternal.
    EXPECT_TRUE(JwtHelper::isExpired(Json::Value(Json::objectValue)));
}

TEST(JwtExpiry, PastExpIsExpiredFutureExpIsNot) {
    Json::Value past(Json::objectValue);
    past["exp"] = Json::Int64(1000000000);  // 2001
    EXPECT_TRUE(JwtHelper::isExpired(past));

    Json::Value future(Json::objectValue);
    future["exp"] = Json::Int64(4102444800);  // 2100
    EXPECT_FALSE(JwtHelper::isExpired(future));
}

// ─── MCP scope gate ─────────────────────────────────────────────

TEST(McpScopes, MissingPermissionsIsReadOnly) {
    // The regression this guards: an unscoped token used to mean full access.
    const Json::Value payload(Json::objectValue);
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Post)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Delete)));
}

TEST(McpScopes, EmptyPermissionsArrayIsReadOnly) {
    const Json::Value payload = payloadWithScopes({});
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Post)));
}

TEST(McpScopes, ReadScopeCannotMutate) {
    const Json::Value payload = payloadWithScopes({"read"});
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Head)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Post)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Put)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Patch)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Delete)));
}

TEST(McpScopes, DeployScopeCannotDelete) {
    // The important asymmetry: an IDE that can deploy must not be able to
    // destroy projects.
    const Json::Value payload = payloadWithScopes({"deploy"});
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Post)));
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Put)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Delete)));
}

TEST(McpScopes, DeployWithoutReadStillCannotRead) {
    // deploy does not imply read; only admin/* widen.
    const Json::Value payload = payloadWithScopes({"deploy"});
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
}

TEST(McpScopes, AdminImpliesReadAndDeploy) {
    const Json::Value payload = payloadWithScopes({"admin"});
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Post)));
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Delete)));
}

TEST(McpScopes, WildcardIsFullAccess) {
    const Json::Value payload = payloadWithScopes({"*"});
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Post)));
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Delete)));
}

TEST(McpScopes, UnknownScopesGrantNothing) {
    const Json::Value payload = payloadWithScopes({"superuser", "root", "owner"});
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Post)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Delete)));
}

TEST(McpScopes, NonStringEntriesAreIgnoredNotCrashed) {
    Json::Value payload(Json::objectValue);
    Json::Value perms(Json::arrayValue);
    perms.append(42);
    perms.append(Json::Value(Json::objectValue));
    perms.append("read");
    payload["permissions"] = perms;
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Post)));
}

TEST(McpScopes, PermissionsAsAStringIsTreatedAsUnscoped) {
    // Legacy rows stored permissions as a comma string. That must degrade to
    // read-only, not to full access.
    Json::Value payload(Json::objectValue);
    payload["permissions"] = "read,deploy,admin";
    EXPECT_TRUE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Get)));
    EXPECT_FALSE(JwtHelper::mcpTokenPermitsRequest(payload, requestWithMethod(drogon::Delete)));
}
