// Unit tests for src/services/CostModel.cpp.
//
// The failure mode here is not a crash — it is a number that looks plausible
// and is wrong. Cost attribution nobody can check is cost attribution nobody
// believes, so the arithmetic is pinned against hand-computed values rather
// than against itself.

#include "testing.h"

#include "../../../src/services/CostModel.h"

using namespace stackpilot;

namespace {

/// Fixed rates so the expected values below can be computed by hand:
/// 1000 millicents per core-hour, 1000 per GiB-hour.
const ResourceRate kRate{1000, 1000};

}  // namespace

// ─── CPU parsing ────────────────────────────────────────────────

TEST(ParseCpu, MilliSuffix) {
    EXPECT_EQ(CostModel::parseCpuMillicores("500m"), 500);
    EXPECT_EQ(CostModel::parseCpuMillicores("100m"), 100);
}

TEST(ParseCpu, BareNumberIsWholeCores) {
    EXPECT_EQ(CostModel::parseCpuMillicores("2"), 2000);
    EXPECT_EQ(CostModel::parseCpuMillicores("1"), 1000);
}

TEST(ParseCpu, FractionalCores) {
    EXPECT_EQ(CostModel::parseCpuMillicores("0.5"), 500);
}

TEST(ParseCpu, UnparseableIsZero) {
    EXPECT_EQ(CostModel::parseCpuMillicores(""), 0);
    EXPECT_EQ(CostModel::parseCpuMillicores("lots"), 0);
    EXPECT_EQ(CostModel::parseCpuMillicores("500x"), 0);
}

// ─── memory parsing ─────────────────────────────────────────────

TEST(ParseMemory, BinarySuffixes) {
    EXPECT_EQ(CostModel::parseMemoryMb("512Mi"), 512);
    EXPECT_EQ(CostModel::parseMemoryMb("2Gi"), 2048);
}

TEST(ParseMemory, DecimalSuffixesAreNotBinaryOnes) {
    // 1000M is ~954Mi. Treating them as equal under-reports memory by ~7% per
    // level, which compounds into a materially wrong bill for a large fleet.
    EXPECT_EQ(CostModel::parseMemoryMb("1000M"), 976);
    EXPECT_TRUE(CostModel::parseMemoryMb("1G") < CostModel::parseMemoryMb("1Gi"));
}

TEST(ParseMemory, UnparseableIsZero) {
    EXPECT_EQ(CostModel::parseMemoryMb(""), 0);
    EXPECT_EQ(CostModel::parseMemoryMb("some"), 0);
}

// ─── presets ────────────────────────────────────────────────────

TEST(Preset, KnownPresetsMatchTheKubernetesDefinitions) {
    // These mirror KubernetesService::resourcePresetFor. If that changes and
    // this does not, cost silently stops describing what is deployed.
    EXPECT_EQ(CostModel::shapeForPreset("small").cpuMillicores, 100);
    EXPECT_EQ(CostModel::shapeForPreset("small").memoryMb, 128);
    EXPECT_EQ(CostModel::shapeForPreset("medium").cpuMillicores, 250);
    EXPECT_EQ(CostModel::shapeForPreset("medium").memoryMb, 256);
    EXPECT_EQ(CostModel::shapeForPreset("large").cpuMillicores, 500);
    EXPECT_EQ(CostModel::shapeForPreset("large").memoryMb, 512);
}

TEST(Preset, UnknownPresetIsNeverFree) {
    // A typo in a preset name must not make a running service look costless —
    // that is the one error that would hide exactly what this feature exists
    // to surface.
    EXPECT_TRUE(CostModel::shapeForPreset("").cpuMillicores > 0);
    EXPECT_TRUE(CostModel::shapeForPreset("enormous").cpuMillicores > 0);
    EXPECT_TRUE(CostModel::shapeForPreset("SMALL ").cpuMillicores > 0);
}

// ─── accrual ────────────────────────────────────────────────────

TEST(Accrue, OneCoreForOneHourCostsOneCoreHour) {
    // 1000 millicores, 1 replica, 3600s, 1000 millicents/core-hour.
    const int64_t cost = CostModel::accrueMillicents({1000, 0}, 1, 3600, kRate);
    EXPECT_EQ(cost, 1000);
}

TEST(Accrue, OneGibForOneHourCostsOneGibHour) {
    const int64_t cost = CostModel::accrueMillicents({0, 1024}, 1, 3600, kRate);
    EXPECT_EQ(cost, 1000);
}

TEST(Accrue, ScalesWithReplicas) {
    const int64_t one = CostModel::accrueMillicents({1000, 1024}, 1, 3600, kRate);
    const int64_t three = CostModel::accrueMillicents({1000, 1024}, 3, 3600, kRate);
    EXPECT_EQ(three, one * 3);
}

TEST(Accrue, ScalesWithTime) {
    const int64_t hour = CostModel::accrueMillicents({1000, 1024}, 1, 3600, kRate);
    const int64_t halfHour = CostModel::accrueMillicents({1000, 1024}, 1, 1800, kRate);
    EXPECT_EQ(halfHour, hour / 2);
}

TEST(Accrue, ASmallShapeOverAShortWindowIsNotRoundedToZero) {
    // The bug this guards: dividing before multiplying makes a 100m container
    // sampled for 60 seconds cost nothing, so a long-lived preview accrues
    // zero forever and never shows up in the report.
    const int64_t cost = CostModel::accrueMillicents({100, 128}, 1, 60, kRate);
    EXPECT_TRUE(cost > 0);
}

TEST(Accrue, NonPositiveInputsCostNothing) {
    EXPECT_EQ(CostModel::accrueMillicents({1000, 1024}, 1, 0, kRate), 0);
    EXPECT_EQ(CostModel::accrueMillicents({1000, 1024}, 1, -60, kRate), 0);
    EXPECT_EQ(CostModel::accrueMillicents({1000, 1024}, 0, 3600, kRate), 0);
    EXPECT_EQ(CostModel::accrueMillicents({0, 0}, 1, 3600, kRate), 0);
}

TEST(Accrue, NegativeShapeIsTreatedAsZeroNotAsACredit) {
    // Corrupt data must not be able to reduce an organization's total.
    EXPECT_EQ(CostModel::accrueMillicents({-500, -500}, 1, 3600, kRate), 0);
}

TEST(Accrue, LongRunningDeploymentsDoNotOverflow) {
    // A year of a large shape at a high rate must stay well inside int64.
    const int64_t year = CostModel::accrueMillicents({4000, 16384}, 10, 365 * 24 * 3600,
                                                     ResourceRate{100000, 100000});
    EXPECT_TRUE(year > 0);
}

// ─── formatting ─────────────────────────────────────────────────

// A millicent is one thousandth of a cent: $1.00 == 100,000 millicents.
// Pinning that here explicitly, because the original implementation divided by
// 100 instead of 1000 and rendered every total ten times too large — an error
// that survives a glance because the output still looks like money.

TEST(Format, RendersDollarsAndCents) {
    EXPECT_EQ(CostModel::formatMillicents(100000), "$1.00");
    EXPECT_EQ(CostModel::formatMillicents(1234567), "$12.35");
    EXPECT_EQ(CostModel::formatMillicents(0), "$0.00");
}

TEST(Format, ADollarIsOneHundredThousandMillicents) {
    // The unit itself, stated as a test so a future refactor cannot quietly
    // reinterpret the column.
    EXPECT_EQ(CostModel::formatMillicents(100000), "$1.00");
    EXPECT_EQ(CostModel::formatMillicents(1000000), "$10.00");
    EXPECT_EQ(CostModel::formatMillicents(1000), "$0.01");
}

TEST(Format, PadsTheCentsField) {
    // "$1.5" would be wrong by a factor of ten against "$1.05".
    EXPECT_EQ(CostModel::formatMillicents(105000), "$1.05");
    EXPECT_EQ(CostModel::formatMillicents(5000), "$0.05");
}

TEST(Format, RoundsRatherThanTruncates) {
    // 1499 millicents is nearer 1 cent than 2; 1501 is nearer 2.
    EXPECT_EQ(CostModel::formatMillicents(1499), "$0.01");
    EXPECT_EQ(CostModel::formatMillicents(1501), "$0.02");
}

TEST(Format, SubCentAmountsDoNotVanishFromTheStoredValue) {
    // Display rounds to zero, which is fine -- the point is that the stored
    // millicents keep accruing rather than being rounded away each sample.
    EXPECT_EQ(CostModel::formatMillicents(400), "$0.00");
    EXPECT_TRUE(CostModel::accrueMillicents({100, 128}, 1, 60, kRate) > 0);
}

TEST(Format, HandlesNegativeTotals) {
    EXPECT_EQ(CostModel::formatMillicents(-1234567), "-$12.35");
}
