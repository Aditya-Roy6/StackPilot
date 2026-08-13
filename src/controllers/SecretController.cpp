// ============================================================
// SecretController.cpp
// ============================================================

#include "SecretController.h"
#include "../db/Database.h"
#include "../utils/AuditLogger.h"
#include "../utils/JwtHelper.h"
#include "../utils/StringUtils.h"
#include "../utils/TokenCrypto.h"

#include <algorithm>
#include <cctype>
#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

namespace stackpilot {
namespace {

// Shared implementation; see utils/StringUtils.h
using strings::trim;


void sendJson(std::function<void(const drogon::HttpResponsePtr&)>& callback,
              const Json::Value& payload,
              drogon::HttpStatusCode status = drogon::k200OK) {
    auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
    resp->setStatusCode(status);
    callback(resp);
}

void sendError(std::function<void(const drogon::HttpResponsePtr&)>& callback,
               drogon::HttpStatusCode status,
               const std::string& message) {
    Json::Value payload;
    payload["error"] = message;
    sendJson(callback, payload, status);
}

// Environment-variable naming: letters, digits, underscore; not leading a digit.
bool isValidSecretKey(const std::string& key) {
    if (key.empty() || key.size() > 255) return false;
    if (std::isdigit(static_cast<unsigned char>(key[0]))) return false;
    for (const char c : key) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) || c == '_';
        if (!ok) return false;
    }
    return true;
}

// Metadata only — never the plaintext. Reveal is a separate audited call.
Json::Value secretRowToJson(const pqxx::row& row) {
    Json::Value secret(Json::objectValue);
    secret["id"] = row["id"].as<std::string>();
    secret["project_id"] = row["project_id"].as<std::string>();
    secret["key"] = row["key"].as<std::string>();
    secret["description"] = row["description"].is_null() ? "" : row["description"].as<std::string>();
    secret["environment_id"] = row["environment_id"].is_null() ? "" : row["environment_id"].as<std::string>();
    secret["version"] = row["version"].is_null() ? 1 : row["version"].as<int>();
    secret["last_accessed_at"] = row["last_accessed_at"].is_null() ? "" : row["last_accessed_at"].as<std::string>();
    secret["updated_at"] = row["updated_at"].is_null() ? "" : row["updated_at"].as<std::string>();
    if (!row["environment_name"].is_null()) {
        secret["environment_name"] = row["environment_name"].as<std::string>();
    } else {
        secret["environment_name"] = "All environments";
    }
    if (!row["project_name"].is_null()) {
        secret["project_name"] = row["project_name"].as<std::string>();
    }
    return secret;
}

} // namespace

std::string SecretController::extractUserId(const drogon::HttpRequestPtr& req) {
    auto payload = JwtHelper::verifyRequestToken(req);
    return payload.isNull() ? "" : payload["user_id"].asString();
}

bool SecretController::userOwnsProject(const std::string& projectId, const std::string& userId) {
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT 1 FROM projects WHERE id = $1 AND user_id = $2",
            projectId,
            userId
        );
        txn.commit();
        return !rows.empty();
    } catch (const std::exception& e) {
        // A non-UUID project id also lands here — deny by default.
        spdlog::warn("Secret ownership check failed: {}", e.what());
        return false;
    }
}

void SecretController::listAllSecrets(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT s.id, s.project_id, s.key, s.description, s.environment_id, s.version, "
            "s.last_accessed_at, s.updated_at, e.name AS environment_name, p.name AS project_name "
            "FROM project_secrets s "
            "JOIN projects p ON s.project_id = p.id "
            "LEFT JOIN project_environments e ON s.environment_id = e.id "
            "WHERE p.user_id = $1 "
            "ORDER BY p.name ASC, s.key ASC",
            userId
        );
        txn.commit();

        Json::Value secrets(Json::arrayValue);
        for (const auto& row : rows) {
            secrets.append(secretRowToJson(row));
        }
        Json::Value payload;
        payload["secrets"] = secrets;
        payload["count"] = static_cast<int>(secrets.size());
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("List secrets error: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to list secrets");
    }
}

void SecretController::listSecrets(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    if (!userOwnsProject(projectId, userId)) {
        sendError(callback, drogon::k404NotFound, "Project not found");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT s.id, s.project_id, s.key, s.description, s.environment_id, s.version, "
            "s.last_accessed_at, s.updated_at, e.name AS environment_name, p.name AS project_name "
            "FROM project_secrets s "
            "JOIN projects p ON s.project_id = p.id "
            "LEFT JOIN project_environments e ON s.environment_id = e.id "
            "WHERE s.project_id = $1 "
            "ORDER BY s.key ASC",
            projectId
        );
        txn.commit();

        Json::Value secrets(Json::arrayValue);
        for (const auto& row : rows) {
            secrets.append(secretRowToJson(row));
        }
        Json::Value payload;
        payload["secrets"] = secrets;
        payload["count"] = static_cast<int>(secrets.size());
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("List project secrets error: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to list secrets");
    }
}

void SecretController::upsertSecret(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    if (!userOwnsProject(projectId, userId)) {
        sendError(callback, drogon::k404NotFound, "Project not found");
        return;
    }

    const auto body = req->getJsonObject();
    if (!body) {
        sendError(callback, drogon::k400BadRequest, "Invalid JSON body");
        return;
    }

    const std::string key = trim((*body)["key"].isString() ? (*body)["key"].asString() : "");
    const std::string value = (*body)["value"].isString() ? (*body)["value"].asString() : "";
    const std::string description = trim((*body)["description"].isString() ? (*body)["description"].asString() : "");
    const std::string environmentId = trim((*body)["environment_id"].isString() ? (*body)["environment_id"].asString() : "");

    if (!isValidSecretKey(key)) {
        sendError(callback, drogon::k400BadRequest,
                  "Key must be letters, digits or underscore, and cannot start with a digit");
        return;
    }
    if (value.empty()) {
        sendError(callback, drogon::k400BadRequest, "Value is required");
        return;
    }
    if (value.size() > 65536) {
        sendError(callback, drogon::k400BadRequest, "Value exceeds the 64KB limit");
        return;
    }

    try {
        const std::string encrypted = TokenCrypto::encrypt(value);

        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        // An environment-scoped secret must belong to this project, otherwise a
        // user could attach a secret to another project's environment.
        if (!environmentId.empty()) {
            auto envRows = txn.exec_params(
                "SELECT 1 FROM project_environments WHERE id = $1 AND project_id = $2",
                environmentId,
                projectId
            );
            if (envRows.empty()) {
                txn.commit();
                sendError(callback, drogon::k400BadRequest, "Environment does not belong to this project");
                return;
            }
        }

        pqxx::result rows;
        if (environmentId.empty()) {
            rows = txn.exec_params(
                "INSERT INTO project_secrets (project_id, environment_id, key, value_encrypted, description, created_by) "
                "VALUES ($1, NULL, $2, $3, $4, $5) "
                "ON CONFLICT (project_id, environment_id, key) DO UPDATE "
                "SET value_encrypted = EXCLUDED.value_encrypted, "
                "    description = EXCLUDED.description, "
                "    version = project_secrets.version + 1, "
                "    updated_at = NOW() "
                "RETURNING id, version",
                projectId, key, encrypted, description, userId
            );
        } else {
            rows = txn.exec_params(
                "INSERT INTO project_secrets (project_id, environment_id, key, value_encrypted, description, created_by) "
                "VALUES ($1, $2, $3, $4, $5, $6) "
                "ON CONFLICT (project_id, environment_id, key) DO UPDATE "
                "SET value_encrypted = EXCLUDED.value_encrypted, "
                "    description = EXCLUDED.description, "
                "    version = project_secrets.version + 1, "
                "    updated_at = NOW() "
                "RETURNING id, version",
                projectId, environmentId, key, encrypted, description, userId
            );
        }
        txn.commit();

        Json::Value payload;
        payload["id"] = rows.empty() ? "" : rows[0]["id"].as<std::string>();
        payload["key"] = key;
        payload["version"] = rows.empty() ? 1 : rows[0]["version"].as<int>();
        payload["status"] = "saved";

        Json::Value auditMeta(Json::objectValue);
        auditMeta["key"] = key;
        auditMeta["environment_id"] = environmentId;
        AuditLogger::recordFromRequest(req, userId, "secret.upserted", "project", projectId, auditMeta);

        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("Upsert secret error: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to save secret");
    }
}

void SecretController::deleteSecret(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId,
    const std::string& secretId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    if (!userOwnsProject(projectId, userId)) {
        sendError(callback, drogon::k404NotFound, "Project not found");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "DELETE FROM project_secrets WHERE id = $1 AND project_id = $2 RETURNING key",
            secretId,
            projectId
        );
        txn.commit();

        if (rows.empty()) {
            sendError(callback, drogon::k404NotFound, "Secret not found");
            return;
        }

        Json::Value auditMeta(Json::objectValue);
        auditMeta["key"] = rows[0]["key"].as<std::string>();
        AuditLogger::recordFromRequest(req, userId, "secret.deleted", "project", projectId, auditMeta);

        Json::Value payload;
        payload["status"] = "deleted";
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("Delete secret error: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to delete secret");
    }
}

void SecretController::revealSecret(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& projectId,
    const std::string& secretId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        sendError(callback, drogon::k401Unauthorized, "Unauthorized");
        return;
    }
    if (!userOwnsProject(projectId, userId)) {
        sendError(callback, drogon::k404NotFound, "Project not found");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        auto rows = txn.exec_params(
            "SELECT key, value_encrypted FROM project_secrets WHERE id = $1 AND project_id = $2",
            secretId,
            projectId
        );
        if (rows.empty()) {
            txn.commit();
            sendError(callback, drogon::k404NotFound, "Secret not found");
            return;
        }

        // Reading a secret is itself an event worth recording.
        txn.exec_params(
            "UPDATE project_secrets SET last_accessed_at = NOW(), last_accessed_by = 'ui' WHERE id = $1",
            secretId
        );
        txn.commit();

        const std::string key = rows[0]["key"].as<std::string>();
        Json::Value payload;
        payload["key"] = key;
        payload["value"] = TokenCrypto::decrypt(rows[0]["value_encrypted"].as<std::string>());

        Json::Value auditMeta(Json::objectValue);
        auditMeta["key"] = key;
        AuditLogger::recordFromRequest(req, userId, "secret.revealed", "project", projectId, auditMeta);

        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("Reveal secret error: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to reveal secret");
    }
}

} // namespace stackpilot
