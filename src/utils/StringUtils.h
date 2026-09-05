// ============================================================
// StringUtils.h — shared string helpers
// ============================================================
// These were previously redefined in every translation unit that needed them:
// `trim` existed 19 times, `toLower` 10, `shellQuote` 8, `getEnvOrDefault` and
// `compactJson` 6 each. Identical logic copied per file means a fix (or a
// security hardening, in shellQuote's case) has to be applied 19 times and
// silently rots wherever it is missed.
//
// Declared inline so existing call sites need no change beyond the include.
// ============================================================

#pragma once

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <sstream>
#include <string>
#include <vector>

#include <json/json.h>

namespace stackpilot {
namespace strings {

inline std::string trim(const std::string& value) {
    const auto begin = value.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(begin, end - begin + 1);
}

inline std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

inline std::string toUpper(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return value;
}

/// Single-quote a value for safe use inside a shell command.
/// Every shell-out in the platform depends on this being correct, which is
/// precisely why there should be exactly one copy of it.
inline std::string shellQuote(const std::string& value) {
    std::string quoted = "'";
    for (const char c : value) {
        if (c == '\'') {
            quoted += "'\\''";  // close, escaped quote, reopen
        } else {
            quoted += c;
        }
    }
    quoted += "'";
    return quoted;
}

inline std::string getEnvOrDefault(const char* name, const std::string& fallback) {
    const char* value = std::getenv(name);
    return (value && *value) ? value : fallback;
}

inline bool isTruthy(const std::string& value) {
    const std::string normalized = toLower(trim(value));
    return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on";
}

inline bool startsWith(const std::string& value, const std::string& prefix) {
    return value.rfind(prefix, 0) == 0;
}

inline std::vector<std::string> splitCsv(const std::string& value) {
    std::vector<std::string> entries;
    std::string current;
    for (const char c : value) {
        if (c == ',') {
            const std::string entry = trim(current);
            if (!entry.empty()) {
                entries.push_back(entry);
            }
            current.clear();
        } else {
            current += c;
        }
    }
    const std::string last = trim(current);
    if (!last.empty()) {
        entries.push_back(last);
    }
    return entries;
}

/// Serialise JSON without indentation — the form used for DB columns and
/// outbound request bodies.
inline std::string compactJson(const Json::Value& value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

inline Json::Value parseJsonObject(const std::string& raw) {
    if (trim(raw).empty()) {
        return Json::Value(Json::objectValue);
    }
    Json::Value parsed;
    Json::CharReaderBuilder builder;
    std::string errors;
    std::istringstream stream(raw);
    if (!Json::parseFromStream(builder, stream, &parsed, &errors) || !parsed.isObject()) {
        return Json::Value(Json::objectValue);
    }
    return parsed;
}

inline bool isTrustedProxy(const std::string& ipStr) {
    if (ipStr.empty()) {
        return false;
    }
    if (ipStr == "127.0.0.1" || ipStr == "::1" || ipStr == "localhost") {
        return true;
    }
    std::string ip = ipStr;
    const std::string v6Prefix = "::ffff:";
    if (ip.rfind(v6Prefix, 0) == 0) {
        ip = ip.substr(v6Prefix.size());
    }

    unsigned int a = 0, b = 0, c = 0, d = 0;
    char dot1 = 0, dot2 = 0, dot3 = 0;
    std::istringstream iss(ip);
    if ((iss >> a >> dot1 >> b >> dot2 >> c >> dot3 >> d) &&
        dot1 == '.' && dot2 == '.' && dot3 == '.' &&
        a <= 255 && b <= 255 && c <= 255 && d <= 255 &&
        iss.eof()) {
        if (a == 127) return true;
        if (a == 10) return true;
        if (a == 172 && b >= 16 && b <= 31) return true;
        if (a == 192 && b == 168) return true;
    }
    return false;
}

} // namespace strings
} // namespace stackpilot
