// ============================================================
// OrganizationController.h — teams and membership
// ============================================================
// Endpoints:
//   GET    /api/v1/organizations                    List the caller's orgs
//   POST   /api/v1/organizations                    Create a shared org
//   GET    /api/v1/organizations/{id}/members       List members
//   POST   /api/v1/organizations/{id}/members       Add a member by email
//   PATCH  /api/v1/organizations/{id}/members/{uid} Change a member's role
//   DELETE /api/v1/organizations/{id}/members/{uid} Remove a member

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class OrganizationController : public drogon::HttpController<OrganizationController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(OrganizationController::listOrganizations, "/api/v1/organizations", drogon::Get, drogon::Options);
    ADD_METHOD_TO(OrganizationController::createOrganization, "/api/v1/organizations", drogon::Post);
    ADD_METHOD_TO(OrganizationController::listMembers, "/api/v1/organizations/{1}/members", drogon::Get, drogon::Options);
    ADD_METHOD_TO(OrganizationController::addMember, "/api/v1/organizations/{1}/members", drogon::Post);
    ADD_METHOD_TO(OrganizationController::updateMemberRole, "/api/v1/organizations/{1}/members/{2}", drogon::Patch);
    ADD_METHOD_TO(OrganizationController::removeMember, "/api/v1/organizations/{1}/members/{2}", drogon::Delete);
    METHOD_LIST_END

    void listOrganizations(const drogon::HttpRequestPtr& req,
                           std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void createOrganization(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void listMembers(const drogon::HttpRequestPtr& req,
                     std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                     std::string organizationId);

    void addMember(const drogon::HttpRequestPtr& req,
                   std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                   std::string organizationId);

    void updateMemberRole(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          std::string organizationId,
                          std::string memberUserId);

    void removeMember(const drogon::HttpRequestPtr& req,
                      std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                      std::string organizationId,
                      std::string memberUserId);
};

}  // namespace stackpilot
