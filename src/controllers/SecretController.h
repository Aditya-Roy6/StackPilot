// ============================================================
// SecretController.h - encrypted project secrets
// ============================================================
// Values are write-only: list responses never include the plaintext, and
// reveal is a separate, audited endpoint.
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class SecretController : public drogon::HttpController<SecretController> {
public:
    METHOD_LIST_BEGIN
    // Account-wide view that backs the Secrets section in the sidebar.
    ADD_METHOD_TO(SecretController::listAllSecrets, "/api/v1/secrets", drogon::Get);
    ADD_METHOD_TO(SecretController::listSecrets, "/api/v1/projects/{project_id}/secrets", drogon::Get);
    ADD_METHOD_TO(SecretController::upsertSecret, "/api/v1/projects/{project_id}/secrets", drogon::Post);
    ADD_METHOD_TO(SecretController::deleteSecret, "/api/v1/projects/{project_id}/secrets/{secret_id}", drogon::Delete);
    ADD_METHOD_TO(SecretController::revealSecret, "/api/v1/projects/{project_id}/secrets/{secret_id}/reveal", drogon::Post);
    METHOD_LIST_END

    void listAllSecrets(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback);
    void listSecrets(const drogon::HttpRequestPtr& req,
                     std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                     const std::string& projectId);
    void upsertSecret(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                      const std::string& projectId);
    void deleteSecret(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                      const std::string& projectId,
                      const std::string& secretId);
    void revealSecret(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                      const std::string& projectId,
                      const std::string& secretId);

private:
    std::string extractUserId(const drogon::HttpRequestPtr& req);
    bool userOwnsProject(const std::string& projectId, const std::string& userId);
};

} // namespace stackpilot
