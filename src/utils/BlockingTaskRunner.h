// ============================================================
// BlockingTaskRunner.h — Off-event-loop execution for blocking work
// ============================================================
// Drogon runs handlers on a small fixed set of event-loop threads
// (config.json: threads_num). Any handler that performs a synchronous
// network call — e.g. the AI service client's curl_easy_perform, which
// waits up to 120s — occupies one of those threads for the whole call.
// With 4 threads, four concurrent AI requests stall the entire backend:
// auth, deployments, log WebSockets and health checks all stop answering.
//
// Handlers are already asynchronous in shape (they receive a callback),
// so the fix is to run the blocking body on a dedicated worker pool and
// invoke the callback from there. Drogon callbacks are safe to call from
// any thread.
// ============================================================

#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace stackpilot {

class BlockingTaskRunner {
public:
    static BlockingTaskRunner& getInstance() {
        static BlockingTaskRunner instance;
        return instance;
    }

    // Queue work for a worker thread. Returns immediately.
    static void run(std::function<void()> task) {
        getInstance().enqueue(std::move(task));
    }

    void start(std::size_t threadCount);
    void stop();

    BlockingTaskRunner(const BlockingTaskRunner&) = delete;
    BlockingTaskRunner& operator=(const BlockingTaskRunner&) = delete;

private:
    BlockingTaskRunner() = default;
    ~BlockingTaskRunner();

    void enqueue(std::function<void()> task);
    void workerLoop();

    std::vector<std::thread> m_workers;
    std::deque<std::function<void()>> m_tasks;
    std::mutex m_mutex;
    std::condition_variable m_cv;
    bool m_stopping = false;
    bool m_started = false;
};

} // namespace stackpilot
