// ============================================================
// AiStreamProxy.h — forward the ai-service SSE stream to the browser
// ============================================================
// The blocking path waits for the whole reply before anything reaches the
// client. This forwards each Server-Sent Event as it arrives, so the browser
// can render reasoning token by token instead of showing a spinner for twenty
// seconds and then a wall of text.
//
// Runs on a BlockingTaskRunner worker rather than a Drogon event-loop thread:
// curl's transfer loop blocks for the whole life of the stream, which on an
// event loop would stall every other request the platform is serving.

#pragma once

#include <functional>
#include <json/json.h>
#include <string>

namespace stackpilot {

class AiStreamProxy {
public:
    /// Called for each complete SSE frame's data payload, in order.
    using OnChunk = std::function<void(const std::string& sseFrame)>;
    /// Called once when the upstream stream finishes or fails.
    using OnFinish = std::function<void(bool ok, const std::string& error)>;

    /**
     * POSTs `payload` to the ai-service at `path` and forwards the response
     * body to `onChunk` as it arrives.
     *
     * Blocking. The caller is responsible for running it off the event loop.
     */
    static void stream(const std::string& path,
                       const Json::Value& payload,
                       const OnChunk& onChunk,
                       const OnFinish& onFinish);
};

}  // namespace stackpilot
