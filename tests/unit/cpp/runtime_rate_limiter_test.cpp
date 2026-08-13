// Unit tests for src/utils/RuntimeRateLimiter.cpp.
//
// This logic was 96 lines inside DeploymentController.cpp's anonymous
// namespace, which made it unreachable from a test. Extracting it was the
// point: a limiter that blocks too eagerly locks a user out of their own
// deployment, and one that never blocks is decoration.

#include "testing.h"

#include "../../../src/utils/RuntimeRateLimiter.h"

using namespace stackpilot;

namespace {

/// Trips the limiter deterministically without waiting on a real clock.
const RuntimeRateLimitPolicy kFast{3, 300, 300};

/// Blocks for 0 seconds, so the block is already over the moment it is set.
const RuntimeRateLimitPolicy kInstantExpiry{2, 300, 0};

std::string freshKey(const char* name) {
    RuntimeRateLimiter::clear(name);
    return name;
}

}  // namespace

TEST(RateLimiter, AnUnknownKeyIsNotLimited) {
    int retryAfter = -1;
    EXPECT_FALSE(RuntimeRateLimiter::isLimited("never-seen", retryAfter));
    EXPECT_EQ(retryAfter, 0);
}

TEST(RateLimiter, StaysOpenBelowTheThreshold) {
    const std::string key = freshKey("below-threshold");
    int retryAfter = 0;
    for (int i = 0; i < kFast.maxAttempts - 1; ++i) {
        RuntimeRateLimiter::recordFailure(key, kFast);
        EXPECT_FALSE(RuntimeRateLimiter::isLimited(key, retryAfter));
    }
}

TEST(RateLimiter, BlocksOnceTheThresholdIsReached) {
    const std::string key = freshKey("at-threshold");
    for (int i = 0; i < kFast.maxAttempts; ++i) {
        RuntimeRateLimiter::recordFailure(key, kFast);
    }
    int retryAfter = 0;
    EXPECT_TRUE(RuntimeRateLimiter::isLimited(key, retryAfter));
    EXPECT_TRUE(retryAfter > 0);
    EXPECT_TRUE(retryAfter <= kFast.blockSeconds);
}

TEST(RateLimiter, FurtherFailuresDoNotExtendAnActiveBlock) {
    // A client that keeps polling while blocked must still recover on schedule
    // rather than having its block refreshed forever.
    const std::string key = freshKey("no-extension");
    for (int i = 0; i < kFast.maxAttempts; ++i) {
        RuntimeRateLimiter::recordFailure(key, kFast);
    }
    const int first = RuntimeRateLimiter::retryAfterSeconds(key);
    for (int i = 0; i < 50; ++i) {
        RuntimeRateLimiter::recordFailure(key, kFast);
    }
    const int after = RuntimeRateLimiter::retryAfterSeconds(key);
    EXPECT_TRUE(after <= first);
}

TEST(RateLimiter, SuccessClearsTheCounter) {
    // The counter tracks *failures*. A user who succeeds must not carry
    // accumulated attempts into their next operation.
    const std::string key = freshKey("cleared-by-success");
    for (int i = 0; i < kFast.maxAttempts - 1; ++i) {
        RuntimeRateLimiter::recordFailure(key, kFast);
    }
    RuntimeRateLimiter::clear(key);

    for (int i = 0; i < kFast.maxAttempts - 1; ++i) {
        RuntimeRateLimiter::recordFailure(key, kFast);
    }
    int retryAfter = 0;
    EXPECT_FALSE(RuntimeRateLimiter::isLimited(key, retryAfter));
}

TEST(RateLimiter, AnExpiredBlockReleases) {
    const std::string key = freshKey("expires");
    for (int i = 0; i < kInstantExpiry.maxAttempts; ++i) {
        RuntimeRateLimiter::recordFailure(key, kInstantExpiry);
    }
    int retryAfter = 0;
    EXPECT_FALSE(RuntimeRateLimiter::isLimited(key, retryAfter));
}

TEST(RateLimiter, KeysAreIndependent) {
    // One noisy client must not lock out everyone else.
    const std::string noisy = freshKey("noisy-client");
    const std::string quiet = freshKey("quiet-client");
    for (int i = 0; i < kFast.maxAttempts * 2; ++i) {
        RuntimeRateLimiter::recordFailure(noisy, kFast);
    }
    int retryAfter = 0;
    EXPECT_TRUE(RuntimeRateLimiter::isLimited(noisy, retryAfter));
    EXPECT_FALSE(RuntimeRateLimiter::isLimited(quiet, retryAfter));
}

TEST(RateLimiter, KeyIncludesScopeUserAndDeployment) {
    // Two users acting on the same deployment, and one user acting on two
    // deployments, must land in different buckets.
    const auto key = [](const char* scope, const char* user, const char* dep) {
        return RuntimeRateLimiter::makeKey(scope, nullptr, user, dep);
    };
    EXPECT_FALSE(key("start", "u1", "d1") == key("stop", "u1", "d1"));
    EXPECT_FALSE(key("start", "u1", "d1") == key("start", "u2", "d1"));
    EXPECT_FALSE(key("start", "u1", "d1") == key("start", "u1", "d2"));
    EXPECT_EQ(key("start", "u1", "d1"), key("start", "u1", "d1"));
}

TEST(RateLimiter, ClientAddressIsUnknownForANullRequest) {
    EXPECT_EQ(RuntimeRateLimiter::clientAddress(nullptr), "unknown");
}

TEST(RateLimiter, LimitedResponseIs429WithARetryAfterHeader) {
    const auto resp = RuntimeRateLimiter::makeLimitedResponse(42);
    EXPECT_EQ(static_cast<int>(resp->statusCode()), 429);
    EXPECT_EQ(resp->getHeader("Retry-After"), "42");
}

TEST(RateLimiter, RetryAfterIsNeverZeroInTheResponse) {
    // A "Retry-After: 0" tells a well-behaved client to retry immediately,
    // which is the opposite of the intent.
    EXPECT_EQ(RuntimeRateLimiter::makeLimitedResponse(0)->getHeader("Retry-After"), "1");
    EXPECT_EQ(RuntimeRateLimiter::makeLimitedResponse(-5)->getHeader("Retry-After"), "1");
}
