// ============================================================
// ClusterTargets.cpp
// ============================================================

#include "ClusterTargets.h"

#include "../db/Database.h"
#include "../utils/TokenCrypto.h"

#include <pqxx/pqxx>
#include <spdlog/spdlog.h>

namespace stackpilot {
namespace {

ClusterTarget fromRow(const pqxx::row& row) {
    ClusterTarget target;
    if (row["cluster_id"].is_null()) {
        return target;
    }
    target.clusterId = row["cluster_id"].as<std::string>();
    target.clusterName = row["cluster_name"].is_null() ? "" : row["cluster_name"].as<std::string>();

    if (row["kubeconfig_encrypted"].is_null()) {
        // A cluster recorded before kubeconfig capture existed. Say so rather
        // than silently deploying somewhere else -- the caller can tell the
        // user to re-run cluster init.
        spdlog::warn("Cluster {} has no stored kubeconfig; falling back to KUBECONFIG_PATH", target.clusterId);
        return target;
    }

    try {
        target.kubeconfig = TokenCrypto::decrypt(row["kubeconfig_encrypted"].as<std::string>());
    } catch (const std::exception& e) {
        spdlog::error("Could not decrypt the kubeconfig for cluster {}: {}", target.clusterId, e.what());
        target.kubeconfig.clear();
    }
    return target;
}

}  // namespace

ClusterTarget ClusterTargets::forDeployment(const std::string& deploymentId) {
    ClusterTarget target;
    if (deploymentId.empty()) {
        return target;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        // COALESCE walks the precedence chain in one query: the deployment's
        // own pin, then its environment, then the project default.
        const auto rows = txn.exec_params(
            "SELECT c.id AS cluster_id, c.name AS cluster_name, c.kubeconfig_encrypted "
            "FROM deployments d "
            "JOIN projects p ON p.id = d.project_id "
            "LEFT JOIN project_environments e ON e.id = d.environment_id "
            "LEFT JOIN kubernetes_clusters c "
            "  ON c.id = COALESCE(d.target_cluster_id, e.target_cluster_id, p.default_cluster_id) "
            "WHERE d.id = $1",
            deploymentId
        );
        txn.commit();
        if (rows.empty()) {
            return target;
        }
        return fromRow(rows[0]);
    } catch (const std::exception& e) {
        // Never fatal. Falling back to the configured kubeconfig is the same
        // behaviour the platform had before clusters were targetable.
        spdlog::warn("Cluster target lookup failed for deployment {}: {}", deploymentId, e.what());
        return target;
    }
}

ClusterTarget ClusterTargets::byId(const std::string& clusterId, const std::string& userId) {
    ClusterTarget target;
    if (clusterId.empty() || userId.empty()) {
        return target;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        const auto rows = txn.exec_params(
            "SELECT id AS cluster_id, name AS cluster_name, kubeconfig_encrypted "
            "FROM kubernetes_clusters WHERE id = $1 AND user_id = $2",
            clusterId, userId
        );
        txn.commit();
        if (rows.empty()) {
            return target;
        }
        return fromRow(rows[0]);
    } catch (const std::exception& e) {
        spdlog::warn("Cluster lookup failed for {}: {}", clusterId, e.what());
        return target;
    }
}

}  // namespace stackpilot
