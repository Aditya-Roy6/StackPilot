// ============================================================
// ClusterTargets.h — which cluster a deployment goes to
// ============================================================
// Before this, every deployment went to whatever cluster the backend's
// KUBECONFIG_PATH pointed at, and a cluster built through the Cluster Builder
// was recorded but unreachable. Resolution order, most specific first:
//
//   1. deployments.target_cluster_id      pinned for this deployment
//   2. project_environments.target_cluster_id   e.g. staging vs production
//   3. projects.default_cluster_id        the project's usual home
//   4. "" -> KUBECONFIG_PATH              unchanged legacy behaviour
//
// Returning "" for the last case is deliberate: every existing deployment has
// no target and must keep working exactly as it did.

#pragma once

#include <string>

namespace stackpilot {

struct ClusterTarget {
    std::string clusterId;
    std::string clusterName;
    /// Decrypted kubeconfig contents. Empty means "use KUBECONFIG_PATH".
    std::string kubeconfig;

    bool isExplicit() const { return !clusterId.empty() && !kubeconfig.empty(); }
};

class ClusterTargets {
public:
    /// Resolves the target for a deployment. Never throws; on any failure it
    /// returns an empty target so the deployment falls back rather than
    /// breaking.
    static ClusterTarget forDeployment(const std::string& deploymentId);

    /// Resolves one cluster by id, checking the caller may see it.
    static ClusterTarget byId(const std::string& clusterId, const std::string& userId);
};

}  // namespace stackpilot
