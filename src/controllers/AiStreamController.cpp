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
#include <sstream>
#include <algorithm>
#include <regex>

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

std::string streamChatTitle(const std::string& message) {
    std::string title = strings::trim(message);
    title.erase(std::remove(title.begin(), title.end(), '\n'), title.end());
    title.erase(std::remove(title.begin(), title.end(), '\r'), title.end());
    if (title.size() > 72) {
        title = title.substr(0, 69) + "...";
    }
    return title.empty() ? "New AI chat" : title;
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

    const std::string userMessage = (*body)["message"].asString();
    std::string sessionId = body->isMember("session_id") ? (*body)["session_id"].asString() : "";
    std::string projectId = body->isMember("project_id") ? (*body)["project_id"].asString() : "";
    std::string deploymentId = body->isMember("deployment_id") ? (*body)["deployment_id"].asString() : "";
    std::string command = body->isMember("command") ? (*body)["command"].asString() : "";

    // Extract UUID from message if deploymentId or projectId not explicitly given
    std::string extractedUuid;
    {
        static const std::regex uuidRegex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
        std::smatch match;
        if (std::regex_search(userMessage, match, uuidRegex)) {
            extractedUuid = match.str();
        }
    }

    // Build the upstream payload before the stream opens
    Json::Value payload(Json::objectValue);
    payload["message"] = userMessage;
    payload["workflow_type"] = "agent_chat";
    payload["user_id"] = userId;
    payload["model_mode"] = body->isMember("model_mode") ? (*body)["model_mode"].asString() : "fast";
    if (!command.empty()) payload["command"] = command;
    if (body->isMember("model")) payload["model"] = (*body)["model"];
    if (body->isMember("provider")) payload["provider"] = (*body)["provider"];
    if (body->isMember("project")) payload["project"] = (*body)["project"];
    if (body->isMember("logs")) payload["logs"] = (*body)["logs"];
    if (body->isMember("runtime")) payload["runtime"] = (*body)["runtime"];
    if (body->isMember("agent_access_mode")) payload["agent_access_mode"] = (*body)["agent_access_mode"];
    if (body->isMember("remote_terminal")) payload["remote_terminal"] = (*body)["remote_terminal"];

    // Persist session and user message in database
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        // If deploymentId is empty but an extracted UUID matched a deployment, resolve it
        if (deploymentId.empty() && !extractedUuid.empty()) {
            auto dCheck = txn.exec_params(
                "SELECT d.id, d.project_id FROM deployments d JOIN projects p ON d.project_id = p.id "
                "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))",
                extractedUuid, userId);
            if (!dCheck.empty()) {
                deploymentId = extractedUuid;
                if (projectId.empty()) {
                    projectId = dCheck[0]["project_id"].as<std::string>();
                }
            }
        }

        // If deploymentId is still empty but sessionId is active, inherit from prior tool calls or session context
        if (deploymentId.empty() && !sessionId.empty()) {
            try {
                auto depInSession = txn.exec_params(
                    "SELECT (tc->'arguments'->>'deployment_id') as dep_id "
                    "FROM ai_messages m, jsonb_array_elements(COALESCE(m.metadata->'tool_calls', '[]'::jsonb)) tc "
                    "WHERE m.session_id = $1 AND tc->'arguments'->>'deployment_id' IS NOT NULL "
                    "ORDER BY m.created_at DESC LIMIT 1",
                    sessionId);
                if (!depInSession.empty() && !depInSession[0]["dep_id"].is_null()) {
                    deploymentId = depInSession[0]["dep_id"].as<std::string>();
                }
            } catch (...) {}
        }

        // If projectId is empty but an extracted UUID matched a project, resolve it
        if (projectId.empty() && !extractedUuid.empty()) {
            auto pCheck = txn.exec_params(
                "SELECT id FROM projects WHERE id = $1 AND (user_id = $2 OR has_project_access(id, $2))",
                extractedUuid, userId);
            if (!pCheck.empty()) {
                projectId = extractedUuid;
            }
        }

        // If projectId is still empty but sessionId is active, inherit from session
        if (projectId.empty() && !sessionId.empty()) {
            try {
                auto sessProj = txn.exec_params(
                    "SELECT project_id FROM ai_sessions WHERE id = $1 AND user_id = $2",
                    sessionId, userId);
                if (!sessProj.empty() && !sessProj[0]["project_id"].is_null()) {
                    projectId = sessProj[0]["project_id"].as<std::string>();
                }
            } catch (...) {}
        }

        // Populate deployment context if deployment_id is set
        if (!deploymentId.empty() && !payload.isMember("deployment")) {
            const auto dRows = txn.exec_params(
                "SELECT d.id, d.status, d.logs, d.image_name, d.runtime_url, d.project_id "
                "FROM deployments d JOIN projects p ON d.project_id = p.id "
                "WHERE d.id = $1 AND (p.user_id = $2 OR has_project_access(p.id, $2))",
                deploymentId, userId);
            if (!dRows.empty()) {
                Json::Value dep(Json::objectValue);
                dep["id"] = dRows[0]["id"].as<std::string>();
                dep["status"] = dRows[0]["status"].is_null() ? "" : dRows[0]["status"].as<std::string>();
                dep["image_name"] = dRows[0]["image_name"].is_null() ? "" : dRows[0]["image_name"].as<std::string>();
                dep["runtime_url"] = dRows[0]["runtime_url"].is_null() ? "" : dRows[0]["runtime_url"].as<std::string>();
                payload["deployment"] = dep;
                if (!payload.isMember("logs") && !dRows[0]["logs"].is_null()) {
                    payload["logs"] = dRows[0]["logs"].as<std::string>();
                }
                if (projectId.empty()) {
                    projectId = dRows[0]["project_id"].as<std::string>();
                }
            }
        }

        payload["project_id"] = projectId;
        payload["deployment_id"] = deploymentId;

        // Populate project context if project_id is set
        if (!projectId.empty() && !payload.isMember("project")) {
            const auto pRows = txn.exec_params(
                "SELECT id, name, description, repo_url, status, source_type, source_path "
                "FROM projects WHERE id = $1 AND (user_id = $2 OR has_project_access(id, $2))",
                projectId, userId);
            if (!pRows.empty()) {
                Json::Value proj(Json::objectValue);
                proj["id"] = pRows[0]["id"].as<std::string>();
                proj["name"] = pRows[0]["name"].as<std::string>();
                proj["description"] = pRows[0]["description"].is_null() ? "" : pRows[0]["description"].as<std::string>();
                proj["repo_url"] = pRows[0]["repo_url"].is_null() ? "" : pRows[0]["repo_url"].as<std::string>();
                proj["status"] = pRows[0]["status"].is_null() ? "" : pRows[0]["status"].as<std::string>();
                proj["source_type"] = pRows[0]["source_type"].is_null() ? "" : pRows[0]["source_type"].as<std::string>();
                proj["source_path"] = pRows[0]["source_path"].is_null() ? "" : pRows[0]["source_path"].as<std::string>();
                payload["project"] = proj;
            }
        }

        if (!sessionId.empty()) {
            const auto sessions = txn.exec_params(
                "SELECT id, title, project_id FROM ai_sessions WHERE id = $1 AND user_id = $2",
                sessionId,
                userId);
            if (sessions.empty()) {
                sessionId.clear();
            }
        }
        if (sessionId.empty()) {
            const std::string title = streamChatTitle(userMessage);
            const auto rows = txn.exec_params(
                "INSERT INTO ai_sessions (user_id, project_id, title, session_type) "
                "VALUES ($1, NULLIF($2, '')::uuid, $3, 'agent_chat') RETURNING id",
                userId,
                projectId,
                title);
            sessionId = rows[0][0].as<std::string>();
        }

        txn.exec_params(
            "INSERT INTO ai_messages (session_id, role, content) VALUES ($1, 'user', $2)",
            sessionId,
            userMessage);

        const auto historyRows = txn.exec_params(
            "SELECT role, content FROM ("
            "SELECT role, content, created_at FROM ai_messages WHERE session_id = $1 "
            "ORDER BY created_at DESC LIMIT 24"
            ") recent ORDER BY created_at ASC",
            sessionId);
        Json::Value history(Json::arrayValue);
        for (const auto& row : historyRows) {
            Json::Value item(Json::objectValue);
            item["role"] = row["role"].as<std::string>();
            item["content"] = row["content"].as<std::string>();
            history.append(item);
        }
        payload["history"] = history;
        payload["session_id"] = sessionId;
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::warn("AI stream session persistence error: {}", e.what());
    }

    auto response = drogon::HttpResponse::newAsyncStreamResponse(
        [payload, userId, sessionId](drogon::ResponseStreamPtr stream) {
            auto writer = std::make_shared<SseWriter>();
            writer->stream = std::move(stream);

            BlockingTaskRunner::run([payload, userId, sessionId, writer]() {
                Json::Value requestPayload = payload;
                try {
                    auto conn = Database::getInstance().getConnection();
                    pqxx::work txn(*conn);
                    const auto rows = txn.exec_params(
                        "SELECT provider, openai_compatible_base_url, openai_compatible_api_key, nvidia_api_key "
                        "FROM ai_preferences WHERE user_id = $1",
                        userId);
                    if (!rows.empty()) {
                        Json::Value overrides(Json::objectValue);
                        std::string prefProvider = rows[0]["provider"].is_null() ? "" : rows[0]["provider"].c_str();
                        if (prefProvider == "openai_compatible") {
                            if (!rows[0]["openai_compatible_base_url"].is_null()) overrides["base_url"] = rows[0]["openai_compatible_base_url"].c_str();
                            if (!rows[0]["openai_compatible_api_key"].is_null()) overrides["api_key"] = rows[0]["openai_compatible_api_key"].c_str();
                        } else if (prefProvider == "nvidia_nim") {
                            if (!rows[0]["nvidia_api_key"].is_null()) overrides["api_key"] = rows[0]["nvidia_api_key"].c_str();
                        }
                        if (!overrides.empty()) requestPayload["provider_overrides"] = overrides;
                    }
                } catch (...) {}

                auto assembledContent = std::make_shared<std::string>();
                auto assembledReasoning = std::make_shared<std::string>();
                auto assembledToolCalls = std::make_shared<Json::Value>(Json::arrayValue);
                auto doneModel = std::make_shared<std::string>();
                auto doneUsage = std::make_shared<Json::Value>(Json::objectValue);

                // Emit initial start event with session_id so client can track active session immediately
                if (!sessionId.empty()) {
                    Json::Value startFrame(Json::objectValue);
                    startFrame["type"] = "start";
                    startFrame["session_id"] = sessionId;
                    if (requestPayload.isMember("model")) startFrame["model"] = requestPayload["model"];
                    if (requestPayload.isMember("provider")) startFrame["provider"] = requestPayload["provider"];
                    writer->send(sseFrame(startFrame));
                }

                AiStreamProxy::stream(
                    "/chat/agent/stream",
                    requestPayload,
                    [writer, assembledContent, assembledReasoning, assembledToolCalls, doneModel, doneUsage](const std::string& frame) {
                        writer->send(frame);
                        // Parse frame to record final response for persistence
                        try {
                            const std::string prefix = "data: ";
                            if (frame.rfind(prefix, 0) == 0) {
                                std::string jsonStr = frame.substr(prefix.size());
                                while (!jsonStr.empty() && (jsonStr.back() == '\n' || jsonStr.back() == '\r')) {
                                    jsonStr.pop_back();
                                }
                                Json::CharReaderBuilder reader;
                                Json::Value event;
                                std::string errs;
                                std::istringstream s(jsonStr);
                                if (Json::parseFromStream(reader, s, &event, &errs) && event.isObject()) {
                                    const std::string type = event.isMember("type") ? event["type"].asString() : "";
                                    if (type == "content" && event.isMember("delta")) {
                                        *assembledContent += event["delta"].asString();
                                    } else if (type == "reasoning" && event.isMember("delta")) {
                                        *assembledReasoning += event["delta"].asString();
                                    } else if (type == "tool_call") {
                                        Json::Value tc(Json::objectValue);
                                        tc["name"] = event.isMember("name") ? event["name"].asString() : "";
                                        tc["arguments"] = event.isMember("arguments") ? event["arguments"] : Json::Value(Json::objectValue);
                                        if (event.isMember("id")) tc["id"] = event["id"].asString();
                                        assembledToolCalls->append(tc);
                                    } else if (type == "tool_result") {
                                        const std::string tcName = event.isMember("name") ? event["name"].asString() : "";
                                        const std::string tcId = event.isMember("id") ? event["id"].asString() : "";
                                        for (int i = static_cast<int>(assembledToolCalls->size()) - 1; i >= 0; --i) {
                                            if ((!tcId.empty() && (*assembledToolCalls)[i].isMember("id") && (*assembledToolCalls)[i]["id"].asString() == tcId) ||
                                                ((*assembledToolCalls)[i]["name"].asString() == tcName && !(*assembledToolCalls)[i].isMember("result"))) {
                                                (*assembledToolCalls)[i]["result"] = event["result"];
                                                break;
                                            }
                                        }
                                    } else if (type == "done") {
                                        if (event.isMember("content") && !event["content"].asString().empty()) {
                                            *assembledContent = event["content"].asString();
                                        }
                                        if (event.isMember("reasoning") && !event["reasoning"].asString().empty()) {
                                            *assembledReasoning = event["reasoning"].asString();
                                        }
                                        if (event.isMember("model")) {
                                            *doneModel = event["model"].asString();
                                        }
                                        if (event.isMember("token_usage")) {
                                            *doneUsage = event["token_usage"];
                                        }
                                    }
                                }
                            }
                        } catch (...) {}
                    },
                    [writer, userId, sessionId, assembledContent, assembledReasoning, assembledToolCalls, doneModel, doneUsage](bool ok, const std::string& error) {
                        if (!ok) {
                            Json::Value failure(Json::objectValue);
                            failure["type"] = "error";
                            failure["error"] = error;
                            writer->send(sseFrame(failure));
                        } else if (!sessionId.empty() && (!assembledContent->empty() || !assembledReasoning->empty() || !assembledToolCalls->empty())) {
                            // Persist assistant message in database with full reasoning and tool calls
                            try {
                                auto conn = Database::getInstance().getConnection();
                                pqxx::work txn(*conn);
                                Json::Value meta(Json::objectValue);
                                if (!assembledReasoning->empty()) meta["reasoning"] = *assembledReasoning;
                                if (!assembledToolCalls->empty()) meta["tool_calls"] = *assembledToolCalls;
                                if (!doneModel->empty()) meta["model"] = *doneModel;
                                if (!doneUsage->empty()) meta["token_usage"] = *doneUsage;
                                std::string finalContent = assembledContent->empty()
                                    ? "Completed workspace actions and diagnostic inspection. See the tool activity above for details."
                                    : *assembledContent;
                                txn.exec_params(
                                    "INSERT INTO ai_messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3::jsonb)",
                                    sessionId,
                                    finalContent,
                                    strings::compactJson(meta));
                                txn.exec_params(
                                    "UPDATE ai_sessions SET updated_at = NOW(), last_model = $2 WHERE id = $1",
                                    sessionId,
                                    *doneModel);
                                txn.commit();
                            } catch (const std::exception& e) {
                                spdlog::error("Failed to save streamed assistant message: {}", e.what());
                            }
                        }
                        writer->finish();
                    });
            });
        });

    response->setContentTypeCodeAndCustomString(drogon::CT_CUSTOM, "text/event-stream");
    response->addHeader("Cache-Control", "no-cache");
    response->addHeader("Connection", "keep-alive");
    response->addHeader("X-Accel-Buffering", "no");
    callback(response);
}

}  // namespace stackpilot
