// ============================================================
// AuthController.h — Authentication REST API
// ============================================================
// Endpoints:
//   POST /api/v1/auth/register  → Create new user
//   POST /api/v1/auth/login     → Login and get JWT token
//   GET  /api/v1/auth/me        → Get current user (requires JWT)
// ============================================================

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class AuthController : public drogon::HttpController<AuthController> {
public:
    // ─── Route Registration ─────────────────────────────────
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(AuthController::registerUser, "/api/v1/auth/register", drogon::Post);
    ADD_METHOD_TO(AuthController::loginUser, "/api/v1/auth/login", drogon::Post);
    ADD_METHOD_TO(AuthController::googleAuth, "/api/v1/auth/google", drogon::Post);
    ADD_METHOD_TO(AuthController::startGitHubAuth, "/api/v1/auth/github/start", drogon::Post);
    ADD_METHOD_TO(AuthController::githubCallback, "/api/v1/auth/github/callback", drogon::Get);
    ADD_METHOD_TO(AuthController::requestPasswordResetOtp, "/api/v1/auth/forgot-password/request", drogon::Post);
    ADD_METHOD_TO(AuthController::resetPasswordWithOtp, "/api/v1/auth/forgot-password/verify", drogon::Post);
    ADD_METHOD_TO(AuthController::logoutUser, "/api/v1/auth/logout", drogon::Post);
    ADD_METHOD_TO(AuthController::disconnectGitHub, "/api/v1/auth/github", drogon::Delete);
    ADD_METHOD_TO(AuthController::getMe, "/api/v1/auth/me", drogon::Get);
    ADD_METHOD_TO(AuthController::getLoginHistory, "/api/v1/auth/login-history", drogon::Get);
    ADD_METHOD_TO(AuthController::getAuditLogs, "/api/v1/auth/audit-logs", drogon::Get);
    ADD_METHOD_TO(AuthController::updateMe, "/api/v1/auth/me", drogon::Put);
    ADD_METHOD_TO(AuthController::getIconSettings, "/api/v1/auth/icon-settings", drogon::Get);
    ADD_METHOD_TO(AuthController::updateIconSettings, "/api/v1/auth/icon-settings", drogon::Put);
    ADD_METHOD_TO(AuthController::getPreferences, "/api/v1/auth/preferences", drogon::Get);
    ADD_METHOD_TO(AuthController::updatePreferences, "/api/v1/auth/preferences", drogon::Put);
    
    // Explicit OPTIONS handlers for preflight requests
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/register", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/login", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/google", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/github/start", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/forgot-password/request", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/forgot-password/verify", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/logout", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/github", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/me", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/login-history", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/audit-logs", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/icon-settings", drogon::Options);
    ADD_METHOD_TO(AuthController::handleOptions, "/api/v1/auth/preferences", drogon::Options);
    METHOD_LIST_END

    // ─── Handler Methods ────────────────────────────────────

    void registerUser(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void loginUser(const drogon::HttpRequestPtr& req,
                   std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void googleAuth(const drogon::HttpRequestPtr& req,
                    std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void startGitHubAuth(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void githubCallback(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void requestPasswordResetOtp(const drogon::HttpRequestPtr& req,
                                 std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void resetPasswordWithOtp(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void logoutUser(const drogon::HttpRequestPtr& req,
                    std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void disconnectGitHub(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void getMe(const drogon::HttpRequestPtr& req,
               std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void getLoginHistory(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void getAuditLogs(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void updateMe(const drogon::HttpRequestPtr& req,
                  std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void getIconSettings(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void updateIconSettings(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void getPreferences(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void updatePreferences(const drogon::HttpRequestPtr& req,
                           std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void handleOptions(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback);
};

} // namespace stackpilot
