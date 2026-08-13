// ============================================================
// DeploymentInsights.cpp — drift and cost handlers
// ============================================================
// Members of DeploymentController, deliberately in their own translation unit.
// The controller was just cut from 4,400 lines to 3,900 and adding two more
// features to it would undo that. C++ lets members be defined across files;
// there is no reason a controller has to be one.

#include "DeploymentController.h"

#include "../db/Database.h"
#include "../services/CostModel.h"
#include "../services/DriftDetector.h"
#include "../services/KubernetesService.h"
#include "../services/LocalDockerRuntime.h"
#include "../utils/BlockingTaskRunner.h"
#include "../utils/JwtHelper.h"
#include "../utils/StringUtils.h"

#include <algorithm>
#include <json/json.h>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

namespace stackpilot {
namespace {

drogon::HttpResponsePtr errorResponse(drogon::HttpStatusCode status, const std::string& message) {
    Json::Value err;
    err["error"] = message;
    auto resp = drogon::HttpResponse::newHttpJsonResponse(err);
    resp->setStatusCode(status);
    return resp;
}

}  // namespace

void DeploymentController::checkDrift(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback,
    const std::string& deploymentId
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        callback(errorResponse(drogon::k401Unauthorized, "Unauthorized"));
        return;
    }

    // Inspecting a runtime shells out to kubectl or docker; that must not run
    // on a Drogon event-loop thread.
    BlockingTaskRunner::run([deploymentId, userId, callback = std::move(callback)]() mutable {
        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            auto rows = txn.exec_params(
                "SELECT d.id, d.desired_replicas, d.image_name, d.k8s_namespace, d.k8s_deployment_name, "
                "d.k8s_service_name, d.runtime_exposure, d.runtime_url, d.runtime_provider, "
                "d.remote_container_name, d.status "
                "FROM deployments d JOIN projects p ON p.id = d.project_id "
                "WHERE d.id = $1 AND has_project_access(p.id, $2)",
                deploymentId, userId
            );
            if (rows.empty()) {
                txn.commit();
                callback(errorResponse(drogon::k404NotFound, "Deployment not found"));
                return;
            }

            const auto& row = rows[0];
            const auto text = [&row](const char* key) -> std::string {
                return row[key].is_null() ? std::string() : row[key].as<std::string>();
            };

            Json::Value desired(Json::objectValue);
            desired["replicas"] = row["desired_replicas"].is_null() ? 1 : row["desired_replicas"].as<int>();
            desired["image"] = text("image_name");
            desired["namespace"] = text("k8s_namespace");
            desired["deployment_name"] = text("k8s_deployment_name");
            desired["service_name"] = text("k8s_service_name");
            desired["exposure"] = text("runtime_exposure");
            desired["runtime_url"] = text("runtime_url");

            const std::string provider = text("runtime_provider");
            const std::string nameSpace = text("k8s_namespace");
            const std::string deploymentName = text("k8s_deployment_name");

            // Left null when the runtime cannot be read. DriftDetector reports
            // that as `unreachable` rather than as a clean check.
            Json::Value observed;

            if (provider == "kubernetes" && !nameSpace.empty() && !deploymentName.empty()) {
                KubernetesService kubernetes;
                const KubernetesRuntimeInfo live = kubernetes.inspect(
                    nameSpace, deploymentName, text("k8s_service_name"), text("runtime_exposure"));
                if (live.success) {
                    observed = Json::Value(Json::objectValue);
                    observed["replicas"] = live.readyReplicas;
                    observed["namespace"] = live.nameSpace;
                    observed["deployment_name"] = live.deploymentName;
                    observed["service_name"] = live.serviceName;
                    observed["exposure"] = live.exposureMode;
                    observed["runtime_url"] = live.runtimeUrl;
                    // Replica counts always diverge mid-rollout. Saying so
                    // downgrades the finding instead of paging someone about
                    // a deploy that is working exactly as intended.
                    observed["rolling_out"] =
                        live.readyReplicas != live.desiredReplicas && live.status == "progressing";
                }
            } else if (provider == "local_docker") {
                const std::string container = text("remote_container_name");
                if (!container.empty()) {
                    std::string output;
                    const std::string format =
                        std::string("--format 'running={{.State.Running}}") + "\n" + "image={{.Config.Image}}'";
                    const int exitCode = LocalDockerRuntime::run(
                        "docker inspect " + format + " " + strings::shellQuote(container) + " 2>/dev/null",
                        output);
                    if (exitCode == 0 && !output.empty()) {
                        observed = Json::Value(Json::objectValue);
                        observed["replicas"] =
                            LocalDockerRuntime::markerValue(output, "running") == "true" ? 1 : 0;
                        observed["image"] = LocalDockerRuntime::markerValue(output, "image");
                    }
                }
            }

            const DriftReport report = DriftDetector::compare(desired, observed);

            // Record every check, including clean ones. Without that, a
            // detector that silently stopped running looks the same as a
            // cluster that never drifts.
            txn.exec_params(
                "INSERT INTO deployment_drift_checks (deployment_id, status, findings, summary) "
                "VALUES ($1, $2, $3::jsonb, $4)",
                deploymentId, report.status, strings::compactJson(report.findings), report.summary
            );
            txn.commit();

            Json::Value body;
            body["deployment_id"] = deploymentId;
            body["status"] = report.status;
            body["drifted"] = report.drifted();
            body["summary"] = report.summary;
            body["findings"] = report.findings;
            body["desired"] = desired;
            body["observed"] = observed.isNull() ? Json::Value(Json::objectValue) : observed;
            callback(drogon::HttpResponse::newHttpJsonResponse(body));
        } catch (const std::exception& e) {
            spdlog::error("checkDrift failed for {}: {}", deploymentId, e.what());
            callback(errorResponse(drogon::k500InternalServerError, "Failed to check drift"));
        }
    });
}

void DeploymentController::getCostReport(
    const drogon::HttpRequestPtr& req,
    std::function<void(const drogon::HttpResponsePtr&)>&& callback
) {
    const std::string userId = extractUserId(req);
    if (userId.empty()) {
        callback(errorResponse(drogon::k401Unauthorized, "Unauthorized"));
        return;
    }

    int days = 30;
    const std::string requested = req->getParameter("days");
    if (!requested.empty()) {
        try {
            days = std::clamp(std::stoi(requested), 1, 365);
        } catch (...) {
            days = 30;
        }
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        // has_project_access does the scoping, so this reports across the whole
        // organization for a member and only their own work for a solo user,
        // without the handler knowing which case it is in.
        auto rows = txn.exec_params(
            "SELECT p.id AS project_id, p.name AS project_name, "
            "COALESCE(SUM(c.accrued_millicents), 0)::bigint AS total_millicents, "
            "COALESCE(SUM(CASE WHEN d.is_preview THEN c.accrued_millicents ELSE 0 END), 0)::bigint "
            "  AS preview_millicents, "
            "COUNT(DISTINCT c.deployment_id)::int AS deployments "
            "FROM projects p "
            "LEFT JOIN deployment_cost_samples c "
            "  ON c.project_id = p.id AND c.sampled_at > NOW() - ($2 || ' days')::interval "
            "LEFT JOIN deployments d ON d.id = c.deployment_id "
            "WHERE has_project_access(p.id, $1) "
            "GROUP BY p.id, p.name ORDER BY total_millicents DESC",
            userId, std::to_string(days)
        );
        txn.commit();

        Json::Value projects(Json::arrayValue);
        long long total = 0;
        long long previewTotal = 0;
        for (const auto& row : rows) {
            const long long amount = row["total_millicents"].as<long long>();
            const long long preview = row["preview_millicents"].as<long long>();
            total += amount;
            previewTotal += preview;

            Json::Value entry(Json::objectValue);
            entry["project_id"] = row["project_id"].as<std::string>();
            entry["project_name"] = row["project_name"].as<std::string>();
            entry["millicents"] = Json::Int64(amount);
            entry["formatted"] = CostModel::formatMillicents(amount);
            entry["preview_millicents"] = Json::Int64(preview);
            entry["preview_formatted"] = CostModel::formatMillicents(preview);
            entry["deployments"] = row["deployments"].as<int>();
            projects.append(entry);
        }

        Json::Value body;
        body["window_days"] = days;
        body["total_millicents"] = Json::Int64(total);
        body["total_formatted"] = CostModel::formatMillicents(total);
        // Preview spend is broken out because it is the line people are
        // surprised by: an environment nobody remembers opening.
        body["preview_millicents"] = Json::Int64(previewTotal);
        body["preview_formatted"] = CostModel::formatMillicents(previewTotal);
        body["projects"] = projects;
        body["note"] = "Attribution is derived from requested resources, not observed usage. "
                       "A reservation costs the cluster whether or not it is used.";
        callback(drogon::HttpResponse::newHttpJsonResponse(body));
    } catch (const std::exception& e) {
        spdlog::error("getCostReport failed: {}", e.what());
        callback(errorResponse(drogon::k500InternalServerError, "Failed to build cost report"));
    }
}

}  // namespace stackpilot
