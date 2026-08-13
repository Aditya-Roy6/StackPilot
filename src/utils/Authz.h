// ============================================================
// Authz.h — organization roles and project access
// ============================================================
// The SQL function has_project_access() is the primary gate: it lives inside
// the query, so a handler cannot forget it and still return rows. This header
// covers the cases SQL cannot — deciding *which* minimum role an operation
// needs, and reporting a useful error when the caller falls short.
//
// Role order is viewer < member < admin < owner:
//   viewer  read everything in the organization
//   member  create and deploy projects, read and write secrets
//   admin   manage members, delete projects
//   owner   everything, including deleting the organization
//
// Secret *reveal* deliberately requires member rather than viewer. A viewer is
// someone shown the shape of the system; handing them the database password
// would make the distinction meaningless.

#pragma once

#include <pqxx/pqxx>
#include <string>

namespace stackpilot {

namespace roles {
inline constexpr const char* kViewer = "viewer";
inline constexpr const char* kMember = "member";
inline constexpr const char* kAdmin  = "admin";
inline constexpr const char* kOwner  = "owner";
}  // namespace roles

class Authz {
public:
    /// Numeric rank for comparison. Unknown roles rank 0 — below viewer — so a
    /// typo or a role from a newer schema denies rather than grants.
    static int roleRank(const std::string& role);

    /// True when `role` is at least `minimum`.
    static bool roleAtLeast(const std::string& role, const std::string& minimum);

    static bool isKnownRole(const std::string& role);

    /// The caller's role on a project, or "" when they have none.
    static std::string projectRole(pqxx::transaction_base& txn,
                                   const std::string& projectId,
                                   const std::string& userId);

    /// True when the caller holds at least `minimum` on the project.
    static bool hasProjectRole(pqxx::transaction_base& txn,
                               const std::string& projectId,
                               const std::string& userId,
                               const std::string& minimum);

    /// The caller's role in an organization, or "" when they are not a member.
    static std::string organizationRole(pqxx::transaction_base& txn,
                                        const std::string& organizationId,
                                        const std::string& userId);

    static bool hasOrganizationRole(pqxx::transaction_base& txn,
                                    const std::string& organizationId,
                                    const std::string& userId,
                                    const std::string& minimum);
};

}  // namespace stackpilot
