// Process-wide PostgreSQL connection pool.
//
// Single instance by design: the pool size is the platform's contract with
// Postgres' max_connections, and a second pool would silently double it.
// getConnection() blocks when the pool is saturated rather than opening an
// unbounded number of sockets.

#pragma once

#include <string>
#include <memory>
#include <pqxx/pqxx>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <vector>

namespace stackpilot {

class Database {
public:
    // A pooled connection. The custom deleter returns it to the pool instead of
    // closing it, so call sites keep using `auto conn = db.getConnection();`
    // unchanged. Previously every call opened a brand-new PostgreSQL connection,
    // and a request holding one across a slow network call could exhaust
    // max_connections and take down every service at once.
    using ConnectionHandle = std::unique_ptr<pqxx::connection, std::function<void(pqxx::connection*)>>;

    // ─── Singleton access ───────────────────────────────────
    // static means this belongs to the CLASS, not an instance
    // Returns a reference (&) to the single instance
    static Database& getInstance() {
        static Database instance;  // Created once, lives forever
        return instance;
    }

    // ─── Initialize connection ──────────────────────────────
    void initialize(
        const std::string& host,
        int port,
        const std::string& dbname,
        const std::string& user,
        const std::string& password
    );

    // ─── Get a connection for queries ───────────────────────
    // Borrows from the pool, blocking briefly if every connection is checked out.
    // Released automatically when the handle goes out of scope.
    ConnectionHandle getConnection();

    // ─── Check if connected ─────────────────────────────────
    bool isConnected() const { return m_initialized; }

    // ─── Run migrations ─────────────────────────────────────
    void runMigrations(const std::string& migrationsPath);

    // Delete copy/move to enforce singleton
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

private:
    Database() = default;  // Private constructor = can't create from outside

    std::string m_connString;
    bool m_initialized = false;
    std::mutex m_mutex;  // Thread safety for initialization

    // ─── Connection pool ────────────────────────────────────
    std::vector<std::unique_ptr<pqxx::connection>> m_idle;
    std::condition_variable m_available;
    std::size_t m_maxConnections = 16;
    std::size_t m_outstanding = 0;  // currently checked out
};

} // namespace stackpilot
