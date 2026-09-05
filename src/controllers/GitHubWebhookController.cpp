// ============================================================
// GitHubWebhookController.cpp
// ============================================================

#include "GitHubWebhookController.h"
#include "../utils/StringUtils.h"
#include "../services/PreviewEnvironments.h"
#include "../db/Database.h"
#include "../services/JobQueueService.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <json/json.h>
#include <mutex>
#include <openssl/crypto.h>
#include <openssl/hmac.h>
#include <pqxx/pqxx>
#include <sstream>
#include <spdlog/spdlog.h>
#include <unordered_map>
#include <vector>

namespace stackpilot {
namespace {

using strings::trim;


std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return value;
}

std::string hmacSha256Hex(const std::string& key, const std::string& body) {
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()),
         reinterpret_cast<const unsigned char*>(body.data()), body.size(),
         digest, &len);
    std::ostringstream out;
    for (unsigned int i = 0; i < len; ++i) {
        out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(digest[i]);
    }
    return out.str();
}

bool verifySignature(const drogon::HttpRequestPtr& req, const std::string& rawBody) {
    const char* secretEnv = std::getenv("GITHUB_WEBHOOK_SECRET");
    if (!secretEnv || !*secretEnv) {
        const char* allowUnsigned = std::getenv("STACKPILOT_ALLOW_UNSIGNED_GITHUB_WEBHOOKS");
        if (allowUnsigned && *allowUnsigned) {
            const std::string normalized = toLower(trim(allowUnsigned));
            if (normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on") {
                spdlog::warn("Accepting unsigned GitHub webhook because STACKPILOT_ALLOW_UNSIGNED_GITHUB_WEBHOOKS is enabled");
                return true;
            }
        }
        return false;
    }
    const std::string expected = "sha256=" + hmacSha256Hex(secretEnv, rawBody);
    const std::string provided = trim(req->getHeader("X-Hub-Signature-256"));
    if (provided.size() != expected.size()) {
        return false;
    }
    return CRYPTO_memcmp(provided.data(), expected.data(), expected.size()) == 0;
}

bool parseJson(const std::string& raw, Json::Value& payload) {
    Json::CharReaderBuilder builder;
    builder["collectComments"] = false;
    std::string errors;
    std::istringstream stream(raw);
    return Json::parseFromStream(builder, stream, &payload, &errors) && payload.isObject();
}

std::string branchFromRef(const std::string& ref) {
    const std::string prefix = "refs/heads/";
    if (ref.rfind(prefix, 0) == 0) {
        return ref.substr(prefix.size());
    }
    return ref;
}

std::string repoFullName(const Json::Value& payload) {
    if (payload.isMember("repository") && payload["repository"].isObject() &&
        payload["repository"].isMember("full_name")) {
        return payload["repository"]["full_name"].asString();
    }
    return "";
}

std::string githubFullNameFromUrl(std::string value) {
    value = trim(value);
    if (value.empty()) {
        return "";
    }
    if (value.rfind("git@github.com:", 0) == 0) {
        value = value.substr(std::string("git@github.com:").size());
    } else {
        const std::string marker = "github.com/";
        const auto pos = toLower(value).find(marker);
        if (pos != std::string::npos) {
            value = value.substr(pos + marker.size());
        }
    }
    while (!value.empty() && value.front() == '/') {
        value.erase(value.begin());
    }
    const auto queryPos = value.find_first_of("?#");
    if (queryPos != std::string::npos) {
        value = value.substr(0, queryPos);
    }
    if (value.size() > 4 && value.substr(value.size() - 4) == ".git") {
        value.resize(value.size() - 4);
    }
    while (!value.empty() && value.back() == '/') {
        value.pop_back();
    }
    const auto slash = value.find('/');
    if (slash == std::string::npos || slash == 0 || slash == value.size() - 1) {
        return "";
    }
    if (value.find('/', slash + 1) != std::string::npos) {
        value = value.substr(0, value.find('/', slash + 1));
    }
    for (char c : value) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '-' || c == '_' || c == '.' || c == '/';
        if (!ok) {
            return "";
        }
    }
    return toLower(value);
}

std::string commitFromCheckPayload(const Json::Value& payload) {
    if (payload.isMember("check_suite") && payload["check_suite"].isObject() &&
        payload["check_suite"].isMember("head_sha")) {
        return payload["check_suite"]["head_sha"].asString();
    }
    if (payload.isMember("check_run") && payload["check_run"].isObject() &&
        payload["check_run"].isMember("head_sha")) {
        return payload["check_run"]["head_sha"].asString();
    }
    return "";
}

std::string checkConclusion(const Json::Value& payload) {
    if (payload.isMember("check_suite") && payload["check_suite"].isObject()) {
        return payload["check_suite"].get("conclusion", "").asString();
    }
    if (payload.isMember("check_run") && payload["check_run"].isObject()) {
        return payload["check_run"].get("conclusion", "").asString();
    }
    return "";
}

Json::Value okPayload(const std::string& message) {
    Json::Value payload(Json::objectValue);
    payload["message"] = message;
    return payload;
}

std::string compactJson(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

std::string jsonIdToString(const Json::Value& value) {
    if (value.isString()) {
        return value.asString();
    }
    if (value.isUInt64()) {
        return std::to_string(value.asUInt64());
    }
    if (value.isInt64()) {
        return std::to_string(value.asInt64());
    }
    if (value.isUInt()) {
        return std::to_string(value.asUInt());
    }
    if (value.isInt()) {
        return std::to_string(value.asInt());
    }
    return "";
}

std::string installationIdFromPayload(const Json::Value& payload) {
    if (payload.isMember("installation") && payload["installation"].isObject() &&
        payload["installation"].isMember("id")) {
        return jsonIdToString(payload["installation"]["id"]);
    }
    return "";
}

Json::Value repositoryArrayFromInstallationPayload(const Json::Value& payload) {
    if (payload.isMember("repositories") && payload["repositories"].isArray()) {
        return payload["repositories"];
    }
    if (payload.isMember("repositories_added") && payload["repositories_added"].isArray()) {
        return payload["repositories_added"];
    }
    Json::Value repositories(Json::arrayValue);
    if (payload.isMember("repository") && payload["repository"].isObject()) {
        repositories.append(payload["repository"]);
    }
    return repositories;
}

void upsertGitHubAppInstallation(pqxx::transaction_base& txn,
                                 const Json::Value& payload,
                                 const std::string& installationId,
                                 bool suspended) {
    if (installationId.empty() ||
        !payload.isMember("installation") ||
        !payload["installation"].isObject()) {
        return;
    }

    const auto& installation = payload["installation"];
    const Json::Value account = installation.isMember("account") && installation["account"].isObject()
        ? installation["account"]
        : Json::Value(Json::objectValue);
    const Json::Value app = payload.isMember("app") && payload["app"].isObject()
        ? payload["app"]
        : Json::Value(Json::objectValue);

    const std::string accountLogin = account.get("login", "").asString();
    const std::string accountType = account.get("type", "").asString();
    const std::string accountId = account.isMember("id") ? jsonIdToString(account["id"]) : "";
    const std::string repositorySelection = installation.get("repository_selection", "").asString();
    const std::string appSlug = app.get("slug", "").asString();
    const std::string appId = app.isMember("id") ? jsonIdToString(app["id"]) : "";

    txn.exec_params(
        "INSERT INTO github_app_installations "
        "(installation_id, account_login, account_type, account_id, repository_selection, app_slug, app_id, raw_payload, suspended_at, updated_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CASE WHEN $9 THEN NOW() ELSE NULL END, NOW()) "
        "ON CONFLICT (installation_id) DO UPDATE SET "
        "account_login = EXCLUDED.account_login, "
        "account_type = EXCLUDED.account_type, "
        "account_id = EXCLUDED.account_id, "
        "repository_selection = EXCLUDED.repository_selection, "
        "app_slug = EXCLUDED.app_slug, "
        "app_id = EXCLUDED.app_id, "
        "raw_payload = EXCLUDED.raw_payload, "
        "suspended_at = CASE WHEN $9 THEN NOW() ELSE NULL END, "
        "updated_at = NOW()",
        installationId,
        accountLogin,
        accountType,
        accountId,
        repositorySelection,
        appSlug,
        appId,
        compactJson(payload),
        suspended
    );
}

void upsertGitHubAppRepository(pqxx::transaction_base& txn,
                               const std::string& installationId,
                               const Json::Value& repository,
                               bool selected) {
    if (installationId.empty() || !repository.isObject()) {
        return;
    }
    const std::string repositoryId = repository.isMember("id") ? jsonIdToString(repository["id"]) : "";
    const std::string fullName = repository.get("full_name", "").asString();
    if (repositoryId.empty() || fullName.empty()) {
        return;
    }
    const Json::Value owner = repository.isMember("owner") && repository["owner"].isObject()
        ? repository["owner"]
        : Json::Value(Json::objectValue);
    const std::string ownerLogin = owner.get("login", "").asString();
    const std::string repoName = repository.get("name", "").asString();

    txn.exec_params(
        "INSERT INTO github_app_repositories "
        "(installation_id, repository_id, full_name, owner_login, repo_name, private, selected, raw_payload, updated_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW()) "
        "ON CONFLICT (installation_id, repository_id) DO UPDATE SET "
        "full_name = EXCLUDED.full_name, "
        "owner_login = EXCLUDED.owner_login, "
        "repo_name = EXCLUDED.repo_name, "
        "private = EXCLUDED.private, "
        "selected = EXCLUDED.selected, "
        "raw_payload = EXCLUDED.raw_payload, "
        "updated_at = NOW()",
        installationId,
        repositoryId,
        fullName,
        ownerLogin,
        repoName,
        repository.get("private", false).asBool(),
        selected,
        compactJson(repository)
    );
}

Json::Value handleGitHubAppInstallationEvent(pqxx::transaction_base& txn,
                                             const Json::Value& payload,
                                             const std::string& event) {
    const std::string action = toLower(payload.get("action", "").asString());
    const std::string installationId = installationIdFromPayload(payload);
    Json::Value body(Json::objectValue);
    body["event"] = event;
    body["action"] = action;
    body["installation_id"] = installationId;

    if (installationId.empty()) {
        body["message"] = "GitHub App installation event ignored: missing installation id";
        return body;
    }

    if (event == "installation" && action == "deleted") {
        txn.exec_params("DELETE FROM github_app_installations WHERE installation_id = $1", installationId);
        body["message"] = "GitHub App installation removed";
        return body;
    }

    const bool suspended = event == "installation" && action == "suspend";
    upsertGitHubAppInstallation(txn, payload, installationId, suspended);

    Json::Value repositories(Json::arrayValue);
    if (event == "installation_repositories") {
        if (payload.isMember("repositories_removed") && payload["repositories_removed"].isArray()) {
            for (const auto& repo : payload["repositories_removed"]) {
                const std::string repositoryId = repo.isMember("id") ? jsonIdToString(repo["id"]) : "";
                if (!repositoryId.empty()) {
                    txn.exec_params(
                        "UPDATE github_app_repositories SET selected = FALSE, updated_at = NOW() "
                        "WHERE installation_id = $1 AND repository_id = $2",
                        installationId,
                        repositoryId
                    );
                }
            }
        }
    }

    const Json::Value incomingRepositories = repositoryArrayFromInstallationPayload(payload);
    for (const auto& repo : incomingRepositories) {
        upsertGitHubAppRepository(txn, installationId, repo, true);
        if (repo.isObject() && repo.isMember("full_name")) {
            repositories.append(repo["full_name"].asString());
        }
    }

    body["message"] = "GitHub App installation synced";
    body["repositories"] = repositories;
    return body;
}

Json::Value pushCiDetails(const Json::Value& payload,
                          const std::string& deliveryId,
                          const std::string& fullName,
                          const std::string& branch,
                          const std::string& commitSha) {
    Json::Value details(Json::objectValue);
    details["event"] = "push";
    details["github_delivery_id"] = deliveryId;
    details["repository"] = fullName;
    details["branch"] = branch;
    details["commit_sha"] = commitSha;
    details["compare_url"] = payload.get("compare", "").asString();
    if (payload.isMember("head_commit") && payload["head_commit"].isObject()) {
        details["head_commit"] = payload["head_commit"];
    }
    if (payload.isMember("pusher") && payload["pusher"].isObject()) {
        details["pusher"] = payload["pusher"];
    }
    if (payload.isMember("sender") && payload["sender"].isObject()) {
        details["sender"] = payload["sender"];
    }
    return details;
}

Json::Value checkCiDetails(const Json::Value& payload,
                           const std::string& event,
                           const std::string& deliveryId,
                           const std::string& conclusion) {
    Json::Value details(Json::objectValue);
    details["event"] = event;
    details["github_delivery_id"] = deliveryId;
    details["conclusion"] = conclusion;
    if (payload.isMember("check_suite") && payload["check_suite"].isObject()) {
        const auto& suite = payload["check_suite"];
        details["check_suite_id"] = suite.isMember("id") && suite["id"].isNumeric()
            ? std::to_string(suite["id"].asLargestUInt())
            : "";
        details["check_suite_status"] = suite.get("status", "").asString();
        details["check_suite_url"] = suite.get("html_url", "").asString();
        details["head_branch"] = suite.get("head_branch", "").asString();
    }
    if (payload.isMember("check_run") && payload["check_run"].isObject()) {
        const auto& run = payload["check_run"];
        details["check_run_id"] = run.isMember("id") && run["id"].isNumeric()
            ? std::to_string(run["id"].asLargestUInt())
            : "";
        details["check_run_name"] = run.get("name", "").asString();
        details["check_run_status"] = run.get("status", "").asString();
        details["check_run_url"] = run.get("html_url", "").asString();
    }
    return details;
}

void supersedeOlderEnvironmentCandidates(pqxx::transaction_base& txn,
                                         const std::string& environmentId,
                                         const std::string& commitSha) {
    const std::string reason =
        "Superseded by newer GitHub commit " + commitSha + ". The latest commit is now the deployment candidate.";
    auto staleRows = txn.exec_params(
        "UPDATE deployments "
        "SET status = 'superseded', "
        "ci_status = CASE WHEN ci_required = TRUE AND ci_status = 'pending' THEN 'superseded' ELSE ci_status END, "
        "logs = COALESCE(logs, '') || $3 || E'\\n', updated_at = NOW() "
        "WHERE environment_id = $1 AND commit_sha <> $2 "
        "AND status IN ('blocked', 'pending', 'queued') "
        "RETURNING id",
        environmentId,
        commitSha,
        reason
    );
    for (const auto& row : staleRows) {
        txn.exec_params(
            "UPDATE deployment_jobs "
            "SET status = 'canceled', last_error = $2, completed_at = NOW(), locked_by = '', locked_at = NULL, updated_at = NOW() "
            "WHERE deployment_id = $1 AND status IN ('queued', 'retrying')",
            row["id"].as<std::string>(),
            reason
        );
    }
}

class WebhookDeliveryTracker {
public:
    static WebhookDeliveryTracker& getInstance() {
        static WebhookDeliveryTracker instance;
        return instance;
    }

    bool has(const std::string& deliveryId) {
        if (deliveryId.empty()) return false;
        std::lock_guard<std::mutex> lock(mutex_);
        return seenDeliveries_.find(deliveryId) != seenDeliveries_.end();
    }

    void record(const std::string& deliveryId) {
        if (deliveryId.empty()) return;
        std::lock_guard<std::mutex> lock(mutex_);
        pruneLocked();
        seenDeliveries_.emplace(deliveryId, std::chrono::steady_clock::now());
    }

private:
    void pruneLocked() {
        const auto now = std::chrono::steady_clock::now();
        if (seenDeliveries_.size() < 10000 && now - lastPrune_ < std::chrono::minutes(10)) {
            return;
        }
        lastPrune_ = now;
        for (auto it = seenDeliveries_.begin(); it != seenDeliveries_.end(); ) {
            if (now - it->second > std::chrono::hours(24)) {
                it = seenDeliveries_.erase(it);
            } else {
                ++it;
            }
        }
        if (seenDeliveries_.size() > 50000) {
            std::vector<std::pair<std::chrono::steady_clock::time_point, std::string>> entries;
            entries.reserve(seenDeliveries_.size());
            for (const auto& [k, v] : seenDeliveries_) {
                entries.emplace_back(v, k);
            }
            std::sort(entries.begin(), entries.end());
            const size_t toRemove = seenDeliveries_.size() - 40000;
            for (size_t i = 0; i < toRemove; ++i) {
                seenDeliveries_.erase(entries[i].second);
            }
        }
    }

    std::mutex mutex_;
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> seenDeliveries_;
    std::chrono::steady_clock::time_point lastPrune_ = std::chrono::steady_clock::now();
};

struct PendingEnqueue {
    std::string deploymentId;
    std::string userId;
    std::string message;
};

} // namespace

void GitHubWebhookController::handleWebhook(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string rawBody(req->getBody());
    if (!verifySignature(req, rawBody)) {
        Json::Value err; err["error"] = "Invalid GitHub webhook signature";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k401Unauthorized);
        callback(resp); return;
    }

    Json::Value payload;
    if (!parseJson(rawBody, payload)) {
        Json::Value err; err["error"] = "Invalid GitHub webhook payload";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k400BadRequest);
        callback(resp); return;
    }

    const std::string event = toLower(req->getHeader("X-GitHub-Event"));
    const std::string deliveryId = req->getHeader("X-GitHub-Delivery");

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        std::vector<PendingEnqueue> pendingEnqueues;

        if (event == "ping") {
            const std::string installationId = installationIdFromPayload(payload);
            if (!installationId.empty()) {
                upsertGitHubAppInstallation(txn, payload, installationId, false);
                for (const auto& repo : repositoryArrayFromInstallationPayload(payload)) {
                    upsertGitHubAppRepository(txn, installationId, repo, true);
                }
            }
            txn.commit();
            callback(drogon::HttpResponse::newHttpJsonResponse(okPayload("GitHub webhook ping received")));
            return;
        }

        if (event == "installation" || event == "installation_repositories") {
            if (!deliveryId.empty() && WebhookDeliveryTracker::getInstance().has(deliveryId)) {
                spdlog::info("GitHub installation event already processed for delivery {}", deliveryId);
                txn.commit();
                callback(drogon::HttpResponse::newHttpJsonResponse(
                    okPayload("GitHub App installation delivery already processed")
                ));
                return;
            }
            Json::Value body = handleGitHubAppInstallationEvent(txn, payload, event);
            txn.commit();
            if (!deliveryId.empty()) {
                WebhookDeliveryTracker::getInstance().record(deliveryId);
            }
            callback(drogon::HttpResponse::newHttpJsonResponse(body));
            return;
        }

        if (event == "pull_request") {
            if (!deliveryId.empty()) {
                if (WebhookDeliveryTracker::getInstance().has(deliveryId)) {
                    spdlog::info("GitHub pull request delivery {} already processed (in-memory)", deliveryId);
                    txn.commit();
                    callback(drogon::HttpResponse::newHttpJsonResponse(
                        okPayload("Pull request delivery already processed")
                    ));
                    return;
                }

                auto existingDeliveries = txn.exec_params(
                    "SELECT id, project_id FROM deployments WHERE github_delivery_id = $1",
                    deliveryId
                );
                if (!existingDeliveries.empty()) {
                    spdlog::info("GitHub pull request delivery {} already processed (database)", deliveryId);
                    WebhookDeliveryTracker::getInstance().record(deliveryId);
                    txn.commit();
                    Json::Value body = okPayload("Pull request delivery already processed");
                    Json::Value previews(Json::arrayValue);
                    for (const auto& row : existingDeliveries) {
                        Json::Value item(Json::objectValue);
                        item["deployment_id"] = row["id"].as<std::string>();
                        item["project_id"] = row["project_id"].as<std::string>();
                        item["action"] = "idempotent_skip";
                        previews.append(item);
                    }
                    body["previews"] = previews;
                    callback(drogon::HttpResponse::newHttpJsonResponse(body));
                    return;
                }
            }

            const std::string fullName = repoFullName(payload);
            const PreviewRequest preview = PreviewEnvironments::parseWebhook(payload);
            if (fullName.empty() || preview.prNumber <= 0) {
                txn.commit();
                callback(drogon::HttpResponse::newHttpJsonResponse(
                    okPayload("Pull request event ignored: missing repository or PR number")));
                return;
            }

            auto rows = txn.exec_params(
                "SELECT p.id AS project_id, p.user_id, p.name AS project_name, p.repo_url, "
                "p.preview_environments_enabled, p.preview_ttl_hours "
                "FROM projects p WHERE p.preview_environments_enabled = TRUE"
            );

            Json::Value handled(Json::arrayValue);
            const std::string normalizedFullName = toLower(fullName);
            for (const auto& row : rows) {
                if (githubFullNameFromUrl(row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>())
                        != normalizedFullName) {
                    continue;
                }

                const PreviewDecision decision = PreviewEnvironments::decide(preview, true);
                const std::string projectId = row["project_id"].as<std::string>();

                Json::Value entry(Json::objectValue);
                entry["project_id"] = projectId;
                entry["pr_number"] = preview.prNumber;
                entry["action"] = decision.action;
                entry["reason"] = decision.reason;

                if (decision.shouldTeardown()) {
                    // Mark rather than delete. The cleanup service owns actually
                    // destroying runtimes, and a webhook handler that shells out
                    // to Docker would block the event loop on GitHub's timeout.
                    txn.exec_params(
                        "UPDATE deployments SET status = 'pending_teardown', updated_at = NOW() "
                        "WHERE project_id = $1 AND pr_number = $2 AND is_preview "
                        "AND status NOT IN ('destroyed', 'failed', 'superseded')",
                        projectId, preview.prNumber
                    );
                } else if (decision.shouldDeploy()) {
                    if (!deliveryId.empty()) {
                        auto existingPR = txn.exec_params(
                            "SELECT id FROM deployments WHERE github_delivery_id = $1 AND project_id = $2",
                            deliveryId, projectId
                        );
                        if (!existingPR.empty()) {
                            spdlog::info("Skipping duplicate pull request delivery {} for project {}", deliveryId, projectId);
                            entry["deployment_id"] = existingPR[0]["id"].as<std::string>();
                            entry["action"] = "idempotent_skip";
                            entry["reason"] = "Delivery already processed";
                            handled.append(entry);
                            continue;
                        }
                    }

                    // Supersede the previous preview for this PR before inserting
                    // the new one; the partial unique index allows exactly one
                    // live preview per (project, PR).
                    txn.exec_params(
                        "UPDATE deployments SET status = 'superseded', updated_at = NOW() "
                        "WHERE project_id = $1 AND pr_number = $2 AND is_preview "
                        "AND status NOT IN ('destroyed', 'failed', 'superseded')",
                        projectId, preview.prNumber
                    );

                    const int ttlHours = PreviewEnvironments::clampTtlHours(
                        row["preview_ttl_hours"].is_null() ? 72 : row["preview_ttl_hours"].as<int>());

                    auto inserted = txn.exec_params(
                        "INSERT INTO deployments "
                        "(project_id, status, version, commit_hash, branch, commit_sha, trigger_source, "
                        " github_delivery_id, is_preview, pr_number, pr_title, pr_author, preview_expires_at, logs) "
                        "VALUES ($1, 'pending', $2, $3, $4, $3, 'github_pull_request', $5, TRUE, $6, $7, $8, "
                        "        NOW() + ($9 || ' hours')::interval, $10) "
                        "RETURNING id",
                        projectId,
                        PreviewEnvironments::versionFor(preview.prNumber),
                        preview.commitSha,
                        preview.branch,
                        deliveryId,
                        preview.prNumber,
                        preview.title,
                        preview.author,
                        std::to_string(ttlHours),
                        "Preview environment queued for pull request #" +
                            std::to_string(preview.prNumber) + " (" + decision.reason + ").\n"
                    );
                    if (!inserted.empty()) {
                        const std::string previewDeploymentId = inserted[0][0].as<std::string>();
                        entry["deployment_id"] = previewDeploymentId;
                        // Insert without enqueue leaves the preview sitting at
                        // 'pending' forever -- a row that says the right thing
                        // while nothing builds. Enqueued after commit, below,
                        // so the worker cannot pick it up before it exists.
                        pendingEnqueues.push_back(PendingEnqueue{
                            previewDeploymentId,
                            row["user_id"].as<std::string>(),
                            "Preview environment queued for pull request #" +
                                std::to_string(preview.prNumber) + "."
                        });
                    }
                }

                handled.append(entry);
            }

            txn.commit();
            if (!deliveryId.empty()) {
                WebhookDeliveryTracker::getInstance().record(deliveryId);
            }
            for (const auto& enqueue : pendingEnqueues) {
                JobQueueService::getInstance().enqueueDeploymentBuild(
                    enqueue.deploymentId, enqueue.userId, enqueue.message);
            }

            Json::Value body = okPayload("Pull request event processed");
            body["previews"] = handled;
            callback(drogon::HttpResponse::newHttpJsonResponse(body));
            return;
        }

        if (event == "push") {
            const std::string fullName = repoFullName(payload);
            const std::string branch = branchFromRef(payload.get("ref", "").asString());
            const std::string commitSha =
                payload.isMember("after") ? payload["after"].asString() :
                (payload.isMember("head_commit") && payload["head_commit"].isObject() ? payload["head_commit"].get("id", "").asString() : "");
            if (fullName.empty() || branch.empty() || commitSha.empty()) {
                txn.commit();
                callback(drogon::HttpResponse::newHttpJsonResponse(okPayload("Push ignored: missing repository, branch, or commit")));
                return;
            }

            auto rows = txn.exec_params(
                "SELECT p.id AS project_id, p.user_id, p.name AS project_name, p.repo_url, e.id AS environment_id, e.name AS environment_name, "
                "e.require_ci, e.auto_deploy "
                "FROM projects p "
                "JOIN project_environments e ON e.project_id = p.id "
                "WHERE e.branch = $1 AND e.auto_deploy = TRUE",
                branch
            );

            Json::Value created(Json::arrayValue);
            const std::string normalizedFullName = toLower(fullName);
            for (const auto& row : rows) {
                if (githubFullNameFromUrl(row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>()) != normalizedFullName) {
                    continue;
                }
                const bool requireCi = row["require_ci"].as<bool>();
                const std::string status = requireCi ? "blocked" : "pending";
                const std::string ciStatus = requireCi ? "pending" : "not_required";
                const std::string logs = requireCi
                    ? "GitHub push received. Waiting for required GitHub checks before deployment.\n"
                    : "GitHub push received. Deployment queued by branch automation.\n";
                const std::string dedupeKey = deliveryId.empty()
                    ? (row["environment_id"].as<std::string>() + "-" + commitSha)
                    : deliveryId;
                auto existingRows = txn.exec_params(
                    "SELECT id FROM deployments "
                    "WHERE github_delivery_id = $1 AND environment_id = $2 AND commit_sha = $3",
                    dedupeKey,
                    row["environment_id"].as<std::string>(),
                    commitSha
                );
                if (!existingRows.empty()) {
                    continue;
                }

                supersedeOlderEnvironmentCandidates(
                    txn,
                    row["environment_id"].as<std::string>(),
                    commitSha
                );
                const Json::Value ciDetails = pushCiDetails(payload, dedupeKey, fullName, branch, commitSha);
                auto depRows = txn.exec_params(
                    "INSERT INTO deployments "
                    "(project_id, environment_id, version, commit_hash, branch, commit_sha, trigger_source, github_delivery_id, ci_required, ci_status, ci_details, status, logs) "
                    "VALUES ($1, $2, $3, $4, $5, $6, 'github_push', $7, $8, $9, $10::jsonb, $11, $12) "
                    "RETURNING id",
                    row["project_id"].as<std::string>(),
                    row["environment_id"].as<std::string>(),
                    "git-" + commitSha.substr(0, std::min<size_t>(12, commitSha.size())),
                    commitSha,
                    branch,
                    commitSha,
                    dedupeKey,
                    requireCi,
                    ciStatus,
                    compactJson(ciDetails),
                    status,
                    logs
                );
                if (depRows.empty()) {
                    continue;
                }
                const std::string deploymentId = depRows[0]["id"].as<std::string>();
                Json::Value item(Json::objectValue);
                item["deployment_id"] = deploymentId;
                item["project_id"] = row["project_id"].as<std::string>();
                item["environment_id"] = row["environment_id"].as<std::string>();
                item["ci_required"] = requireCi;
                item["commit_sha"] = commitSha;
                item["branch"] = branch;
                created.append(item);
                pendingEnqueues.push_back(PendingEnqueue{
                    deploymentId,
                    row["user_id"].as<std::string>(),
                    requireCi
                        ? "GitHub push received. Watching for required GitHub checks before deployment."
                        : "GitHub push received. Deployment queued by branch automation."
                });
            }
            txn.commit();
            for (const auto& enqueue : pendingEnqueues) {
                JobQueueService::getInstance().enqueueDeploymentBuild(
                    enqueue.deploymentId,
                    enqueue.userId,
                    enqueue.message
                );
            }

            Json::Value body(Json::objectValue);
            body["message"] = "Push processed";
            body["created"] = created;
            callback(drogon::HttpResponse::newHttpJsonResponse(body));
            return;
        }

        if (event == "check_suite" || event == "check_run") {
            const std::string fullName = repoFullName(payload);
            const std::string commitSha = commitFromCheckPayload(payload);
            const std::string conclusion = toLower(checkConclusion(payload));
            if (event == "check_run" && conclusion == "success") {
                txn.commit();
                callback(drogon::HttpResponse::newHttpJsonResponse(
                    okPayload("Successful check_run ignored; waiting for the aggregate check_suite result")
                ));
                return;
            }
            if (fullName.empty() || commitSha.empty() || conclusion.empty()) {
                txn.commit();
                callback(drogon::HttpResponse::newHttpJsonResponse(okPayload("Check event ignored")));
                return;
            }

            auto rows = txn.exec_params(
                "SELECT d.id, p.user_id, p.repo_url "
                "FROM deployments d "
                "JOIN projects p ON d.project_id = p.id "
                "WHERE d.commit_sha = $1 AND d.ci_required = TRUE AND d.ci_status = 'pending'",
                commitSha
            );
            Json::Value updated(Json::arrayValue);
            const std::string normalizedFullName = toLower(fullName);
            for (const auto& row : rows) {
                if (githubFullNameFromUrl(row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>()) != normalizedFullName) {
                    continue;
                }
                const std::string deploymentId = row["id"].as<std::string>();
                const Json::Value details = checkCiDetails(payload, event, deliveryId, conclusion);
                if (conclusion == "success") {
                    txn.exec_params(
                        "UPDATE deployments "
                        "SET ci_status = 'passed', status = 'pending', ci_details = ci_details || $2::jsonb, "
                        "logs = COALESCE(logs, '') || E'GitHub checks passed. Deployment queued.\\n', updated_at = NOW() "
                        "WHERE id = $1",
                        deploymentId,
                        compactJson(details)
                    );
                    updated.append(deploymentId);
                    auto existingJobs = txn.exec_params(
                        "UPDATE deployment_jobs "
                        "SET status = 'queued', last_error = '', locked_by = '', locked_at = NULL, next_run_at = NOW(), updated_at = NOW() "
                        "WHERE deployment_id = $1 AND status IN ('queued', 'retrying') "
                        "RETURNING id",
                        deploymentId
                    );
                    if (existingJobs.empty()) {
                        pendingEnqueues.push_back(PendingEnqueue{
                            deploymentId,
                            row["user_id"].as<std::string>(),
                            "GitHub checks passed. Deployment queued."
                        });
                    }
                } else if (conclusion == "failure" || conclusion == "cancelled" || conclusion == "timed_out") {
                    txn.exec_params(
                        "UPDATE deployments "
                        "SET ci_status = 'failed', status = 'failed_ci', ci_details = ci_details || $3::jsonb, "
                        "logs = COALESCE(logs, '') || $2 || E'\\n', updated_at = NOW() "
                        "WHERE id = $1",
                        deploymentId,
                        "GitHub checks failed: " + conclusion,
                        compactJson(details)
                    );
                    updated.append(deploymentId);
                }
            }
            txn.commit();
            for (const auto& enqueue : pendingEnqueues) {
                JobQueueService::getInstance().enqueueDeploymentBuild(
                    enqueue.deploymentId,
                    enqueue.userId,
                    enqueue.message
                );
            }

            Json::Value body(Json::objectValue);
            body["message"] = "Check event processed";
            body["updated_deployments"] = updated;
            callback(drogon::HttpResponse::newHttpJsonResponse(body));
            return;
        }

        txn.commit();
        callback(drogon::HttpResponse::newHttpJsonResponse(okPayload("Webhook event ignored")));
    } catch (const std::exception& e) {
        spdlog::error("GitHub webhook error: {}", e.what());
        Json::Value err; err["error"] = "Webhook processing failed";
        auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
        resp->setStatusCode(drogon::k500InternalServerError);
        callback(resp);
    }
}

} // namespace stackpilot
