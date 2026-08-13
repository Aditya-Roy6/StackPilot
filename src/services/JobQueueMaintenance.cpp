// ============================================================
// JobQueueMaintenance.cpp — periodic housekeeping
// ============================================================
// Cost sampling and preview expiry, on a slow timer alongside the build
// workers. Both are the kind of work that is invisible when it runs and
// expensive when it doesn't: a preview nobody tore down is a bill, and cost
// samples that stop accruing produce a report that quietly reads zero.
//
// Separate translation unit from JobQueueService.cpp, which is already 1,789
// lines.

#include "JobQueueService.h"

#include "CostModel.h"
#include "PreviewEnvironments.h"
#include "../db/Database.h"
#include "../utils/StringUtils.h"

#include <chrono>
#include <pqxx/pqxx>
#include <spdlog/spdlog.h>
#include <thread>

namespace stackpilot {
namespace {

/// How often a sample is taken. Each sample accounts for exactly this window,
/// so a missed tick under-reports rather than inventing usage for a gap.
constexpr int kSampleWindowSeconds = 60;

int envInt(const char* name, int fallback) {
    const std::string raw = strings::getEnvOrDefault(name, "");
    if (raw.empty()) return fallback;
    try {
        const int parsed = std::stoi(raw);
        return parsed > 0 ? parsed : fallback;
    } catch (...) {
        return fallback;
    }
}

/// Records one cost sample for every deployment currently running.
void sampleRunningDeployments(pqxx::transaction_base& txn) {
    const ResourceRate rate = CostModel::rateCard();

    // runtime_paused deployments are excluded: a paused container releases its
    // reservation, so charging for it would overstate the bill and, worse,
    // make pausing look pointless.
    const auto rows = txn.exec(
        "SELECT d.id, d.project_id, p.organization_id, "
        "COALESCE(d.desired_replicas, 1) AS replicas, "
        "COALESCE(d.runtime_snapshot->>'resource_preset', 'small') AS preset "
        "FROM deployments d JOIN projects p ON p.id = d.project_id "
        "WHERE d.status = 'running' AND COALESCE(d.runtime_paused, FALSE) = FALSE"
    );

    for (const auto& row : rows) {
        const ResourceShape shape = CostModel::shapeForPreset(row["preset"].as<std::string>());
        const int replicas = row["replicas"].as<int>();
        const long long accrued =
            CostModel::accrueMillicents(shape, replicas, kSampleWindowSeconds, rate);

        txn.exec_params(
            "INSERT INTO deployment_cost_samples "
            "(deployment_id, project_id, organization_id, window_seconds, replicas, "
            " cpu_millicores, memory_mb, accrued_millicents) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            row["id"].as<std::string>(),
            row["project_id"].as<std::string>(),
            row["organization_id"].as<std::string>(),
            kSampleWindowSeconds,
            replicas,
            shape.cpuMillicores * replicas,
            shape.memoryMb * replicas,
            accrued
        );
    }
}

/// Flags previews past their TTL. Actual teardown is the cleanup service's
/// job; this only decides that a preview's time is up.
int expirePreviews(pqxx::transaction_base& txn) {
    const auto result = txn.exec(
        "UPDATE deployments SET status = 'pending_teardown', "
        "logs = COALESCE(logs, '') || 'Preview environment expired and was queued for teardown.' || E'\\n', "
        "updated_at = NOW() "
        "WHERE is_preview AND preview_expires_at IS NOT NULL AND preview_expires_at < NOW() "
        "AND status NOT IN ('destroyed', 'failed', 'superseded', 'pending_teardown')"
    );
    return static_cast<int>(result.affected_rows());
}

}  // namespace

void JobQueueService::maintenanceLoop() {
    const int intervalSeconds = envInt("STACKPILOT_MAINTENANCE_INTERVAL_SECONDS", kSampleWindowSeconds);
    spdlog::info("Deployment maintenance worker online (every {}s)", intervalSeconds);

    while (running_) {
        // Sleep in short slices so shutdown does not wait out a full interval.
        for (int elapsed = 0; elapsed < intervalSeconds && running_; ++elapsed) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        if (!running_) break;

        try {
            auto conn = Database::getInstance().getConnection();
            pqxx::work txn(*conn);
            sampleRunningDeployments(txn);
            const int expired = expirePreviews(txn);
            txn.commit();
            if (expired > 0) {
                spdlog::info("Expired {} preview environment(s)", expired);
            }
        } catch (const std::exception& e) {
            // Never fatal. Losing a sample under-reports cost slightly; killing
            // the worker would stop reporting entirely, which is far worse and
            // much harder to notice.
            spdlog::warn("Maintenance tick failed: {}", e.what());
        }
    }
}

}  // namespace stackpilot
