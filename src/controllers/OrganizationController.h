// ============================================================
// OrganizationController.h — teams and membership
// ============================================================
// Endpoints:
//   GET    /api/v1/organizations                          List the caller's orgs
//   POST   /api/v1/organizations                          Create a shared org
//   PATCH  /api/v1/organizations/{id}                     Rename/update org
//   DELETE /api/v1/organizations/{id}                     Delete org (owner only)
//   GET    /api/v1/organizations/{id}/members             List members
//   POST   /api/v1/organizations/{id}/members             Add a member by email
//   PATCH  /api/v1/organizations/{id}/members/{uid}       Change a member's role
//   DELETE /api/v1/organizations/{id}/members/{uid}       Remove a member
//   GET    /api/v1/organizations/{id}/invitations         List pending invitations
//   POST   /api/v1/organizations/{id}/invitations         Create an invitation
//   DELETE /api/v1/organizations/{id}/invitations/{invId} Revoke an invitation
//   GET    /api/v1/organizations/invitations/{token}      Get invitation info
//   POST   /api/v1/organizations/join/{token}             Accept invite and join org

#pragma once

#include <drogon/HttpController.h>

namespace stackpilot {

class OrganizationController : public drogon::HttpController<OrganizationController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(OrganizationController::listOrganizations, "/api/v1/organizations", drogon::Get, drogon::Options);
    ADD_METHOD_TO(OrganizationController::createOrganization, "/api/v1/organizations", drogon::Post);
    ADD_METHOD_TO(OrganizationController::updateOrganization, "/api/v1/organizations/{1}", drogon::Patch);
    ADD_METHOD_TO(OrganizationController::deleteOrganization, "/api/v1/organizations/{1}", drogon::Delete);
    ADD_METHOD_TO(OrganizationController::listMembers, "/api/v1/organizations/{1}/members", drogon::Get, drogon::Options);
    ADD_METHOD_TO(OrganizationController::addMember, "/api/v1/organizations/{1}/members", drogon::Post);
    ADD_METHOD_TO(OrganizationController::updateMemberRole, "/api/v1/organizations/{1}/members/{2}", drogon::Patch);
    ADD_METHOD_TO(OrganizationController::removeMember, "/api/v1/organizations/{1}/members/{2}", drogon::Delete);
    ADD_METHOD_TO(OrganizationController::listInvitations, "/api/v1/organizations/{1}/invitations", drogon::Get, drogon::Options);
    ADD_METHOD_TO(OrganizationController::createInvitation, "/api/v1/organizations/{1}/invitations", drogon::Post);
    ADD_METHOD_TO(OrganizationController::revokeInvitation, "/api/v1/organizations/{1}/invitations/{2}", drogon::Delete);
    ADD_METHOD_TO(OrganizationController::getInviteInfo, "/api/v1/organizations/invitations/{1}", drogon::Get, drogon::Options);
    ADD_METHOD_TO(OrganizationController::joinOrganization, "/api/v1/organizations/join/{1}", drogon::Post);
    METHOD_LIST_END

    void listOrganizations(const drogon::HttpRequestPtr& req,
                           std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void createOrganization(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void updateOrganization(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                            std::string organizationId);

    void deleteOrganization(const drogon::HttpRequestPtr& req,
                            std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                            std::string organizationId);

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

    void listInvitations(const drogon::HttpRequestPtr& req,
                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                         std::string organizationId);

    void createInvitation(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          std::string organizationId);

    void revokeInvitation(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          std::string organizationId,
                          std::string invitationId);

    void getInviteInfo(const drogon::HttpRequestPtr& req,
                       std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                       std::string token);

    void joinOrganization(const drogon::HttpRequestPtr& req,
                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                          std::string token);
};

}  // namespace stackpilot
