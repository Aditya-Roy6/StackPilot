// ============================================================
// CostModel.h — what a deployment costs while it runs
// ============================================================
// This is attribution, not billing. Nobody is invoiced from these numbers;
// they answer "which project is eating the cluster" and "is that preview
// environment from three weeks ago still running". Being roughly right and
// clearly explained beats being precisely wrong.
//
// Two deliberate choices:
//
// Money is integer millicents throughout. Floating-point currency is a bug
// waiting for a big enough number, and cents alone lose too much precision
// when a sample covers 60 seconds of a $0.02/hour container.
//
// Cost is derived from *requested* resources, not observed usage. A pod
// requesting 500m CPU holds that reservation whether or not it uses it — the
// cluster cannot give it to anyone else. Charging for observed usage would
// tell a team their idle over-provisioned service is free, which is the
// opposite of the message that makes them fix it.

#pragma once

#include <cstdint>
#include <string>

namespace stackpilot {

struct ResourceRate {
    /// Millicents per CPU-core-hour.
    int64_t cpuCoreHourMillicents;
    /// Millicents per GiB-hour of memory.
    int64_t memoryGibHourMillicents;
};

struct ResourceShape {
    int cpuMillicores = 0;
    int memoryMb = 0;
};

class CostModel {
public:
    /// Default rate card, overridable with STACKPILOT_COST_CPU_CORE_HOUR_MILLICENTS
    /// and STACKPILOT_COST_MEMORY_GIB_HOUR_MILLICENTS. The defaults approximate
    /// commodity cloud compute; a self-hosted operator should set their own.
    static ResourceRate rateCard();

    /// The CPU and memory a preset reserves per replica. Mirrors
    /// KubernetesService::resourcePresetFor — an unknown preset is treated as
    /// "small" rather than free, so a typo cannot make a service look costless.
    static ResourceShape shapeForPreset(const std::string& preset);

    /// Parses a Kubernetes CPU quantity ("500m", "2") into millicores.
    /// Returns 0 for anything unparseable.
    static int parseCpuMillicores(const std::string& quantity);

    /// Parses a Kubernetes memory quantity ("512Mi", "2Gi", "1024M") into MB.
    /// Returns 0 for anything unparseable.
    static int parseMemoryMb(const std::string& quantity);

    /// Cost of holding `shape` x `replicas` for `seconds`.
    static int64_t accrueMillicents(const ResourceShape& shape,
                                    int replicas,
                                    int seconds,
                                    const ResourceRate& rate);

    /// Formats millicents for display: 1234567 -> "$12.35".
    static std::string formatMillicents(int64_t millicents);
};

}  // namespace stackpilot
