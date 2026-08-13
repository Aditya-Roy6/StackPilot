// ============================================================
// CostModel.cpp
// ============================================================

#include "CostModel.h"

#include "../utils/StringUtils.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <sstream>

namespace stackpilot {
namespace {

using strings::getEnvOrDefault;
using strings::toLower;
using strings::trim;

int64_t envInt64(const char* name, int64_t fallback) {
    const std::string raw = getEnvOrDefault(name, "");
    if (raw.empty()) return fallback;
    try {
        const long long parsed = std::stoll(raw);
        return parsed > 0 ? parsed : fallback;
    } catch (...) {
        return fallback;
    }
}

/// Splits a Kubernetes quantity into its numeric part and unit suffix.
std::pair<double, std::string> splitQuantity(const std::string& raw) {
    const std::string value = trim(raw);
    size_t i = 0;
    while (i < value.size() && (std::isdigit(static_cast<unsigned char>(value[i])) || value[i] == '.')) {
        ++i;
    }
    if (i == 0) return {0.0, ""};
    try {
        return {std::stod(value.substr(0, i)), value.substr(i)};
    } catch (...) {
        return {0.0, ""};
    }
}

}  // namespace

ResourceRate CostModel::rateCard() {
    // ~$0.03 per core-hour and ~$0.004 per GiB-hour, in millicents.
    return ResourceRate{
        envInt64("STACKPILOT_COST_CPU_CORE_HOUR_MILLICENTS", 3000),
        envInt64("STACKPILOT_COST_MEMORY_GIB_HOUR_MILLICENTS", 400),
    };
}

ResourceShape CostModel::shapeForPreset(const std::string& preset) {
    const std::string normalized = toLower(trim(preset));
    if (normalized == "medium") return {250, 256};
    if (normalized == "large")  return {500, 512};
    // Unknown or empty falls through to small. Never zero: a typo in a preset
    // name must not make a running service appear free.
    return {100, 128};
}

int CostModel::parseCpuMillicores(const std::string& quantity) {
    const auto [number, unit] = splitQuantity(quantity);
    if (number <= 0.0) return 0;
    if (unit == "m") {
        return static_cast<int>(number);
    }
    if (unit.empty()) {
        // A bare number is whole cores.
        return static_cast<int>(number * 1000.0);
    }
    return 0;
}

int CostModel::parseMemoryMb(const std::string& quantity) {
    const auto [number, unit] = splitQuantity(quantity);
    if (number <= 0.0) return 0;
    // Kubernetes binary suffixes (Mi, Gi) and decimal ones (M, G) are not the
    // same size, and conflating them under-reports memory by ~7% per level.
    if (unit == "Mi") return static_cast<int>(number);
    if (unit == "Gi") return static_cast<int>(number * 1024.0);
    if (unit == "Ki") return static_cast<int>(number / 1024.0);
    if (unit == "M")  return static_cast<int>(number * 1000.0 / 1024.0);
    if (unit == "G")  return static_cast<int>(number * 1000.0 * 1000.0 / 1024.0 / 1024.0);
    if (unit.empty()) return static_cast<int>(number / 1024.0 / 1024.0);  // bytes
    return 0;
}

int64_t CostModel::accrueMillicents(const ResourceShape& shape,
                                    int replicas,
                                    int seconds,
                                    const ResourceRate& rate) {
    if (seconds <= 0 || replicas <= 0) return 0;

    const int64_t effectiveReplicas = std::max(1, replicas);
    const int64_t cpuMillicores = static_cast<int64_t>(std::max(0, shape.cpuMillicores)) * effectiveReplicas;
    const int64_t memoryMb = static_cast<int64_t>(std::max(0, shape.memoryMb)) * effectiveReplicas;

    // Integer arithmetic throughout, multiplying before dividing so small
    // shapes over short windows do not truncate to zero. A 100m container
    // sampled for 60s is worth 5 millicents; naive division would call it free
    // and a long-lived preview would accumulate nothing at all.
    const int64_t cpuCost = (cpuMillicores * static_cast<int64_t>(seconds) * rate.cpuCoreHourMillicents)
                            / (1000LL * 3600LL);
    const int64_t memCost = (memoryMb * static_cast<int64_t>(seconds) * rate.memoryGibHourMillicents)
                            / (1024LL * 3600LL);
    return cpuCost + memCost;
}

std::string CostModel::formatMillicents(int64_t millicents) {
    const bool negative = millicents < 0;
    const int64_t absolute = negative ? -millicents : millicents;
    // A millicent is one thousandth of a cent, so $1 is 100,000 millicents.
    // Dividing by 100 here (as this did originally) rendered every total ten
    // times too large, which is the kind of error that survives review because
    // the number still looks like money.
    //
    // Round to the nearest cent rather than truncating, so a displayed total
    // does not drift downward against the stored one.
    const int64_t cents = (absolute + 500) / 1000;

    std::ostringstream out;
    if (negative) out << "-";
    out << "$" << (cents / 100) << ".";
    const int64_t remainder = cents % 100;
    if (remainder < 10) out << "0";
    out << remainder;
    return out.str();
}

}  // namespace stackpilot
