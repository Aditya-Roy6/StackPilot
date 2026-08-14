// ============================================================
// AiStreamController.cpp — live agent replies over SSE
// ============================================================
// The browser opens one POST and holds it. Reasoning and content frames are
// forwarded as the model produces them, so the user watches the answer form
// instead of watching a spinner.
//
// Member of AiController, kept in its own translation unit: AiController.cpp
// is already large and this is a self-contained concern.

#include "AiController.h"

#include "../db/Database.h"
#include "../services/AiStreamProxy.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/JwtHelper.h"
#include "../utils/StringUtils.h"

#include <atomic>
#include <json/json.h>
#include <memory>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

namespace stackpilot {
namespace {

/// Wraps the Drogon stream so the curl thread can push frames safely and the
/// stream is closed exactly once however the transfer ends.
struct SseWriter {
    drogon::ResponseStreamPtr stream;
    std::atomic<bool> closed{false};

    void send(const std::string& frame) {
        if (closed.load()) return;
        if (!stream || !stream->send(frame)) {
            // send() returning false means the client hung up. Stop writing;
            // continuing would pump an entire model response into a socket
            // nobody is reading.
            closed.store(true);
        }
    }

    void finish() {
        if (closed.exchange(true)) return;
        if (stream) stream->close();
    }
};

std::string sseFrame(const Json::Value& payload) {
    return "data: " + strings::compactJson(payload) + "\n\n";
}

}  // namespace

void AiController::chatAgentStream(const drogon::HttpRequestPtr& req,
                                   std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const Json::Value auth = JwtHelper::verifyRequestToken(req);
    if (auth.isNull() || !auth.isMember("user_id")) {
        Json::Value err;
        err["error"] = "Unauthorized";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp);
        return;
    }
    const std::string userId = auth["user_id"].asString();

    const auto body = req->getJsonObject();
    if (!body || !body->isMember("message") || strings::trim((*body)["message"].asString()).empty()) {
        Json::Value err;
        err["error"] = "message is required";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp);
        return;
    }

    // Build the upstream payload before the stream opens: once headers are
    // sent there is no way to return a clean HTTP error.
    Json::Value payload(Json::objectValue);
    payload["message"] = (*body)["message"].asString();
    payload["workflow_type"] = "agent_chat";
    payload["model_mode"] = body->isMember("model_mode") ? (*body)["model_mode"].asString() : "fast";
    if (body->isMember("model")) payload["model"] = (*body)["model"];
    if (body->isMember("provider")) payload["provider"] = (*body)["provider"];
    if (body->isMember("project")) payload["project"] = (*body)["project"];
    if (body->isMember("logs")) payload["logs"] = (*body)["logs"];

    auto response = drogon::HttpResponse::newAsyncStreamResponse(
        [payload, userId](drogon::ResponseStreamPtr stream) {
            auto writer = std::make_shared<SseWriter>();
            writer->stream = std::move(stream);

            // curl blocks for the life of the transfer, so this cannot run on
            // an event-loop thread without stalling every other request.
            BlockingTaskRunner::run([payload, userId, writer]() {
                AiStreamProxy::stream(
                    "/chat/agent/stream",
                    payload,
                    [writer](const std::string& frame) { writer->send(frame); },
                    [writer, userId](bool ok, const std::string& error) {
                        if (!ok) {
                            Json::Value failure(Json::objectValue);
                            failure["type"] = "error";
                            failure["error"] = error;
                            writer->send(sseFrame(failure));
                        }
                        writer->finish();
                    });
            });
        });

    response->setContentTypeCodeAndCustomString(drogon::CT_CUSTOM, "text/event-stream");
    response->addHeader("Cache-Control", "no-cache");
    response->addHeader("Connection", "keep-alive");
    // Proxies that buffer will hold the whole response and deliver it at once,
    // which is indistinguishable from streaming being broken.
    response->addHeader("X-Accel-Buffering", "no");
    callback(response);
}

}  // namespace stackpilot
