// ============================================================
// RuntimeRateLimiter.cpp
// ============================================================

#include "RuntimeRateLimiter.h"

#include "StringUtils.h"

#include <algorithm>
#include <json/json.h>
#include <mutex>
#include <unordered_map>

namespace stackpilot {
namespace {

using strings::toLower;
using strings::trim;

struct Bucket {
    int attempts = 0;
    std::chrono::steady_clock::time_point windowStart = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point blockedUntil = std::chrono::steady_clock::time_point::min();
};

std::mutex g_mutex;
std::unordered_map<std::string, Bucket> g_buckets;

}  // namespace

std::string RuntimeRateLimiter::clientAddress(const drogon::HttpRequestPtr& req) {
    if (!req) {
        return "unknown";
    }

    const std::string peerIp = toLower(req->peerAddr().toIp());
    if (strings::isTrustedProxy(peerIp)) {
        const std::string forwarded = trim(req->getHeader("X-Forwarded-For"));
        if (!forwarded.empty()) {
            const auto comma = forwarded.find(',');
            return toLower(trim(forwarded.substr(0, comma)));
        }
    }

    return peerIp;
}

std::string RuntimeRateLimiter::makeKey(const std::string& scope,
                                        const drogon::HttpRequestPtr& req,
                                        const std::string& userId,
                                        const std::string& deploymentId) {
    return scope + ":" + clientAddress(req) + ":" + userId + ":" + deploymentId;
}

int RuntimeRateLimiter::retryAfterSeconds(const std::string& key) {
    std::lock_guard<std::mutex> lock(g_mutex);
    const auto it = g_buckets.find(key);
    if (it == g_buckets.end()) {
        return 0;
    }

    const auto now = std::chrono::steady_clock::now();
    if (now >= it->second.blockedUntil) {
        return 0;
    }

    return static_cast<int>(
        std::chrono::duration_cast<std::chrono::seconds>(it->second.blockedUntil - now).count());
}

bool RuntimeRateLimiter::isLimited(const std::string& key, int& retryAfter) {
    retryAfter = retryAfterSeconds(key);
    return retryAfter > 0;
}

void RuntimeRateLimiter::recordFailure(const std::string& key, const RuntimeRateLimitPolicy& policy) {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto& state = g_buckets[key];
    const auto now = std::chrono::steady_clock::now();

    if (now >= state.blockedUntil && now - state.windowStart > std::chrono::seconds(policy.windowSeconds)) {
        state.attempts = 0;
        state.windowStart = now;
    }

    // Already blocked: do not extend the block on every retry, or a client
    // that keeps polling could never recover.
    if (state.blockedUntil > now) {
        return;
    }

    if (state.attempts == 0) {
        state.windowStart = now;
    }

    ++state.attempts;
    if (state.attempts >= policy.maxAttempts) {
        state.blockedUntil = now + std::chrono::seconds(policy.blockSeconds);
        state.attempts = 0;
        state.windowStart = now;
    }
}

void RuntimeRateLimiter::clear(const std::string& key) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_buckets.erase(key);
}

drogon::HttpResponsePtr RuntimeRateLimiter::makeLimitedResponse(int retryAfter) {
    Json::Value err;
    err["error"] = "Too many runtime operations. Please wait and try again.";
    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
    resp->setStatusCode(drogon::k429TooManyRequests);
    resp->addHeader("Retry-After", std::to_string(std::max(1, retryAfter)));
    return resp;
}

void RuntimeRateLimiter::resetAllForTesting() {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_buckets.clear();
}

}  // namespace stackpilot
