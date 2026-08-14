// ============================================================
// AiStreamProxy.cpp
// ============================================================

#include "AiStreamProxy.h"

#include "../utils/StringUtils.h"

#include <curl/curl.h>
#include <cstdlib>
#include <spdlog/spdlog.h>

namespace stackpilot {
namespace {

struct StreamContext {
    const AiStreamProxy::OnChunk* onChunk;
    // SSE frames are newline-delimited but a TCP read can split one anywhere,
    // including mid-UTF-8. Everything after the last complete frame stays here
    // until the rest of it arrives.
    std::string pending;
};

std::size_t streamWriteCallback(void* contents, std::size_t size, std::size_t nmemb, void* userp) {
    auto* context = static_cast<StreamContext*>(userp);
    const std::size_t bytes = size * nmemb;
    context->pending.append(static_cast<char*>(contents), bytes);

    // An SSE frame ends with a blank line. Emit only complete frames so the
    // browser never has to reassemble a partial JSON payload.
    std::size_t boundary;
    while ((boundary = context->pending.find("\n\n")) != std::string::npos) {
        const std::string frame = context->pending.substr(0, boundary + 2);
        context->pending.erase(0, boundary + 2);
        if (context->onChunk && *context->onChunk) {
            (*context->onChunk)(frame);
        }
    }
    return bytes;
}

std::string serviceUrl() {
    const char* value = std::getenv("STACKPILOT_AI_SERVICE_URL");
    std::string url = (value && *value) ? value : "http://ai-service:8010";
    while (!url.empty() && url.back() == '/') {
        url.pop_back();
    }
    return url;
}

long streamTimeoutSeconds() {
    // Much longer than the blocking path's timeout. A thinking-mode reply can
    // legitimately take minutes, and the whole point of streaming is that the
    // user sees progress while it does.
    const std::string raw = strings::getEnvOrDefault("STACKPILOT_AI_STREAM_TIMEOUT_SECONDS", "600");
    try {
        const long parsed = std::stol(raw);
        return parsed > 0 ? parsed : 600;
    } catch (...) {
        return 600;
    }
}

}  // namespace

void AiStreamProxy::stream(const std::string& path,
                           const Json::Value& payload,
                           const OnChunk& onChunk,
                           const OnFinish& onFinish) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        onFinish(false, "Could not initialise HTTP client");
        return;
    }

    const std::string url = serviceUrl() + path;
    const std::string body = strings::compactJson(payload);

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: text/event-stream");
    if (const char* serviceToken = std::getenv("STACKPILOT_AI_SERVICE_TOKEN")) {
        if (*serviceToken) {
            const std::string tokenHeader = std::string("X-StackPilot-Service-Token: ") + serviceToken;
            headers = curl_slist_append(headers, tokenHeader.c_str());
        }
    }

    StreamContext context{&onChunk, {}};

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, streamWriteCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &context);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, streamTimeoutSeconds());
    // Without this curl buffers, which would defeat the entire exercise.
    curl_easy_setopt(curl, CURLOPT_BUFFERSIZE, 1024L);

    const CURLcode result = curl_easy_perform(curl);

    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);

    // Anything left in the buffer had no terminating blank line. Forward it
    // rather than dropping it -- a truncated final frame is more useful to the
    // client than silence.
    if (!context.pending.empty() && onChunk) {
        onChunk(context.pending);
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (result != CURLE_OK) {
        spdlog::warn("AI stream transport failure: {}", curl_easy_strerror(result));
        onFinish(false, curl_easy_strerror(result));
        return;
    }
    if (status < 200 || status >= 300) {
        spdlog::warn("AI stream rejected with HTTP {}", status);
        onFinish(false, "ai-service returned HTTP " + std::to_string(status));
        return;
    }
    onFinish(true, "");
}

}  // namespace stackpilot
