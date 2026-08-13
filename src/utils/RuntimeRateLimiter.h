// ============================================================
// RuntimeRateLimiter.h — abuse limiter for runtime mutations
// ============================================================
// Start/stop/restart/pause on a deployment are cheap to request and expensive
// to serve: each one shells out to Docker or SSH. This throttles repeated
// *failures* per (scope, client, user, deployment), so a stuck client cannot
// hammer a runtime, while a user doing legitimate work is never slowed down —
// successful operations clear the counter.
//
// State is in-process and intentionally so. It is a courtesy limiter in front
// of already-authenticated endpoints, not a security control; a multi-replica
// deployment gets one bucket per replica, which is fine for what it defends.

#pragma once

#include <chrono>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <string>

namespace stackpilot {

struct RuntimeRateLimitPolicy {
    int maxAttempts;
    int windowSeconds;
    int blockSeconds;
};

/// 12 failures inside 5 minutes earns a 5-minute block.
inline constexpr RuntimeRateLimitPolicy kRuntimeMutationRateLimit{12, 300, 300};

class RuntimeRateLimiter {
public:
    /// Best-effort client identity: first X-Forwarded-For hop, else peer IP.
    /// Spoofable by design — it only has to separate honest clients.
    static std::string clientAddress(const drogon::HttpRequestPtr& req);

    static std::string makeKey(const std::string& scope,
                               const drogon::HttpRequestPtr& req,
                               const std::string& userId,
                               const std::string& deploymentId);

    /// Seconds remaining on an active block, or 0 when not blocked.
    static int retryAfterSeconds(const std::string& key);

    static bool isLimited(const std::string& key, int& retryAfterSeconds);

    /// Records one failed attempt, blocking the key once the policy is hit.
    static void recordFailure(const std::string& key,
                              const RuntimeRateLimitPolicy& policy = kRuntimeMutationRateLimit);

    /// Called on success: a working client should never accumulate a block.
    static void clear(const std::string& key);

    static drogon::HttpResponsePtr makeLimitedResponse(int retryAfterSeconds);

    /// Test seam: drops all buckets. Not used by the running service.
    static void resetAllForTesting();
};

}  // namespace stackpilot
