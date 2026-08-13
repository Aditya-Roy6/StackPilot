// ============================================================
// BlockingTaskRunner.cpp
// ============================================================

#include "BlockingTaskRunner.h"

#include <spdlog/spdlog.h>

namespace stackpilot {

BlockingTaskRunner::~BlockingTaskRunner() {
    stop();
}

void BlockingTaskRunner::start(std::size_t threadCount) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_started) {
        return;
    }
    if (threadCount == 0) {
        threadCount = 1;
    }
    m_started = true;
    m_stopping = false;
    m_workers.reserve(threadCount);
    for (std::size_t i = 0; i < threadCount; ++i) {
        m_workers.emplace_back([this] { workerLoop(); });
    }
    spdlog::info("Blocking task runner started with {} worker(s)", threadCount);
}

void BlockingTaskRunner::stop() {
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_started || m_stopping) {
            return;
        }
        m_stopping = true;
    }
    m_cv.notify_all();
    for (auto& worker : m_workers) {
        if (worker.joinable()) {
            worker.join();
        }
    }
    m_workers.clear();
    m_started = false;
}

void BlockingTaskRunner::enqueue(std::function<void()> task) {
    if (!task) {
        return;
    }
    bool runInline = false;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        // If the pool was never started (or is shutting down), run inline rather
        // than silently dropping the request — the caller's callback must fire.
        if (!m_started || m_stopping) {
            runInline = true;
        } else {
            m_tasks.push_back(std::move(task));
        }
    }
    if (runInline) {
        task();  // never call user code while holding the lock
        return;
    }
    m_cv.notify_one();
}

void BlockingTaskRunner::workerLoop() {
    for (;;) {
        std::function<void()> task;
        {
            std::unique_lock<std::mutex> lock(m_mutex);
            m_cv.wait(lock, [this] { return m_stopping || !m_tasks.empty(); });
            if (m_stopping && m_tasks.empty()) {
                return;
            }
            task = std::move(m_tasks.front());
            m_tasks.pop_front();
        }
        try {
            task();
        } catch (const std::exception& e) {
            // A thrown task must never take down a worker thread.
            spdlog::error("Blocking task threw: {}", e.what());
        } catch (...) {
            spdlog::error("Blocking task threw an unknown exception");
        }
    }
}

} // namespace stackpilot
