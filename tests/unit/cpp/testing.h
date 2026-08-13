// ============================================================
// testing.h — minimal assertion framework for the unit suite
// ============================================================
// Deliberately not GoogleTest. The builder image (drogonframework/drogon)
// ships no gtest, and pulling it in would add an apt fetch to every backend
// image build for a suite this small. If the suite grows past a few hundred
// assertions, or starts needing mocks, swap this out for gtest and delete
// this file — the TEST()/EXPECT_* names are chosen to make that mechanical.

#pragma once

#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace stackpilot::testing {

struct TestCase {
    std::string suite;
    std::string name;
    std::function<void()> body;
};

inline std::vector<TestCase>& registry() {
    static std::vector<TestCase> cases;
    return cases;
}

/// Thrown by the EXPECT_* macros. Caught per test so one failure does not
/// abort the run.
struct AssertionFailure {
    std::string message;
};

struct Registrar {
    Registrar(const char* suite, const char* name, std::function<void()> body) {
        registry().push_back({suite, name, std::move(body)});
    }
};

/// Renders a value for failure output. Overloaded rather than templated on
/// operator<< so bool prints as true/false and strings print quoted.
inline std::string show(const std::string& v) { return "\"" + v + "\""; }
inline std::string show(const char* v) { return std::string("\"") + v + "\""; }
inline std::string show(bool v) { return v ? "true" : "false"; }
template <typename T>
std::string show(const T& v) {
    std::ostringstream out;
    out << v;
    return out.str();
}

inline int run() {
    int passed = 0;
    std::vector<std::string> failures;

    for (const auto& test : registry()) {
        const std::string label = test.suite + "." + test.name;
        try {
            test.body();
            ++passed;
            std::cout << "  PASS  " << label << "\n";
        } catch (const AssertionFailure& failure) {
            failures.push_back(label + "\n          " + failure.message);
            std::cout << "  FAIL  " << label << "\n          " << failure.message << "\n";
        } catch (const std::exception& e) {
            failures.push_back(label + "\n          threw std::exception: " + e.what());
            std::cout << "  FAIL  " << label << "\n          threw: " << e.what() << "\n";
        } catch (...) {
            failures.push_back(label + "\n          threw a non-std exception");
            std::cout << "  FAIL  " << label << "  (non-std exception)\n";
        }
    }

    std::cout << "\n----------------------------------------------------\n";
    std::cout << passed << " passed, " << failures.size() << " failed, "
              << registry().size() << " total\n";
    return failures.empty() ? 0 : 1;
}

}  // namespace stackpilot::testing

#define STACKPILOT_CONCAT_INNER(a, b) a##b
#define STACKPILOT_CONCAT(a, b) STACKPILOT_CONCAT_INNER(a, b)

#define TEST(suite, name)                                                        \
    static void STACKPILOT_CONCAT(stackpilot_test_, __LINE__)();                 \
    static ::stackpilot::testing::Registrar STACKPILOT_CONCAT(stackpilot_reg_,   \
                                                              __LINE__)(         \
        #suite, #name, STACKPILOT_CONCAT(stackpilot_test_, __LINE__));           \
    static void STACKPILOT_CONCAT(stackpilot_test_, __LINE__)()

#define STACKPILOT_FAIL(msg)                                                     \
    throw ::stackpilot::testing::AssertionFailure {                              \
        std::string(__FILE__) + ":" + std::to_string(__LINE__) + " — " + (msg)   \
    }

#define EXPECT_EQ(actual, expected)                                              \
    do {                                                                         \
        const auto& a_ = (actual);                                               \
        const auto& e_ = (expected);                                             \
        if (!(a_ == e_)) {                                                       \
            STACKPILOT_FAIL("expected " #actual " == " #expected                 \
                            "\n          actual:   " +                           \
                            ::stackpilot::testing::show(a_) +                    \
                            "\n          expected: " +                           \
                            ::stackpilot::testing::show(e_));                    \
        }                                                                        \
    } while (0)

#define EXPECT_TRUE(expr)                                                        \
    do {                                                                         \
        if (!(expr)) STACKPILOT_FAIL("expected " #expr " to be true");           \
    } while (0)

#define EXPECT_FALSE(expr)                                                       \
    do {                                                                         \
        if ((expr)) STACKPILOT_FAIL("expected " #expr " to be false");           \
    } while (0)

#define EXPECT_CONTAINS(haystack, needle)                                        \
    do {                                                                         \
        const std::string h_ = (haystack);                                       \
        const std::string n_ = (needle);                                         \
        if (h_.find(n_) == std::string::npos) {                                  \
            STACKPILOT_FAIL("expected " #haystack " to contain " +               \
                            ::stackpilot::testing::show(n_));                    \
        }                                                                        \
    } while (0)

#define EXPECT_NOT_CONTAINS(haystack, needle)                                    \
    do {                                                                         \
        const std::string h_ = (haystack);                                       \
        const std::string n_ = (needle);                                         \
        if (h_.find(n_) != std::string::npos) {                                  \
            STACKPILOT_FAIL("expected " #haystack " NOT to contain " +           \
                            ::stackpilot::testing::show(n_));                    \
        }                                                                        \
    } while (0)
