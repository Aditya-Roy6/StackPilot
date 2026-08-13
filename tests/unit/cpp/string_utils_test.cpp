// Unit tests for src/utils/StringUtils.h.
//
// These helpers were duplicated across 19 translation units before being
// consolidated. Now that there is exactly one copy, shellQuote in particular
// is on the path of every shell-out the platform performs — a regression here
// is a command injection, not a formatting bug.

#include "testing.h"

#include "../../../src/utils/StringUtils.h"

#include <cstdlib>

using namespace stackpilot::strings;

// ─── trim ───────────────────────────────────────────────────────

TEST(Trim, StripsSurroundingWhitespace) {
    EXPECT_EQ(trim("  hello  "), "hello");
}

TEST(Trim, StripsTabsCarriageReturnsAndNewlines) {
    EXPECT_EQ(trim("\t\r\n value \n\r\t"), "value");
}

TEST(Trim, PreservesInteriorWhitespace) {
    EXPECT_EQ(trim("  a  b  "), "a  b");
}

TEST(Trim, AllWhitespaceBecomesEmpty) {
    EXPECT_EQ(trim(" \t\r\n "), "");
}

TEST(Trim, EmptyInputStaysEmpty) {
    EXPECT_EQ(trim(""), "");
}

TEST(Trim, LeavesCleanInputUntouched) {
    EXPECT_EQ(trim("clean"), "clean");
}

// ─── shellQuote ─────────────────────────────────────────────────

TEST(ShellQuote, WrapsPlainValueInSingleQuotes) {
    EXPECT_EQ(shellQuote("hello"), "'hello'");
}

TEST(ShellQuote, NeutralisesEmbeddedSingleQuote) {
    // The close/escape/reopen dance: ' -> '\''
    EXPECT_EQ(shellQuote("it's"), "'it'\\''s'");
}

TEST(ShellQuote, ContainsCommandSubstitutionAttempt) {
    // The payload must survive as literal text, never as a second command.
    // The invariant that matters is not "the dangerous substring is absent" —
    // it is still there, harmlessly, inside the quoting. What matters is that
    // every single quote in the *input* is emitted as the four-character
    // escape '\'' and never as a bare quote that would close the argument.
    EXPECT_EQ(shellQuote("x'; rm -rf /; echo '"),
              "'x'\\''; rm -rf /; echo '\\'''");
}

TEST(ShellQuote, EveryQuoteInTheOutputIsPartOfAWellFormedEscape) {
    // Structural check over a range of hostile inputs: walking the output must
    // never leave quoted context except at the very end. If it does, the
    // remainder of the string would be interpreted by the shell.
    const char* inputs[] = {
        "plain", "it's", "''", "'", "a'b'c", "x'; rm -rf /; echo '",
        "$(id)", "`id`", "a\nb", "--flag=value with spaces",
    };
    for (const char* input : inputs) {
        const std::string quoted = shellQuote(input);
        bool inQuotes = false;
        size_t i = 0;
        while (i < quoted.size()) {
            if (quoted[i] == '\'') {
                inQuotes = !inQuotes;
                ++i;
            } else if (!inQuotes && quoted[i] == '\\' && i + 1 < quoted.size() &&
                       quoted[i + 1] == '\'') {
                // The escaped literal quote between the closed and reopened runs.
                i += 2;
            } else if (!inQuotes) {
                STACKPILOT_FAIL(std::string("input ") + ::stackpilot::testing::show(input) +
                                " produced unquoted character at offset " +
                                std::to_string(i) + " in " +
                                ::stackpilot::testing::show(quoted));
            } else {
                ++i;
            }
        }
        if (inQuotes) {
            STACKPILOT_FAIL(std::string("input ") + ::stackpilot::testing::show(input) +
                            " produced an unterminated quote: " +
                            ::stackpilot::testing::show(quoted));
        }
    }
}

TEST(ShellQuote, LeavesDollarAndBacktickInert) {
    // Single quotes are literal in POSIX sh, so these need no extra escaping —
    // this test exists to catch a future "improvement" to double quotes.
    EXPECT_EQ(shellQuote("$(whoami)"), "'$(whoami)'");
    EXPECT_EQ(shellQuote("`id`"), "'`id`'");
}

TEST(ShellQuote, EmptyValueIsStillAQuotedEmptyArgument) {
    EXPECT_EQ(shellQuote(""), "''");
}

// ─── case helpers ───────────────────────────────────────────────

TEST(Case, ToLowerAndToUpper) {
    EXPECT_EQ(toLower("MiXeD-123"), "mixed-123");
    EXPECT_EQ(toUpper("MiXeD-123"), "MIXED-123");
}

TEST(Case, HandlesHighBytesWithoutUndefinedBehaviour) {
    // std::tolower on a negative char is UB; the helper casts to unsigned char.
    const std::string input("caf\xC3\xA9");
    EXPECT_EQ(toLower(input).size(), input.size());
}

// ─── isTruthy ───────────────────────────────────────────────────

TEST(IsTruthy, AcceptsTheDocumentedTruthyForms) {
    EXPECT_TRUE(isTruthy("1"));
    EXPECT_TRUE(isTruthy("true"));
    EXPECT_TRUE(isTruthy("TRUE"));
    EXPECT_TRUE(isTruthy(" yes "));
    EXPECT_TRUE(isTruthy("On"));
}

TEST(IsTruthy, RejectsEverythingElse) {
    EXPECT_FALSE(isTruthy("0"));
    EXPECT_FALSE(isTruthy("false"));
    EXPECT_FALSE(isTruthy(""));
    EXPECT_FALSE(isTruthy("maybe"));
    // "truthy-ish" strings must not be accepted — a config value of "truest"
    // should not silently enable a production flag.
    EXPECT_FALSE(isTruthy("truest"));
}

// ─── startsWith ─────────────────────────────────────────────────

TEST(StartsWith, MatchesOnlyAtPositionZero) {
    EXPECT_TRUE(startsWith("https://example.com", "https://"));
    EXPECT_FALSE(startsWith("http://example.com", "https://"));
    // A prefix appearing later must not match — this guards the HTTPS check
    // in main.cpp against URLs like "http://x/https://".
    EXPECT_FALSE(startsWith("http://x/https://", "https://"));
}

TEST(StartsWith, EmptyPrefixAlwaysMatches) {
    EXPECT_TRUE(startsWith("anything", ""));
}

TEST(StartsWith, PrefixLongerThanValueDoesNotMatch) {
    EXPECT_FALSE(startsWith("ab", "abc"));
}

// ─── splitCsv ───────────────────────────────────────────────────

TEST(SplitCsv, SplitsAndTrimsEachEntry) {
    const auto parts = splitCsv("a, b ,c");
    EXPECT_EQ(parts.size(), static_cast<size_t>(3));
    EXPECT_EQ(parts[0], "a");
    EXPECT_EQ(parts[1], "b");
    EXPECT_EQ(parts[2], "c");
}

TEST(SplitCsv, DropsEmptyEntries) {
    // CORS_ALLOWED_ORIGIN with a trailing comma must not yield an empty origin,
    // which would compare equal to a missing Origin header.
    const auto parts = splitCsv("http://localhost:3000,,");
    EXPECT_EQ(parts.size(), static_cast<size_t>(1));
    EXPECT_EQ(parts[0], "http://localhost:3000");
}

TEST(SplitCsv, EmptyInputYieldsNoEntries) {
    EXPECT_EQ(splitCsv("").size(), static_cast<size_t>(0));
    EXPECT_EQ(splitCsv("  ,  ").size(), static_cast<size_t>(0));
}

TEST(SplitCsv, SingleEntryWithoutSeparator) {
    const auto parts = splitCsv("  solo  ");
    EXPECT_EQ(parts.size(), static_cast<size_t>(1));
    EXPECT_EQ(parts[0], "solo");
}

// ─── getEnvOrDefault ────────────────────────────────────────────

TEST(GetEnvOrDefault, FallsBackWhenUnsetOrEmpty) {
    ::unsetenv("STACKPILOT_UNIT_TEST_VAR");
    EXPECT_EQ(getEnvOrDefault("STACKPILOT_UNIT_TEST_VAR", "fallback"), "fallback");

    // An explicitly empty variable must behave as unset, otherwise an empty
    // value in a .env file silently blanks a required setting.
    ::setenv("STACKPILOT_UNIT_TEST_VAR", "", 1);
    EXPECT_EQ(getEnvOrDefault("STACKPILOT_UNIT_TEST_VAR", "fallback"), "fallback");

    ::setenv("STACKPILOT_UNIT_TEST_VAR", "set", 1);
    EXPECT_EQ(getEnvOrDefault("STACKPILOT_UNIT_TEST_VAR", "fallback"), "set");
    ::unsetenv("STACKPILOT_UNIT_TEST_VAR");
}

// ─── JSON helpers ───────────────────────────────────────────────

TEST(CompactJson, EmitsNoIndentationOrTrailingNewline) {
    Json::Value value(Json::objectValue);
    value["a"] = 1;
    const std::string encoded = compactJson(value);
    EXPECT_NOT_CONTAINS(encoded, "\n");
    EXPECT_NOT_CONTAINS(encoded, "\t");
    EXPECT_CONTAINS(encoded, "\"a\"");
}

TEST(ParseJsonObject, ParsesAnObject) {
    const Json::Value parsed = parseJsonObject("{\"k\":\"v\"}");
    EXPECT_TRUE(parsed.isObject());
    EXPECT_EQ(parsed["k"].asString(), std::string("v"));
}

TEST(ParseJsonObject, MalformedInputYieldsEmptyObjectNotAThrow) {
    // Callers store the result straight into a jsonb column; a throw here
    // would surface as a 500 on rows with legacy data.
    const Json::Value parsed = parseJsonObject("{not json");
    EXPECT_TRUE(parsed.isObject());
    EXPECT_EQ(parsed.getMemberNames().size(), static_cast<size_t>(0));
}

TEST(ParseJsonObject, NonObjectJsonIsRejected) {
    // A bare array or scalar is valid JSON but not a valid config blob.
    EXPECT_EQ(parseJsonObject("[1,2,3]").getMemberNames().size(), static_cast<size_t>(0));
    EXPECT_EQ(parseJsonObject("\"str\"").getMemberNames().size(), static_cast<size_t>(0));
}

TEST(ParseJsonObject, BlankInputYieldsEmptyObject) {
    EXPECT_TRUE(parseJsonObject("").isObject());
    EXPECT_TRUE(parseJsonObject("   \n ").isObject());
}
