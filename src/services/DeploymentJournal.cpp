// ============================================================
// DeploymentJournal.cpp
// ============================================================

#include "DeploymentJournal.h"

#include "../controllers/LogWebSocketController.h"
#include "../db/Database.h"
#include "../utils/StringUtils.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>
#include <spdlog/spdlog.h>

namespace stackpilot {
namespace {

using strings::parseJsonObject;
using strings::trim;

std::string jsonString(const Json::Value& value, const std::string& key, const std::string& fallback = "") {
    return value.isObject() && value.isMember(key) && value[key].isString() ? value[key].asString() : fallback;
}

struct DeploymentLogBuffer {
    std::string accumulatedText;
    size_t lineCount = 0;
    std::chrono::steady_clock::time_point firstLineTime;
};

std::mutex s_bufferMutex;
std::map<std::string, DeploymentLogBuffer> s_pendingLogs;
std::atomic<bool> s_flusherRunning{false};
std::thread s_flusherThread;
std::condition_variable s_flusherCv;

void writeLogsToDb(const std::string& deploymentId, const std::string& batched) {
    if (deploymentId.empty() || batched.empty()) {
        return;
    }
    try {
        auto& db = Database::getInstance();
        if (!db.isConnected()) {
            return;
        }
        auto conn = db.getConnection();
        pqxx::work txn(*conn);
        txn.exec_params(
            "UPDATE deployments "
            "SET logs = COALESCE(logs, '') || $1, updated_at = NOW() "
            "WHERE id = $2",
            batched,
            deploymentId
        );
        txn.commit();
    } catch (const std::exception& e) {
        spdlog::error("Failed to append build log block for {}: {}", deploymentId, e.what());
    }
}

void ensureFlusherStarted() {
    static std::once_flag once;
    std::call_once(once, []() {
        s_flusherRunning = true;
        s_flusherThread = std::thread([]() {
            while (s_flusherRunning.load()) {
                std::unique_lock<std::mutex> lock(s_bufferMutex);
                s_flusherCv.wait_for(lock, std::chrono::milliseconds(250), [] {
                    return !s_flusherRunning.load();
                });
                if (!s_flusherRunning.load()) {
                    break;
                }

                const auto now = std::chrono::steady_clock::now();
                std::vector<std::pair<std::string, std::string>> toFlush;
                for (auto it = s_pendingLogs.begin(); it != s_pendingLogs.end(); ) {
                    if (now - it->second.firstLineTime >= std::chrono::milliseconds(500)) {
                        if (!it->second.accumulatedText.empty()) {
                            toFlush.emplace_back(it->first, std::move(it->second.accumulatedText));
                        }
                        it = s_pendingLogs.erase(it);
                    } else {
                        ++it;
                    }
                }
                lock.unlock();

                for (const auto& [depId, text] : toFlush) {
                    writeLogsToDb(depId, text);
                }
            }
        });
        s_flusherThread.detach();
    });
}

}  // namespace

void DeploymentJournal::appendLine(const std::string& deploymentId, const std::string& line) {
    if (deploymentId.empty() || line.empty()) {
        return;
    }

    appendBlock(deploymentId, line);
}

void DeploymentJournal::appendBlock(const std::string& deploymentId, const std::string& block) {
    if (block.empty() || deploymentId.empty()) {
        return;
    }

    std::istringstream stream(block);
    std::string line;
    std::string batched;
    size_t linesAdded = 0;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (!line.empty()) {
            batched += line;
            batched += '\n';
            ++linesAdded;
        }
    }

    if (batched.empty()) {
        return;
    }

    ensureFlusherStarted();

    std::string textToFlushImmediately;
    {
        std::lock_guard<std::mutex> lock(s_bufferMutex);
        auto& entry = s_pendingLogs[deploymentId];
        if (entry.lineCount == 0) {
            entry.firstLineTime = std::chrono::steady_clock::now();
        }
        entry.accumulatedText += batched;
        entry.lineCount += linesAdded;

        const auto now = std::chrono::steady_clock::now();
        if (entry.lineCount >= 50 || (now - entry.firstLineTime >= std::chrono::milliseconds(500))) {
            textToFlushImmediately = std::move(entry.accumulatedText);
            s_pendingLogs.erase(deploymentId);
        }
    }

    if (!textToFlushImmediately.empty()) {
        writeLogsToDb(deploymentId, textToFlushImmediately);
    }
}

void DeploymentJournal::flush(const std::string& deploymentId) {
    std::vector<std::pair<std::string, std::string>> toFlush;
    {
        std::lock_guard<std::mutex> lock(s_bufferMutex);
        if (deploymentId.empty()) {
            for (auto& [id, entry] : s_pendingLogs) {
                if (!entry.accumulatedText.empty()) {
                    toFlush.emplace_back(id, std::move(entry.accumulatedText));
                }
            }
            s_pendingLogs.clear();
        } else {
            auto it = s_pendingLogs.find(deploymentId);
            if (it != s_pendingLogs.end()) {
                if (!it->second.accumulatedText.empty()) {
                    toFlush.emplace_back(it->first, std::move(it->second.accumulatedText));
                }
                s_pendingLogs.erase(it);
            }
        }
    }

    for (const auto& [id, text] : toFlush) {
        writeLogsToDb(id, text);
    }
}

Json::Value DeploymentJournal::extractPortAdjustments(const std::string& logs) {
    Json::Value adjustments(Json::arrayValue);
    const std::string marker = "__STACKPILOT_PORT_ADJUSTED__=";
    std::size_t offset = 0;
    while ((offset = logs.find(marker, offset)) != std::string::npos) {
        const std::size_t payloadStart = offset + marker.size();
        const std::size_t lineEnd = logs.find('\n', payloadStart);
        const std::string payload = trim(logs.substr(payloadStart, lineEnd == std::string::npos ? std::string::npos : lineEnd - payloadStart));
        const std::size_t firstColon = payload.find(':');
        const std::size_t secondColon = firstColon == std::string::npos ? std::string::npos : payload.find(':', firstColon + 1);
        if (firstColon != std::string::npos && secondColon != std::string::npos) {
            Json::Value item;
            item["key"] = payload.substr(0, firstColon);
            item["from"] = payload.substr(firstColon + 1, secondColon - firstColon - 1);
            item["to"] = payload.substr(secondColon + 1);
            adjustments.append(item);
        }
        offset = lineEnd == std::string::npos ? logs.size() : lineEnd + 1;
    }
    return adjustments;
}

void DeploymentJournal::hydrateRuntimeFields(Json::Value& dep, const pqxx::row& row) {
    const Json::Value snapshot = parseJsonObject(
        row["runtime_snapshot"].is_null() ? "" : row["runtime_snapshot"].as<std::string>()
    );
    const std::string imageName = jsonString(
        snapshot,
        "image_name",
        row["image_name"].is_null() ? "" : row["image_name"].as<std::string>()
    );
    const std::string runtimeProvider = jsonString(
        snapshot,
        "provider",
        row["runtime_provider"].is_null() ? "" : row["runtime_provider"].as<std::string>()
    );
    const std::string runtimeExposure = jsonString(
        snapshot,
        "exposure_mode",
        row["runtime_exposure"].is_null() ? "" : row["runtime_exposure"].as<std::string>()
    );
    const std::string remoteContainerName =
        row["remote_container_name"].is_null() ? "" : row["remote_container_name"].as<std::string>();
    const std::string k8sDeploymentName =
        row["k8s_deployment_name"].is_null() ? "" : row["k8s_deployment_name"].as<std::string>();

    dep["image_name"] = imageName;
    dep["k8s_namespace"] = row["k8s_namespace"].is_null() ? "" : row["k8s_namespace"].as<std::string>();
    dep["k8s_deployment_name"] = k8sDeploymentName;
    dep["k8s_service_name"] = row["k8s_service_name"].is_null() ? "" : row["k8s_service_name"].as<std::string>();
    dep["k8s_ingress_name"] = row["k8s_ingress_name"].is_null() ? "" : row["k8s_ingress_name"].as<std::string>();
    dep["desired_replicas"] = row["desired_replicas"].is_null() ? 1 : row["desired_replicas"].as<int>();
    dep["runtime_url"] = jsonString(
        snapshot,
        "runtime_url",
        row["runtime_url"].is_null() ? "" : row["runtime_url"].as<std::string>()
    );
    dep["runtime_exposure"] = runtimeExposure;
    dep["runtime_provider"] = runtimeProvider;
    dep["remote_container_name"] = remoteContainerName;
    dep["runtime_paused"] = row["runtime_paused"].is_null() ? false : row["runtime_paused"].as<bool>();
    dep["can_delete_image"] = !imageName.empty();
    dep["runtime_snapshot"] = snapshot.isObject() ? snapshot : Json::Value(Json::objectValue);
}

Json::Value DeploymentJournal::loadSummary(const std::string& deploymentId) {
    flush(deploymentId);
    auto& db = Database::getInstance();
    auto conn = db.getConnection();
    pqxx::work txn(*conn);
    auto rows = txn.exec_params(
        "SELECT d.id, p.user_id AS owner_user_id, d.project_id, p.name AS project_name, p.repo_url, d.status, d.version, d.commit_hash, "
        "d.environment_id, e.name AS environment_name, d.branch, d.commit_sha, d.trigger_source, d.github_delivery_id, "
        "d.ci_required, d.ci_status, d.logs, d.image_name, "
        "d.k8s_namespace, d.k8s_deployment_name, d.k8s_service_name, d.k8s_ingress_name, "
        "d.desired_replicas, d.runtime_url, d.runtime_exposure, d.runtime_provider, d.remote_container_name, "
        "d.runtime_paused, d.runtime_snapshot::text AS runtime_snapshot, d.created_at "
        "FROM deployments d "
        "JOIN projects p ON d.project_id = p.id "
        "LEFT JOIN project_environments e ON d.environment_id = e.id "
        "WHERE d.id = $1",
        deploymentId
    );
    txn.commit();

    if (rows.empty()) {
        return Json::Value();
    }

    const auto& row = rows[0];
    Json::Value dep;
    dep["id"] = row["id"].as<std::string>();
    // Internal routing field, stripped before the payload is sent.
    dep["__owner_user_id"] = row["owner_user_id"].as<std::string>();
    dep["project_id"] = row["project_id"].as<std::string>();
    dep["project_name"] = row["project_name"].as<std::string>();
    dep["repo_url"] = row["repo_url"].is_null() ? "" : row["repo_url"].as<std::string>();
    dep["status"] = row["status"].as<std::string>();
    dep["version"] = row["version"].as<std::string>();
    dep["commit_hash"] = row["commit_hash"].as<std::string>();
    dep["environment_id"] = row["environment_id"].is_null() ? "" : row["environment_id"].as<std::string>();
    dep["environment_name"] = row["environment_name"].is_null() ? "" : row["environment_name"].as<std::string>();
    dep["branch"] = row["branch"].is_null() ? "" : row["branch"].as<std::string>();
    dep["commit_sha"] = row["commit_sha"].is_null() ? "" : row["commit_sha"].as<std::string>();
    dep["trigger_source"] = row["trigger_source"].is_null() ? "manual" : row["trigger_source"].as<std::string>();
    dep["github_delivery_id"] = row["github_delivery_id"].is_null() ? "" : row["github_delivery_id"].as<std::string>();
    dep["ci_required"] = row["ci_required"].is_null() ? false : row["ci_required"].as<bool>();
    dep["ci_status"] = row["ci_status"].is_null() ? "not_required" : row["ci_status"].as<std::string>();
    dep["port_adjustments"] = row["logs"].is_null() ? Json::Value(Json::arrayValue) : extractPortAdjustments(row["logs"].as<std::string>());
    hydrateRuntimeFields(dep, row);
    dep["created_at"] = row["created_at"].as<std::string>();
    return dep;
}

void DeploymentJournal::broadcastSummary(const std::string& deploymentId) {
    Json::Value summary = loadSummary(deploymentId);
    if (!summary.isNull()) {
        const std::string ownerUserId = summary.get("__owner_user_id", "").asString();
        summary.removeMember("__owner_user_id");
        LogWebSocketController::broadcastDeploymentUpdate(summary, ownerUserId);
    }
}

}  // namespace stackpilot
