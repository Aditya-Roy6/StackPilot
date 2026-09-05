// ============================================================
// LocalDockerRuntime.cpp
// ============================================================

#include "LocalDockerRuntime.h"

#include "../utils/StringUtils.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <sstream>
#ifndef _WIN32
#include <sys/wait.h>
#endif

namespace stackpilot {

using strings::shellQuote;
using strings::trim;

std::string LocalDockerRuntime::markerValue(const std::string& output, const std::string& marker) {
    std::istringstream stream(output);
    std::string line;
    const std::string prefix = marker + "=";
    while (std::getline(stream, line)) {
        if (line.rfind(prefix, 0) == 0) {
            return trim(line.substr(prefix.size()));
        }
    }
    return "";
}

std::string LocalDockerRuntime::sanitizeContainerName(const std::string& raw) {
    std::string cleaned;
    cleaned.reserve(std::min<size_t>(raw.size(), 96));
    for (char c : raw) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '.' || c == '-';
        cleaned.push_back(ok ? static_cast<char>(std::tolower(static_cast<unsigned char>(c))) : '-');
        if (cleaned.size() >= 96) {
            break;
        }
    }
    while (!cleaned.empty() && cleaned.front() == '-') {
        cleaned.erase(cleaned.begin());
    }
    while (!cleaned.empty() && cleaned.back() == '-') {
        cleaned.pop_back();
    }
    return cleaned.empty() ? "deployment" : cleaned;
}

bool LocalDockerRuntime::isValidRuntimeEnvKey(const std::string& key) {
    if (key.empty()) {
        return false;
    }
    if (!(std::isalpha(static_cast<unsigned char>(key.front())) || key.front() == '_')) {
        return false;
    }
    for (char c : key) {
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) {
            return false;
        }
    }
    return true;
}

bool LocalDockerRuntime::isValidImageRef(const std::string& value) {
    const std::string cleaned = trim(value);
    if (cleaned.empty() || cleaned.size() > 255) {
        return false;
    }
    for (char c : cleaned) {
        const bool ok = std::isalnum(static_cast<unsigned char>(c)) ||
                        c == '_' || c == '.' || c == '-' || c == '/' ||
                        c == ':' || c == '@';
        if (!ok) {
            return false;
        }
    }
    return true;
}

std::string LocalDockerRuntime::makeRunCommand(const std::string& containerName,
                                      const std::string& imageName,
                                      int containerPort,
                                      const std::vector<std::pair<std::string, std::string>>& envVars) {
    std::string envArgs;
    for (const auto& envVar : envVars) {
        if (!isValidRuntimeEnvKey(envVar.first)) {
            continue;
        }
        const std::string& value = envVar.second;
        envArgs += " --env " + shellQuote(envVar.first + "=" + value);
    }

    const std::string container = shellQuote(containerName);
    const std::string image = shellQuote(imageName);
    const std::string requestedPort = std::to_string(std::clamp(containerPort, 0, 65535));
    return
        "set -e; "
        "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
        "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
        "docker image inspect " + image + " >/dev/null 2>&1 || { echo __STACKPILOT_IMAGE_MISSING__; exit 12; }; "
        "requested_port=" + requestedPort + "; "
        "if [ \"$requested_port\" -gt 0 ]; then "
        "container_port=\"$requested_port\"; "
        "else "
        "container_port=$(docker image inspect --format '{{range $p, $_ := .Config.ExposedPorts}}{{println $p}}{{end}}' " + image + " 2>/dev/null | sed -n 's#/tcp$##p' | head -n 1); "
        "[ -n \"$container_port\" ] || container_port=3000; "
        "fi; "
        "container=" + container + "; "
        "docker rm -f " + container + " >/dev/null 2>&1 || true; "
        "docker run -d --restart unless-stopped --name " + container + envArgs +
        " -p 127.0.0.1::$container_port " + image + " >/tmp/stackpilot-local-container-id; "
        "host_port=$(docker port " + container + " $container_port/tcp 2>/dev/null | awk -F: 'NF {print $NF; exit}'); "
        "[ -n \"$host_port\" ] || { echo __STACKPILOT_PORT_MISSING__; docker logs --tail 80 " + container + " || true; exit 13; }; "
        "ready=0; "
        "for i in $(seq 1 45); do "
        "status=$(docker inspect --format '{{.State.Status}}' \"$container\" 2>/dev/null || echo \"exited\"); "
        "if [ \"$status\" = \"exited\" ] || [ \"$status\" = \"dead\" ]; then "
        "echo \"Container crashed on startup:\"; "
        "docker logs --tail 50 \"$container\" 2>&1; "
        "exit 1; "
        "fi; "
        "if [ -n \"$host_port\" ]; then "
        "if curl -s -o /dev/null -w \"%{http_code}\" \"http://127.0.0.1:$host_port/\" >/dev/null 2>&1 || "
        "curl -s -o /dev/null -w \"%{http_code}\" \"http://host.docker.internal:$host_port/\" >/dev/null 2>&1 || "
        "nc -z 127.0.0.1 \"$host_port\" >/dev/null 2>&1 || "
        "[ \"$status\" = \"running\" ]; then "
        "ready=1; "
        "break; "
        "fi; "
        "else "
        "if [ \"$status\" = \"running\" ]; then ready=1; break; fi; "
        "fi; "
        "sleep 1; "
        "done; "
        "status=$(docker inspect --format '{{.State.Status}}' \"$container\" 2>/dev/null || echo \"exited\"); "
        "if [ \"$status\" = \"exited\" ] || [ \"$status\" = \"dead\" ]; then "
        "echo \"Container crashed on startup:\"; "
        "docker logs --tail 50 \"$container\" 2>&1; "
        "exit 1; "
        "fi; "
        "if [ \"$ready\" -ne 1 ]; then "
        "echo \"Container readiness probe failed or timed out:\"; "
        "docker logs --tail 50 \"$container\" 2>&1 || true; "
        "exit 1; "
        "fi; "
        "running=$(docker inspect --format '{{.State.Running}}' \"$container\" 2>/dev/null || echo \"true\"); "
        "echo __STACKPILOT_LOCAL_DOCKER_RUNNING__; "
        "echo __STACKPILOT_LOCAL_DOCKER_PORT__=$host_port; "
        "echo container_name=" + containerName + "; "
        "echo container_port=$container_port; "
        "echo host_port=$host_port; "
        "echo runtime_url=http://localhost:$host_port; "
        "echo status=$status; "
        "echo running=$running; "
        "echo image=" + imageName + "; "
        "echo __STACKPILOT_LOCAL_LOG_TAIL__; "
        "docker logs --tail 80 \"$container\" 2>&1 || true";
}

std::string LocalDockerRuntime::makePauseCommand(const std::string& containerName, bool paused) {
    const std::string container = shellQuote(containerName);
    return "set -e; "
           "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
           "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
           "docker inspect " + container + " >/dev/null 2>&1 || { echo __STACKPILOT_CONTAINER_MISSING__; exit 12; }; "
           "docker " + std::string(paused ? "pause " : "unpause ") + container + " >/dev/null; "
           "docker inspect --format 'status={{.State.Status}}\nrunning={{.State.Running}}\npaused={{.State.Paused}}\nimage={{.Config.Image}}\nstarted_at={{.State.StartedAt}}\nfinished_at={{.State.FinishedAt}}\nrestart_count={{.RestartCount}}' " + container;
}

int LocalDockerRuntime::run(const std::string& command, std::string& output) {
    output.clear();
    FILE* pipe = popen(command.c_str(), "r");
    if (!pipe) {
        output = "Failed to start local command";
        return 1;
    }

    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }

    const int status = pclose(pipe);
#ifdef _WIN32
    return status;
#else
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    return status;
#endif
}

SshOperationResult LocalDockerRuntime::removeContainer(const std::string& containerName,
                                             const std::string& imageName,
                                             bool removeImage) {
    SshOperationResult result;
    if (trim(containerName).empty()) {
        result.error = "Local Docker container name is missing";
        return result;
    }
    const std::string command =
        "timeout 60s sh -lc " + shellQuote(
            std::string("set -e; ")
            + "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
            + "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
            + "docker rm -f " + shellQuote(containerName) + " >/dev/null 2>&1 || true; "
            + "echo __STACKPILOT_LOCAL_CONTAINER_REMOVED__; "
            + (removeImage && !imageName.empty()
                ? "docker image rm -f " + shellQuote(imageName) + " >/dev/null 2>&1 || true; echo __STACKPILOT_LOCAL_IMAGE_REMOVE_ATTEMPTED__;"
                : "")
        );
    std::string output;
    const int exitCode = run(command, output);
    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__STACKPILOT_LOCAL_CONTAINER_REMOVED__") == std::string::npos) {
        result.error = exitCode == 124 ? "Local Docker runtime removal timed out" : "Failed to remove local Docker runtime";
        return result;
    }
    result.success = true;
    return result;
}

SshOperationResult LocalDockerRuntime::removeImage(const std::string& imageName) {
    SshOperationResult result;
    if (!isValidImageRef(imageName)) {
        result.error = "Invalid or missing Docker image reference";
        return result;
    }

    std::string registryImage = "localhost:5000/" + imageName;
    const std::string dockerIoPrefix = "localhost:5000/docker.io/";
    if (registryImage.rfind(dockerIoPrefix, 0) == 0) {
        registryImage = "localhost:5000/" + registryImage.substr(dockerIoPrefix.size());
    }

    const std::string command =
        "timeout 45s sh -lc " + shellQuote(
            "set -e; "
            "command -v docker >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_MISSING__; exit 10; }; "
            "docker info >/dev/null 2>&1 || { echo __STACKPILOT_DOCKER_DAEMON_DOWN__; exit 11; }; "
            "failed=0; "
            "for img in " + shellQuote(imageName) + " " + shellQuote(registryImage) + "; do "
            "  [ -n \"$img\" ] || continue; "
            "  if docker image inspect \"$img\" >/dev/null 2>&1; then "
            "    if docker image rm \"$img\" >/dev/null 2>&1; then "
            "      echo __STACKPILOT_LOCAL_IMAGE_REMOVED__=$img; "
            "    else "
            "      echo __STACKPILOT_LOCAL_IMAGE_REMOVE_FAILED__=$img; failed=1; "
            "    fi; "
            "  else "
            "    echo __STACKPILOT_LOCAL_IMAGE_ALREADY_ABSENT__=$img; "
            "  fi; "
            "done; "
            "[ \"$failed\" -eq 0 ] || exit 12; "
            "echo __STACKPILOT_LOCAL_IMAGE_CLEANUP_DONE__"
        );

    std::string output;
    const int exitCode = run(command, output);
    result.exitCode = exitCode;
    result.output = output;
    if (exitCode != 0 || output.find("__STACKPILOT_LOCAL_IMAGE_CLEANUP_DONE__") == std::string::npos) {
        if (output.find("__STACKPILOT_DOCKER_MISSING__") != std::string::npos) {
            result.error = "Docker is not installed on this host";
        } else if (output.find("__STACKPILOT_DOCKER_DAEMON_DOWN__") != std::string::npos) {
            result.error = "Docker daemon is not reachable on this host";
        } else if (output.find("__STACKPILOT_LOCAL_IMAGE_REMOVE_FAILED__") != std::string::npos) {
            result.error = "Docker image could not be deleted because it may still be in use";
        } else if (exitCode == 124) {
            result.error = "Docker image cleanup timed out";
        } else {
            result.error = "Failed to remove Docker image";
        }
        return result;
    }
    result.success = true;
    return result;
}

}  // namespace stackpilot
