// ============================================================
// Authz.cpp
// ============================================================

#include "Authz.h"

#include "StringUtils.h"

namespace stackpilot {
namespace {

using strings::toLower;
using strings::trim;

}  // namespace

int Authz::roleRank(const std::string& role) {
    const std::string normalized = toLower(trim(role));
    if (normalized == roles::kOwner)  return 4;
    if (normalized == roles::kAdmin)  return 3;
    if (normalized == roles::kMember) return 2;
    if (normalized == roles::kViewer) return 1;
    return 0;  // unknown, empty, or a role from a newer schema
}

bool Authz::roleAtLeast(const std::string& role, const std::string& minimum) {
    const int have = roleRank(role);
    // An unrecognised minimum would otherwise rank 0 and let everything past.
    // Requiring an unknown role is a programming error, and the safe reading of
    // it is "nobody qualifies".
    const int need = roleRank(minimum);
    if (need == 0) return false;
    return have >= need;
}

bool Authz::isKnownRole(const std::string& role) {
    return roleRank(role) > 0;
}

std::string Authz::projectRole(pqxx::transaction_base& txn,
                               const std::string& projectId,
                               const std::string& userId) {
    if (trim(projectId).empty() || trim(userId).empty()) {
        return "";
    }
    const auto rows = txn.exec_params(
        "SELECT COALESCE(project_role($1::uuid, $2::uuid), '')",
        projectId,
        userId
    );
    return rows.empty() ? "" : rows[0][0].as<std::string>();
}

bool Authz::hasProjectRole(pqxx::transaction_base& txn,
                           const std::string& projectId,
                           const std::string& userId,
                           const std::string& minimum) {
    return roleAtLeast(projectRole(txn, projectId, userId), minimum);
}

std::string Authz::organizationRole(pqxx::transaction_base& txn,
                                    const std::string& organizationId,
                                    const std::string& userId) {
    if (trim(organizationId).empty() || trim(userId).empty()) {
        return "";
    }
    const auto rows = txn.exec_params(
        "SELECT role FROM organization_members WHERE organization_id = $1::uuid AND user_id = $2::uuid",
        organizationId,
        userId
    );
    return rows.empty() ? "" : rows[0][0].as<std::string>();
}

bool Authz::hasOrganizationRole(pqxx::transaction_base& txn,
                                const std::string& organizationId,
                                const std::string& userId,
                                const std::string& minimum) {
    return roleAtLeast(organizationRole(txn, organizationId, userId), minimum);
}

}  // namespace stackpilot
