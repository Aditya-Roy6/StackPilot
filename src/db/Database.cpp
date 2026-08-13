// ============================================================
// Database.cpp — PostgreSQL Connection Implementation
// ============================================================

#include "Database.h"
#include <spdlog/spdlog.h>
#include <filesystem>
#include <fstream>
#include <algorithm>
#include <set>
#include <stdexcept>
#include <cstdlib>

namespace stackpilot {

void Database::initialize(
    const std::string& host,
    int port,
    const std::string& dbname,
    const std::string& user,
    const std::string& password
) {
    std::lock_guard<std::mutex> lock(m_mutex);

    m_connString = "host=" + host +
                   " port=" + std::to_string(port) +
                   " dbname=" + dbname +
                   " user=" + user +
                   " password=" + password;

    // Pool ceiling. Keep this comfortably below the server's max_connections,
    // remembering a single request can hold more than one (e.g. JWT verification
    // plus the handler's own transaction).
    if (const char* poolEnv = std::getenv("STACKPILOT_DB_POOL_SIZE")) {
        try {
            const int parsed = std::stoi(poolEnv);
            if (parsed > 0) {
                m_maxConnections = static_cast<std::size_t>(parsed);
            }
        } catch (const std::exception&) {
            spdlog::warn("Invalid STACKPILOT_DB_POOL_SIZE, using default {}", m_maxConnections);
        }
    }
    spdlog::info("Database connection pool size: {}", m_maxConnections);

    // Test the connection
    try {
        auto conn = std::make_unique<pqxx::connection>(m_connString);
        if (conn->is_open()) {
            spdlog::info("Connected to PostgreSQL: {}", dbname);
            m_initialized = true;
        } else {
            throw std::runtime_error("Connection opened but is_open() returned false");
        }
    } catch (const std::exception& e) {
        spdlog::error("PostgreSQL connection failed: {}", e.what());
        throw;
    }
}

Database::ConnectionHandle Database::getConnection() {
    if (!m_initialized) {
        throw std::runtime_error("Database not initialized. Call initialize() first.");
    }

    std::unique_ptr<pqxx::connection> conn;
    {
        std::unique_lock<std::mutex> lock(m_mutex);
        // Wait for a free slot rather than opening unbounded connections. A
        // handler that holds a connection across a slow call now queues instead
        // of pushing the server past max_connections.
        m_available.wait(lock, [this] {
            return !m_idle.empty() || m_outstanding < m_maxConnections;
        });

        while (!m_idle.empty()) {
            conn = std::move(m_idle.back());
            m_idle.pop_back();
            if (conn && conn->is_open()) {
                break;  // healthy, reuse it
            }
            conn.reset();  // drop dead connections and try the next
        }
        ++m_outstanding;
    }

    if (!conn) {
        try {
            conn = std::make_unique<pqxx::connection>(m_connString);
        } catch (...) {
            // Never leak the slot on a failed connect, or the pool drains to zero
            // and every later request blocks forever.
            std::lock_guard<std::mutex> lock(m_mutex);
            --m_outstanding;
            m_available.notify_one();
            throw;
        }
    }

    return ConnectionHandle(conn.release(), [this](pqxx::connection* raw) {
        std::unique_ptr<pqxx::connection> owned(raw);
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (m_outstanding > 0) {
                --m_outstanding;
            }
            if (owned && owned->is_open() && m_idle.size() < m_maxConnections) {
                m_idle.push_back(std::move(owned));
            }
        }
        m_available.notify_one();
    });
}

void Database::runMigrations(const std::string& migrationsPath) {
    // Lexicographic filename order is the dependency order; the zero-padded
    // numeric prefix is what makes that true, so never renumber a shipped file.
    spdlog::info("Running migrations from: {}", migrationsPath);

    auto conn = getConnection();
    namespace fs = std::filesystem;

    // Collect all .sql files
    std::vector<fs::path> sqlFiles;
    for (const auto& entry : fs::directory_iterator(migrationsPath)) {
        if (entry.path().extension() == ".sql") {
            sqlFiles.push_back(entry.path());
        }
    }

    // Sort alphabetically (001 before 002 before 003)
    std::sort(sqlFiles.begin(), sqlFiles.end());

    // Migrations used to be re-executed on every boot, with any failure swallowed
    // as "may already be applied". That made a broken migration indistinguishable
    // from a no-op, and it re-ran the one-time backfills in 007/009/013/019 on
    // every restart — 013 in particular nulls stored credentials.
    {
        pqxx::work txn(*conn);
        txn.exec(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "  filename TEXT PRIMARY KEY,"
            "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
            ")"
        );
        txn.commit();
    }

    std::set<std::string> applied;
    bool freshDatabase = false;
    {
        pqxx::work txn(*conn);
        for (const auto& row : txn.exec("SELECT filename FROM schema_migrations")) {
            applied.insert(row[0].as<std::string>());
        }
        // An existing deployment already has these schema objects even though it
        // has no ledger yet. Baseline it rather than replaying every backfill.
        const auto sentinel = txn.exec("SELECT to_regclass('public.users') IS NOT NULL AS present");
        freshDatabase = sentinel.empty() || !sentinel[0][0].as<bool>();
        txn.commit();
    }

    if (applied.empty() && !freshDatabase) {
        pqxx::work txn(*conn);
        for (const auto& file : sqlFiles) {
            txn.exec_params(
                "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
                file.filename().string()
            );
            applied.insert(file.filename().string());
        }
        txn.commit();
        spdlog::warn("Existing database detected with no migration ledger — baselined {} migration(s) as applied", applied.size());
    }

    for (const auto& file : sqlFiles) {
        const std::string name = file.filename().string();
        if (applied.count(name) > 0) {
            continue;
        }

        spdlog::info("Running migration: {}", name);

        std::ifstream ifs(file);
        std::string sql((std::istreambuf_iterator<char>(ifs)),
                         std::istreambuf_iterator<char>());

        // The migration and its ledger entry commit together, so a crash can
        // never leave a migration applied-but-unrecorded (or vice versa).
        try {
            pqxx::work txn(*conn);
            txn.exec(sql);
            txn.exec_params("INSERT INTO schema_migrations (filename) VALUES ($1)", name);
            txn.commit();
            spdlog::info("  ✓ Migration applied: {}", name);
        } catch (const std::exception& e) {
            // Serving traffic on a partially-migrated schema is worse than not starting.
            spdlog::error("  ✗ Migration failed: {} — {}", name, e.what());
            throw std::runtime_error("Migration failed: " + name + " — " + e.what());
        }
    }

    spdlog::info("All migrations processed");
}

} // namespace stackpilot
