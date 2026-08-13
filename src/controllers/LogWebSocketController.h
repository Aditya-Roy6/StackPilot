// ============================================================
// LogWebSocketController.h — Real-time Build Log Streaming
// ============================================================

#pragma once

#include <drogon/WebSocketController.h>
#include <json/json.h>
#include <map>
#include <set>
#include <mutex>

namespace stackpilot {

class LogWebSocketController : public drogon::WebSocketController<LogWebSocketController> {
public:
    virtual void handleNewMessage(const drogon::WebSocketConnectionPtr&,
                                 std::string&&,
                                 const drogon::WebSocketMessageType&) override;
    virtual void handleNewConnection(const drogon::HttpRequestPtr&,
                                    const drogon::WebSocketConnectionPtr&) override;
    virtual void handleConnectionClosed(const drogon::WebSocketConnectionPtr&) override;

    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/ws/logs");
    WS_PATH_LIST_END

    // Static helper to broadcast logs to all listeners of a deployment
    static void broadcastLog(const std::string& deploymentId, const std::string& line);
    static void broadcastStatus(const std::string& deploymentId, const std::string& status);
    // ownerUserId scopes the fan-out to the deployment owner's private channel.
    // Without it the global channel leaked every tenant's deployments.
    static void broadcastDeploymentUpdate(const Json::Value& deployment, const std::string& ownerUserId);
    static void broadcastDeploymentDeleted(const std::string& deploymentId, const std::string& ownerUserId);

private:
    static void sendToChannelUnlocked(const std::string& channelKey, const std::string& payload);

    static std::map<std::string, std::set<drogon::WebSocketConnectionPtr>> subscribers_;
    static std::mutex subscribersMutex_;
};

} // namespace stackpilot
