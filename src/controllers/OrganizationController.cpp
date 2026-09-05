// ============================================================
// OrganizationController.cpp
// ============================================================

#include "OrganizationController.h"

#include "../db/Database.h"
#include "../services/EmailService.h"
#include "../utils/AuditLogger.h"
#include "../utils/Authz.h"
#include "../utils/JwtHelper.h"
#include "../utils/StringUtils.h"

#include <iomanip>
#include <json/json.h>
#include <openssl/rand.h>
#include <pqxx/pqxx>
#include <sstream>
#include <spdlog/spdlog.h>

namespace stackpilot {
namespace {

using strings::toLower;
using strings::trim;

void sendJson(std::function<void(const drogon::HttpResponsePtr&)>& callback,
              const Json::Value& payload,
              drogon::HttpStatusCode status = drogon::k200OK) {
    auto resp = drogon::HttpResponse::newHttpJsonResponse(payload);
    resp->setStatusCode(status);
    callback(resp);
}

void sendError(std::function<void(const drogon::HttpResponsePtr&)>& callback,
               drogon::HttpStatusCode status,
               const std::string& message) {
    Json::Value payload;
    payload["error"] = message;
    sendJson(callback, payload, status);
}

/// Returns the authenticated user id, or "" after having already replied 401.
std::string requireUser(const drogon::HttpRequestPtr& req,
                        std::function<void(const drogon::HttpResponsePtr&)>& callback) {
    const Json::Value payload = JwtHelper::verifyRequestToken(req);
    if (payload.isNull() || !payload.isMember("user_id")) {
        sendError(callback, drogon::k401Unauthorized, "Authentication required");
        return "";
    }
    return payload["user_id"].asString();
}

std::string generateRandomToken(size_t bytes = 32) {
    std::vector<unsigned char> buf(bytes);
    if (RAND_bytes(buf.data(), static_cast<int>(bytes)) != 1) {
        return drogon::utils::getUuid();
    }
    std::ostringstream ss;
    for (unsigned char b : buf) {
        ss << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(b);
    }
    return ss.str();
}

Json::Value organizationRowToJson(const pqxx::row& row) {
    Json::Value org(Json::objectValue);
    org["id"] = row["id"].as<std::string>();
    org["name"] = row["name"].as<std::string>();
    org["slug"] = row["slug"].as<std::string>();
    org["is_personal"] = row["is_personal"].as<bool>();
    org["role"] = row["role"].as<std::string>();
    org["member_count"] = row["member_count"].as<int>();
    org["created_at"] = row["created_at"].as<std::string>();
    return org;
}

/// Lowercase alphanumerics and dashes, derived from the display name.
std::string slugify(const std::string& value) {
    std::string out;
    for (const char c : toLower(trim(value))) {
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
            out.push_back(c);
        } else if (!out.empty() && out.back() != '-') {
            out.push_back('-');
        }
    }
    while (!out.empty() && out.back() == '-') out.pop_back();
    if (out.empty()) out = "team";
    if (out.size() > 60) out.resize(60);
    return out;
}

}  // namespace

void OrganizationController::listOrganizations(const drogon::HttpRequestPtr& req,
                                               std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);
        const auto rows = txn.exec_params(
            "SELECT o.id, o.name, o.slug, o.is_personal, m.role, o.created_at::text AS created_at, "
            "(SELECT COUNT(*) FROM organization_members m2 WHERE m2.organization_id = o.id)::int AS member_count "
            "FROM organizations o "
            "JOIN organization_members m ON m.organization_id = o.id "
            "WHERE m.user_id = $1 "
            "ORDER BY o.is_personal DESC, o.name",
            userId
        );
        txn.commit();

        Json::Value list(Json::arrayValue);
        for (const auto& row : rows) list.append(organizationRowToJson(row));

        Json::Value body;
        body["organizations"] = list;
        sendJson(callback, body);
    } catch (const std::exception& e) {
        spdlog::error("listOrganizations failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to load organizations");
    }
}

void OrganizationController::createOrganization(const drogon::HttpRequestPtr& req,
                                                std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    const auto body = req->getJsonObject();
    if (!body) {
        sendError(callback, drogon::k400BadRequest, "Invalid JSON body");
        return;
    }
    const std::string name = trim((*body)["name"].asString());
    if (name.empty() || name.size() > 120) {
        sendError(callback, drogon::k400BadRequest, "Organization name is required (max 120 characters)");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        std::string slug = slugify(name);
        const auto taken = txn.exec_params(
            "SELECT COUNT(*)::int FROM organizations WHERE slug = $1 OR slug LIKE $1 || '-%'", slug);
        const int collisions = taken[0][0].as<int>();
        if (collisions > 0) {
            slug += "-" + std::to_string(collisions + 1);
        }

        const auto rows = txn.exec_params(
            "INSERT INTO organizations (name, slug, created_by, is_personal) "
            "VALUES ($1, $2, $3, FALSE) RETURNING id, name, slug, is_personal, created_at::text AS created_at",
            name, slug, userId
        );
        const std::string organizationId = rows[0]["id"].as<std::string>();

        txn.exec_params(
            "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
            organizationId, userId
        );
        txn.commit();

        Json::Value org(Json::objectValue);
        org["id"] = organizationId;
        org["name"] = rows[0]["name"].as<std::string>();
        org["slug"] = rows[0]["slug"].as<std::string>();
        org["is_personal"] = false;
        org["role"] = roles::kOwner;
        org["member_count"] = 1;
        org["created_at"] = rows[0]["created_at"].as<std::string>();

        AuditLogger::recordFromRequest(req, userId, "organization.create", "organization", organizationId, org);

        Json::Value payload;
        payload["message"] = "Organization created";
        payload["organization"] = org;
        sendJson(callback, payload, drogon::k201Created);
    } catch (const std::exception& e) {
        spdlog::error("createOrganization failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to create organization");
    }
}

void OrganizationController::updateOrganization(const drogon::HttpRequestPtr& req,
                                                std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                                std::string organizationId) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    const auto body = req->getJsonObject();
    if (!body) {
        sendError(callback, drogon::k400BadRequest, "Invalid JSON body");
        return;
    }
    const std::string name = trim((*body)["name"].asString());
    if (name.empty() || name.size() > 120) {
        sendError(callback, drogon::k400BadRequest, "Organization name is required (max 120 characters)");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        if (!Authz::hasOrganizationRole(txn, organizationId, userId, roles::kAdmin)) {
            sendError(callback, drogon::k403Forbidden, "Only admins and owners can update organization settings");
            return;
        }

        const auto orgRow = txn.exec_params(
            "SELECT is_personal FROM organizations WHERE id = $1", organizationId);
        if (orgRow.empty()) {
            sendError(callback, drogon::k404NotFound, "Organization not found");
            return;
        }
        if (orgRow[0]["is_personal"].as<bool>()) {
            sendError(callback, drogon::k400BadRequest, "Personal workspaces cannot be renamed");
            return;
        }

        std::string slug = slugify(name);
        const auto taken = txn.exec_params(
            "SELECT COUNT(*)::int FROM organizations WHERE (slug = $1 OR slug LIKE $1 || '-%') AND id != $2",
            slug, organizationId);
        const int collisions = taken[0][0].as<int>();
        if (collisions > 0) {
            slug += "-" + std::to_string(collisions + 1);
        }

        txn.exec_params(
            "UPDATE organizations SET name = $1, slug = $2, updated_at = NOW() WHERE id = $3",
            name, slug, organizationId);
        txn.commit();

        Json::Value meta;
        meta["id"] = organizationId;
        meta["name"] = name;
        meta["slug"] = slug;
        AuditLogger::recordFromRequest(req, userId, "organization.update", "organization", organizationId, meta);

        Json::Value payload;
        payload["message"] = "Organization updated";
        payload["organization"] = meta;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("updateOrganization failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to update organization");
    }
}

void OrganizationController::deleteOrganization(const drogon::HttpRequestPtr& req,
                                                std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                                std::string organizationId) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        if (!Authz::hasOrganizationRole(txn, organizationId, userId, roles::kOwner)) {
            sendError(callback, drogon::k403Forbidden, "Only the owner can delete an organization");
            return;
        }

        const auto orgRow = txn.exec_params(
            "SELECT name, is_personal FROM organizations WHERE id = $1", organizationId);
        if (orgRow.empty()) {
            sendError(callback, drogon::k404NotFound, "Organization not found");
            return;
        }
        if (orgRow[0]["is_personal"].as<bool>()) {
            sendError(callback, drogon::k400BadRequest, "Personal workspaces cannot be deleted");
            return;
        }

        const std::string orgName = orgRow[0]["name"].as<std::string>();

        txn.exec_params("DELETE FROM projects WHERE organization_id = $1", organizationId);
        txn.exec_params("DELETE FROM organizations WHERE id = $1", organizationId);
        txn.commit();

        Json::Value meta;
        meta["id"] = organizationId;
        meta["name"] = orgName;
        AuditLogger::recordFromRequest(req, userId, "organization.delete", "organization", organizationId, meta);

        Json::Value payload;
        payload["message"] = "Organization deleted successfully";
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("deleteOrganization failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to delete organization");
    }
}

void OrganizationController::listMembers(const drogon::HttpRequestPtr& req,
                                         std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                         std::string organizationId) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        if (!Authz::hasOrganizationRole(txn, organizationId, userId, roles::kViewer)) {
            sendError(callback, drogon::k404NotFound, "Organization not found");
            return;
        }

        const auto rows = txn.exec_params(
            "SELECT u.id, u.username, u.email, COALESCE(u.full_name, '') AS full_name, "
            "m.role, m.created_at::text AS created_at "
            "FROM organization_members m JOIN users u ON u.id = m.user_id "
            "WHERE m.organization_id = $1 "
            "ORDER BY role_rank(m.role) DESC, u.username",
            organizationId
        );
        txn.commit();

        Json::Value list(Json::arrayValue);
        for (const auto& row : rows) {
            Json::Value member(Json::objectValue);
            member["user_id"] = row["id"].as<std::string>();
            member["username"] = row["username"].as<std::string>();
            member["email"] = row["email"].as<std::string>();
            member["full_name"] = row["full_name"].as<std::string>();
            member["role"] = row["role"].as<std::string>();
            member["joined_at"] = row["created_at"].as<std::string>();
            list.append(member);
        }

        Json::Value payload;
        payload["members"] = list;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("listMembers failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to load members");
    }
}

void OrganizationController::addMember(const drogon::HttpRequestPtr& req,
                                       std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                       std::string organizationId) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    const auto body = req->getJsonObject();
    if (!body) {
        sendError(callback, drogon::k400BadRequest, "Invalid JSON body");
        return;
    }
    const std::string email = toLower(trim((*body)["email"].asString()));
    const std::string role = toLower(trim((*body)["role"].asString().empty()
                                              ? std::string(roles::kMember)
                                              : (*body)["role"].asString()));
    if (email.empty()) {
        sendError(callback, drogon::k400BadRequest, "Member email is required");
        return;
    }
    if (!Authz::isKnownRole(role)) {
        sendError(callback, drogon::k400BadRequest, "Role must be one of: owner, admin, member, viewer");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        if (!Authz::hasOrganizationRole(txn, organizationId, userId, roles::kAdmin)) {
            const bool isMember = Authz::hasOrganizationRole(txn, organizationId, userId, roles::kViewer);
            sendError(callback,
                      isMember ? drogon::k403Forbidden : drogon::k404NotFound,
                      isMember ? "Only admins and owners can add members" : "Organization not found");
            return;
        }

        const std::string callerRole = Authz::organizationRole(txn, organizationId, userId);
        if (Authz::roleRank(role) > Authz::roleRank(callerRole)) {
            sendError(callback, drogon::k403Forbidden, "You cannot grant a role higher than your own");
            return;
        }

        const auto personal = txn.exec_params(
            "SELECT is_personal FROM organizations WHERE id = $1", organizationId);
        if (!personal.empty() && personal[0][0].as<bool>()) {
            sendError(callback, drogon::k400BadRequest,
                      "A personal workspace cannot have additional members. Create a team organization instead.");
            return;
        }

        const auto orgRow = txn.exec_params("SELECT name FROM organizations WHERE id = $1", organizationId);
        const std::string orgName = orgRow.empty() ? "Organization" : orgRow[0][0].as<std::string>();
        const auto userRow = txn.exec_params("SELECT username, COALESCE(full_name, username) FROM users WHERE id = $1", userId);
        const std::string inviterName = userRow.empty() ? "A team administrator" : userRow[0][1].as<std::string>();

        const auto found = txn.exec_params("SELECT id FROM users WHERE LOWER(email) = $1", email);
        if (!found.empty()) {
            const std::string memberId = found[0][0].as<std::string>();
            const auto existingMember = txn.exec_params(
                "SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2",
                organizationId, memberId
            );
            if (!existingMember.empty()) {
                sendError(callback, drogon::k400BadRequest, "User is already a member of this organization");
                return;
            }
        }

        const std::string token = generateRandomToken(32);
        txn.exec_params(
            "INSERT INTO organization_invitations (organization_id, email, role, token, invited_by, expires_at) "
            "VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days') "
            "ON CONFLICT (organization_id, email) DO UPDATE "
            "SET role = EXCLUDED.role, token = EXCLUDED.token, expires_at = NOW() + INTERVAL '7 days'",
            organizationId, email, role, token, userId
        );
        txn.commit();

        const std::string frontendUrl = strings::trim(std::getenv("FRONTEND_PUBLIC_URL") ? std::getenv("FRONTEND_PUBLIC_URL") : "http://localhost:3000");
        const std::string inviteUrl = frontendUrl + "/invite/" + token;
        std::thread([email, inviterName, orgName, role, inviteUrl]() {
            try {
                EmailService::sendOrganizationInvitation(email, inviterName, orgName, role, inviteUrl);
            } catch (const std::exception& e) {
                spdlog::warn("Failed to send invitation email to {}: {}", email, e.what());
            }
        }).detach();

        Json::Value payload;
        payload["message"] = "Invitation sent to " + email + ".";
        payload["invited"] = true;
        payload["token"] = token;
        sendJson(callback, payload, drogon::k201Created);
    } catch (const std::exception& e) {
        spdlog::error("addMember failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to add member");
    }
}

void OrganizationController::updateMemberRole(const drogon::HttpRequestPtr& req,
                                              std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                              std::string organizationId,
                                              std::string memberUserId) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    const auto body = req->getJsonObject();
    if (!body) {
        sendError(callback, drogon::k400BadRequest, "Invalid JSON body");
        return;
    }
    const std::string role = toLower(trim((*body)["role"].asString()));
    if (!Authz::isKnownRole(role)) {
        sendError(callback, drogon::k400BadRequest, "Role must be one of: owner, admin, member, viewer");
        return;
    }

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        if (!Authz::hasOrganizationRole(txn, organizationId, userId, roles::kAdmin)) {
            sendError(callback, drogon::k403Forbidden, "Only admins and owners can change roles");
            return;
        }

        const std::string callerRole = Authz::organizationRole(txn, organizationId, userId);
        const std::string targetRole = Authz::organizationRole(txn, organizationId, memberUserId);
        if (targetRole.empty()) {
            sendError(callback, drogon::k404NotFound, "That user is not a member of this organization");
            return;
        }
        if (Authz::roleRank(targetRole) > Authz::roleRank(callerRole) ||
            Authz::roleRank(role) > Authz::roleRank(callerRole)) {
            sendError(callback, drogon::k403Forbidden, "You cannot change a role at or above your own level");
            return;
        }

        if (targetRole == roles::kOwner && role != roles::kOwner) {
            const auto owners = txn.exec_params(
                "SELECT COUNT(*)::int FROM organization_members WHERE organization_id = $1 AND role = 'owner'",
                organizationId);
            if (owners[0][0].as<int>() <= 1) {
                sendError(callback, drogon::k400BadRequest,
                          "This is the only owner. Promote another member to owner first.");
                return;
            }
        }

        txn.exec_params(
            "UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2",
            organizationId, memberUserId, role
        );
        txn.commit();

        Json::Value meta;
        meta["organization_id"] = organizationId;
        meta["member_user_id"] = memberUserId;
        meta["previous_role"] = targetRole;
        meta["role"] = role;
        AuditLogger::recordFromRequest(req, userId, "organization.member.role_change", "organization", organizationId, meta);

        Json::Value payload;
        payload["message"] = "Role updated";
        payload["member"] = meta;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("updateMemberRole failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to update role");
    }
}

void OrganizationController::removeMember(const drogon::HttpRequestPtr& req,
                                          std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                          std::string organizationId,
                                          std::string memberUserId) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        const bool isSelf = (memberUserId == userId);
        if (!isSelf && !Authz::hasOrganizationRole(txn, organizationId, userId, roles::kAdmin)) {
            sendError(callback, drogon::k403Forbidden, "Only admins and owners can remove members");
            return;
        }

        const std::string targetRole = Authz::organizationRole(txn, organizationId, memberUserId);
        if (targetRole.empty()) {
            sendError(callback, drogon::k404NotFound, "That user is not a member of this organization");
            return;
        }

        const auto personal = txn.exec_params(
            "SELECT is_personal FROM organizations WHERE id = $1", organizationId);
        if (!personal.empty() && personal[0][0].as<bool>()) {
            sendError(callback, drogon::k400BadRequest,
                      "You cannot leave your personal workspace; it holds your own projects.");
            return;
        }

        if (!isSelf) {
            const std::string callerRole = Authz::organizationRole(txn, organizationId, userId);
            if (Authz::roleRank(targetRole) >= Authz::roleRank(callerRole)) {
                sendError(callback, drogon::k403Forbidden, "You cannot remove a member at or above your own level");
                return;
            }
        }

        if (targetRole == roles::kOwner) {
            const auto owners = txn.exec_params(
                "SELECT COUNT(*)::int FROM organization_members WHERE organization_id = $1 AND role = 'owner'",
                organizationId);
            if (owners[0][0].as<int>() <= 1) {
                sendError(callback, drogon::k400BadRequest,
                          "This is the only owner. Promote another member to owner first.");
                return;
            }
        }

        txn.exec_params(
            "DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2",
            organizationId, memberUserId
        );
        txn.commit();

        Json::Value meta;
        meta["organization_id"] = organizationId;
        meta["member_user_id"] = memberUserId;
        meta["removed_role"] = targetRole;
        meta["self_service"] = isSelf;
        AuditLogger::recordFromRequest(req, userId,
                                      isSelf ? "organization.member.leave" : "organization.member.remove",
                                      "organization", organizationId, meta);

        Json::Value payload;
        payload["message"] = isSelf ? "You left the organization" : "Member removed";
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("removeMember failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to remove member");
    }
}

void OrganizationController::listInvitations(const drogon::HttpRequestPtr& req,
                                             std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                             std::string organizationId) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        if (!Authz::hasOrganizationRole(txn, organizationId, userId, roles::kAdmin)) {
            sendError(callback, drogon::k403Forbidden, "Only admins and owners can view pending invitations");
            return;
        }

        const auto rows = txn.exec_params(
            "SELECT i.id, i.organization_id, i.email, i.role, i.token, i.created_at::text AS created_at, "
            "i.expires_at::text AS expires_at, (i.expires_at < NOW()) AS is_expired, "
            "u.username AS inviter_username "
            "FROM organization_invitations i "
            "LEFT JOIN users u ON u.id = i.invited_by "
            "WHERE i.organization_id = $1 "
            "ORDER BY i.created_at DESC",
            organizationId
        );
        txn.commit();

        Json::Value list(Json::arrayValue);
        for (const auto& row : rows) {
            Json::Value inv(Json::objectValue);
            inv["id"] = row["id"].as<std::string>();
            inv["organization_id"] = row["organization_id"].as<std::string>();
            inv["email"] = row["email"].as<std::string>();
            inv["role"] = row["role"].as<std::string>();
            inv["token"] = row["token"].as<std::string>();
            inv["created_at"] = row["created_at"].as<std::string>();
            inv["expires_at"] = row["expires_at"].as<std::string>();
            inv["is_expired"] = row["is_expired"].as<bool>();
            inv["inviter_username"] = row["inviter_username"].is_null() ? "" : row["inviter_username"].as<std::string>();
            list.append(inv);
        }

        Json::Value payload;
        payload["invitations"] = list;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("listInvitations failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to load invitations");
    }
}

void OrganizationController::createInvitation(const drogon::HttpRequestPtr& req,
                                              std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                              std::string organizationId) {
    addMember(req, std::move(callback), organizationId);
}

void OrganizationController::revokeInvitation(const drogon::HttpRequestPtr& req,
                                              std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                              std::string organizationId,
                                              std::string invitationId) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        if (!Authz::hasOrganizationRole(txn, organizationId, userId, roles::kAdmin)) {
            sendError(callback, drogon::k403Forbidden, "Only admins and owners can revoke invitations");
            return;
        }

        txn.exec_params(
            "DELETE FROM organization_invitations WHERE organization_id = $1 AND id = $2",
            organizationId, invitationId
        );
        txn.commit();

        Json::Value payload;
        payload["message"] = "Invitation revoked";
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("revokeInvitation failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to revoke invitation");
    }
}

void OrganizationController::getInviteInfo(const drogon::HttpRequestPtr&,
                                           std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                           std::string token) {
    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        const auto rows = txn.exec_params(
            "SELECT i.id, i.organization_id, i.email, i.role, i.expires_at::text AS expires_at, "
            "o.name AS organization_name, o.slug AS organization_slug, "
            "u.username AS inviter_username "
            "FROM organization_invitations i "
            "JOIN organizations o ON o.id = i.organization_id "
            "LEFT JOIN users u ON u.id = i.invited_by "
            "WHERE i.token = $1 AND i.expires_at > NOW()",
            token
        );
        txn.commit();

        if (rows.empty()) {
            sendError(callback, drogon::k404NotFound, "Invitation not found or expired");
            return;
        }

        Json::Value payload;
        payload["valid"] = true;
        payload["organization_id"] = rows[0]["organization_id"].as<std::string>();
        payload["organization_name"] = rows[0]["organization_name"].as<std::string>();
        payload["organization_slug"] = rows[0]["organization_slug"].as<std::string>();
        payload["email"] = rows[0]["email"].as<std::string>();
        payload["role"] = rows[0]["role"].as<std::string>();
        payload["expires_at"] = rows[0]["expires_at"].as<std::string>();
        payload["inviter_username"] = rows[0]["inviter_username"].is_null() ? "" : rows[0]["inviter_username"].as<std::string>();
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("getInviteInfo failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to retrieve invitation info");
    }
}

void OrganizationController::joinOrganization(const drogon::HttpRequestPtr& req,
                                              std::function<void(const drogon::HttpResponsePtr&)>&& callback,
                                              std::string token) {
    const std::string userId = requireUser(req, callback);
    if (userId.empty()) return;

    try {
        auto conn = Database::getInstance().getConnection();
        pqxx::work txn(*conn);

        const auto rows = txn.exec_params(
            "SELECT i.id, i.organization_id, i.role, i.invited_by, o.name AS organization_name "
            "FROM organization_invitations i "
            "JOIN organizations o ON o.id = i.organization_id "
            "WHERE i.token = $1 AND i.expires_at > NOW()",
            token
        );

        if (rows.empty()) {
            sendError(callback, drogon::k404NotFound, "Invitation not found or expired");
            return;
        }

        const std::string orgId = rows[0]["organization_id"].as<std::string>();
        const std::string role = rows[0]["role"].as<std::string>();
        const std::string orgName = rows[0]["organization_name"].as<std::string>();
        const std::string invitedBy = rows[0]["invited_by"].is_null() ? "" : rows[0]["invited_by"].as<std::string>();

        txn.exec_params(
            "INSERT INTO organization_members (organization_id, user_id, role, invited_by) "
            "VALUES ($1, $2, $3, NULLIF($4, '')::uuid) "
            "ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role",
            orgId, userId, role, invitedBy
        );

        txn.exec_params("DELETE FROM organization_invitations WHERE token = $1", token);
        txn.commit();

        Json::Value meta;
        meta["organization_id"] = orgId;
        meta["role"] = role;
        AuditLogger::recordFromRequest(req, userId, "organization.member.join", "organization", orgId, meta);

        Json::Value payload;
        payload["message"] = "Joined " + orgName + " successfully";
        payload["organization_id"] = orgId;
        payload["organization_name"] = orgName;
        payload["role"] = role;
        sendJson(callback, payload);
    } catch (const std::exception& e) {
        spdlog::error("joinOrganization failed: {}", e.what());
        sendError(callback, drogon::k500InternalServerError, "Failed to join organization");
    }
}

}  // namespace stackpilot
