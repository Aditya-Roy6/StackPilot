// ============================================================
// SshController.h - Saved SSH/VPS connection management API
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class SshController : public drogon::HttpController<SshController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(SshController::listConnections, "/api/v1/ssh/connections", drogon::Get);
    ADD_METHOD_TO(SshController::listKubernetesClusters, "/api/v1/ssh/clusters", drogon::Get);
    ADD_METHOD_TO(SshController::createConnection, "/api/v1/ssh/connections", drogon::Post);
    ADD_METHOD_TO(SshController::testConnection, "/api/v1/ssh/connections/{id}/test", drogon::Post);
    ADD_METHOD_TO(SshController::probeConnection, "/api/v1/ssh/connections/{id}/probe", drogon::Post);
    ADD_METHOD_TO(SshController::provisionDocker, "/api/v1/ssh/connections/{id}/provision/docker", drogon::Post);
    ADD_METHOD_TO(SshController::provisionKubernetes, "/api/v1/ssh/connections/{id}/provision/kubernetes", drogon::Post);
    ADD_METHOD_TO(SshController::initializeKubernetesCluster, "/api/v1/ssh/connections/{id}/cluster/init", drogon::Post);
    ADD_METHOD_TO(SshController::joinKubernetesCluster, "/api/v1/ssh/connections/{id}/cluster/join", drogon::Post);
    ADD_METHOD_TO(SshController::inspectKubernetesCluster, "/api/v1/ssh/connections/{id}/cluster/status", drogon::Get);
    ADD_METHOD_TO(SshController::deleteKubernetesCluster, "/api/v1/ssh/clusters/{id}", drogon::Delete);
    ADD_METHOD_TO(SshController::wipeConnection, "/api/v1/ssh/connections/{id}/wipe", drogon::Post);
    ADD_METHOD_TO(SshController::removeKubernetesNode, "/api/v1/ssh/connections/{id}/cluster/nodes/{node}", drogon::Delete);
    ADD_METHOD_TO(SshController::browseConnection, "/api/v1/ssh/connections/{id}/browse", drogon::Post);
    ADD_METHOD_TO(SshController::executeCommand, "/api/v1/ssh/connections/{id}/command", drogon::Post);
    ADD_METHOD_TO(SshController::cloneRepository, "/api/v1/ssh/connections/{id}/git/clone", drogon::Post);
    ADD_METHOD_TO(SshController::deleteConnection, "/api/v1/ssh/connections/{id}", drogon::Delete);
    METHOD_LIST_END

    void listConnections(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void listKubernetesClusters(const drogon::HttpRequestPtr& req,
                                std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void createConnection(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void testConnection(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                        const std::string& id);
    void probeConnection(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         const std::string& id);
    void provisionDocker(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         const std::string& id);
    void provisionKubernetes(const drogon::HttpRequestPtr& req,
                             std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                             const std::string& id);
    void initializeKubernetesCluster(const drogon::HttpRequestPtr& req,
                                     std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                     const std::string& id);
    void joinKubernetesCluster(const drogon::HttpRequestPtr& req,
                               std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                               const std::string& id);
    /// Cordons, drains and removes one node from the cluster. Draining first
    /// is what makes it safe; deleting a node outright strands its pods.
    void removeKubernetesNode(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                              const std::string& id,
                              const std::string& nodeName);

    void inspectKubernetesCluster(const drogon::HttpRequestPtr& req,
                                  std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                  const std::string& id);
    void deleteKubernetesCluster(const drogon::HttpRequestPtr& req,
                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                 const std::string& id);
    void wipeConnection(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                        const std::string& id);
    void browseConnection(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          const std::string& id);
    void executeCommand(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                        const std::string& id);
    void cloneRepository(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         const std::string& id);
    void deleteConnection(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          const std::string& id);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req) const;
};

} // namespace stackpilot
