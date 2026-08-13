// Unit tests for the pure half of src/utils/Authz.cpp.
//
// Role comparison decides who can read a database password and who can delete
// a project. It is four lines of code, which is exactly why it deserves tests:
// the failure mode is not a crash, it is a quiet "yes" to someone who should
// have been told no.
//
// The database-backed members (projectRole, hasProjectRole) are thin wrappers
// over the SQL function has_project_access(); those are covered by
// tests/integration/test_platform.py against a real schema.

#include "testing.h"

#include "../../../src/utils/Authz.h"

using namespace stackpilot;

// ─── ordering ───────────────────────────────────────────────────

TEST(RoleRank, IsStrictlyOrdered) {
    EXPECT_TRUE(Authz::roleRank(roles::kOwner) > Authz::roleRank(roles::kAdmin));
    EXPECT_TRUE(Authz::roleRank(roles::kAdmin) > Authz::roleRank(roles::kMember));
    EXPECT_TRUE(Authz::roleRank(roles::kMember) > Authz::roleRank(roles::kViewer));
    EXPECT_TRUE(Authz::roleRank(roles::kViewer) > 0);
}

TEST(RoleRank, UnknownRolesRankBelowViewer) {
    // A role from a newer schema, a typo, or a tampered value must not
    // accidentally outrank a real one.
    EXPECT_EQ(Authz::roleRank(""), 0);
    EXPECT_EQ(Authz::roleRank("superuser"), 0);
    EXPECT_EQ(Authz::roleRank("root"), 0);
    EXPECT_EQ(Authz::roleRank("Owner!"), 0);
}

TEST(RoleRank, IsCaseAndWhitespaceInsensitive) {
    // Roles arrive from JSON bodies and database columns; neither guarantees
    // canonical form.
    EXPECT_EQ(Authz::roleRank("OWNER"), Authz::roleRank("owner"));
    EXPECT_EQ(Authz::roleRank("  Admin  "), Authz::roleRank("admin"));
}

// ─── roleAtLeast ────────────────────────────────────────────────

TEST(RoleAtLeast, HigherRolesSatisfyLowerRequirements) {
    EXPECT_TRUE(Authz::roleAtLeast(roles::kOwner, roles::kViewer));
    EXPECT_TRUE(Authz::roleAtLeast(roles::kOwner, roles::kAdmin));
    EXPECT_TRUE(Authz::roleAtLeast(roles::kAdmin, roles::kMember));
    EXPECT_TRUE(Authz::roleAtLeast(roles::kMember, roles::kViewer));
}

TEST(RoleAtLeast, EqualRolesSatisfyTheRequirement) {
    EXPECT_TRUE(Authz::roleAtLeast(roles::kViewer, roles::kViewer));
    EXPECT_TRUE(Authz::roleAtLeast(roles::kMember, roles::kMember));
    EXPECT_TRUE(Authz::roleAtLeast(roles::kOwner, roles::kOwner));
}

TEST(RoleAtLeast, LowerRolesDoNotSatisfyHigherRequirements) {
    EXPECT_FALSE(Authz::roleAtLeast(roles::kViewer, roles::kMember));
    EXPECT_FALSE(Authz::roleAtLeast(roles::kMember, roles::kAdmin));
    EXPECT_FALSE(Authz::roleAtLeast(roles::kAdmin, roles::kOwner));
}

TEST(RoleAtLeast, AViewerCannotRevealASecret) {
    // The concrete decision this exists for: reveal requires member.
    EXPECT_FALSE(Authz::roleAtLeast(roles::kViewer, roles::kMember));
    EXPECT_TRUE(Authz::roleAtLeast(roles::kMember, roles::kMember));
}

TEST(RoleAtLeast, AMemberCannotDeleteAProject) {
    // Deleting requires admin, so a member who can deploy still cannot destroy.
    EXPECT_FALSE(Authz::roleAtLeast(roles::kMember, roles::kAdmin));
    EXPECT_TRUE(Authz::roleAtLeast(roles::kAdmin, roles::kAdmin));
}

TEST(RoleAtLeast, NoRoleSatisfiesNothing) {
    // A non-member has an empty role and must fail every check, including the
    // lowest one.
    EXPECT_FALSE(Authz::roleAtLeast("", roles::kViewer));
    EXPECT_FALSE(Authz::roleAtLeast("", roles::kMember));
    EXPECT_FALSE(Authz::roleAtLeast("", roles::kOwner));
}

TEST(RoleAtLeast, AnUnknownHeldRoleGrantsNothing) {
    EXPECT_FALSE(Authz::roleAtLeast("superuser", roles::kViewer));
}

TEST(RoleAtLeast, AnUnknownRequirementGrantsNothingRatherThanEverything) {
    // The dangerous direction. If an unknown minimum ranked 0, every caller
    // would clear it — including an owner check misspelled as "owners". Asking
    // for a role that does not exist must deny, not open the door.
    EXPECT_FALSE(Authz::roleAtLeast(roles::kOwner, "owners"));
    EXPECT_FALSE(Authz::roleAtLeast(roles::kOwner, ""));
    EXPECT_FALSE(Authz::roleAtLeast(roles::kOwner, "superuser"));
}

// ─── isKnownRole ────────────────────────────────────────────────

TEST(IsKnownRole, AcceptsExactlyTheFourRoles) {
    EXPECT_TRUE(Authz::isKnownRole(roles::kOwner));
    EXPECT_TRUE(Authz::isKnownRole(roles::kAdmin));
    EXPECT_TRUE(Authz::isKnownRole(roles::kMember));
    EXPECT_TRUE(Authz::isKnownRole(roles::kViewer));
}

TEST(IsKnownRole, RejectsEverythingElse) {
    // This gates the role field on the add-member endpoint, so it is the last
    // thing standing between a request body and the CHECK constraint.
    EXPECT_FALSE(Authz::isKnownRole(""));
    EXPECT_FALSE(Authz::isKnownRole("god"));
    EXPECT_FALSE(Authz::isKnownRole("owner; DROP TABLE users"));
}
