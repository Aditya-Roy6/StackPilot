// ============================================================
// SshService.h - Encrypted SSH/VPS connectivity helpers
// ============================================================

#pragma once

#include "KubernetesService.h"

#include <functional>
#include <string>
#include <vector>

namespace stackpilot {

struct SshConnectionConfig {
    std::string connectionType = "ssh";
    std::string host;
    int port = 22;
    std::string username;
    std::string authType;
    std::string password;
    std::string privateKey;
    std::string knownHostsEntry;
};

struct SshDirectoryEntry {
    std::string name;
    bool directory = false;
};

struct SshOperationResult {
    bool success = false;
    int exitCode = 0;
    std::string output;
    std::string error;
};

using SshLogCallback = std::function<void(const std::string&)>;
using SshEnvVars = std::vector<std::pair<std::string, std::string>>;

class SshService {
public:
    SshService();

    bool isValidConnectionConfig(const SshConnectionConfig& config, std::string& error) const;
    bool isValidRemotePath(const std::string& path) const;
    SshOperationResult testConnection(const SshConnectionConfig& config) const;
    SshOperationResult listDirectory(const SshConnectionConfig& config, const std::string& remotePath, std::vector<SshDirectoryEntry>& entries) const;
    SshOperationResult syncDirectory(const SshConnectionConfig& config,
                                     const std::string& remotePath,
                                     const std::string& localDestination,
                                     int timeoutSeconds,
                                     SshLogCallback onLogLine = nullptr) const;
    SshOperationResult probeHost(const SshConnectionConfig& config) const;
    SshOperationResult provisionDockerHost(const SshConnectionConfig& config, const std::string& sudoPassword = "") const;
    SshOperationResult provisionLightweightKubernetesHost(const SshConnectionConfig& config, const std::string& sudoPassword = "") const;
    SshOperationResult initializeK3sControlPlane(const SshConnectionConfig& config,
                                                 const std::string& sudoPassword = "",
                                                 const std::string& advertiseAddress = "",
                                                 const std::string& tlsSan = "") const;
    /// Joins a node as a k3s agent.
    ///
    /// `replaceExisting` handles the node that is already running its own
    /// standalone k3s server, usually because Prepare Kubernetes was used on
    /// it. Without it the join refuses, because converting is destructive: the
    /// standalone cluster and everything running on it is removed. With it,
    /// the caller has confirmed that is what they want.
    SshOperationResult joinK3sWorker(const SshConnectionConfig& config,
                                     const std::string& serverUrl,
                                     const std::string& nodeToken,
                                     const std::string& sudoPassword = "",
                                     bool replaceExisting = false) const;
    SshOperationResult inspectK3sCluster(const SshConnectionConfig& config) const;

    /**
     * Joins an additional *control plane* node, so the cluster survives losing
     * the first one. A single control plane means one VM failure destroys the
     * cluster, which is not a cluster in any useful sense.
     *
     * k3s needs `--cluster-init` on the first server to start embedded etcd.
     * Existing single-server clusters were created without it, so this reports
     * a clear error rather than joining a node that cannot participate.
     */
    SshOperationResult joinK3sServer(const SshConnectionConfig& config,
                                     const std::string& serverUrl,
                                     const std::string& nodeToken,
                                     const std::string& sudoPassword) const;

    /// Cordons, drains and deletes a node from the cluster, run from the
    /// control plane. Draining first is what makes this safe: pods are
    /// rescheduled before the node disappears.
    SshOperationResult removeK3sNode(const SshConnectionConfig& controlPlane,
                                     const std::string& nodeName,
                                     const std::string& sudoPassword) const;
    SshOperationResult runRemoteCommand(const SshConnectionConfig& config,
                                        const std::string& workingDirectory,
                                        const std::string& command,
                                        int timeoutSeconds) const;
    SshOperationResult uploadFile(const SshConnectionConfig& config,
                                  const std::string& localPath,
                                  const std::string& remotePath,
                                  int timeoutSeconds,
                                  SshLogCallback onLogLine = nullptr) const;
    SshOperationResult cloneGitRepository(const SshConnectionConfig& config,
                                          const std::string& workingDirectory,
                                          const std::string& repositoryUrl,
                                          const std::string& targetDirectory,
                                          int timeoutSeconds,
                                          const std::string& gitToken = "",
                                          const std::string& branch = "",
                                          const std::string& commitSha = "") const;
    SshOperationResult buildAndRunDockerProject(const SshConnectionConfig& config,
                                                const std::string& remotePath,
                                                const std::string& imageName,
                                                const std::string& containerName,
                                                int containerPort,
                                                int timeoutSeconds,
                                                const SshEnvVars& envVars,
                                                SshLogCallback onLogLine = nullptr) const;
    SshOperationResult inspectDockerContainer(const SshConnectionConfig& config,
                                              const std::string& containerName) const;
    SshOperationResult removeDockerContainer(const SshConnectionConfig& config,
                                             const std::string& containerName,
                                             const std::string& imageName = "",
                                             bool removeImage = false) const;
    SshOperationResult removeDockerImage(const SshConnectionConfig& config,
                                         const std::string& imageName) const;
    KubernetesRuntimeInfo deployKubernetesRuntime(const SshConnectionConfig& config,
                                                  const KubernetesDeployOptions& options) const;
    KubernetesRuntimeInfo deployComposeKubernetesRuntime(const SshConnectionConfig& config,
                                                         const KubernetesDeployOptions& options,
                                                         const std::string& remoteComposeWorkdir,
                                                         const std::string& composeFile,
                                                         const std::string& composeProjectName,
                                                         const std::string& composeServicesCsv) const;
    KubernetesRuntimeInfo inspectKubernetesRuntime(const SshConnectionConfig& config,
                                                   const std::string& nameSpace,
                                                   const std::string& deploymentName,
                                                   const std::string& serviceName,
                                                   const std::string& exposureMode,
                                                   const std::string& runtimeScheme = "") const;
    KubernetesRuntimeInfo scaleKubernetesRuntime(const SshConnectionConfig& config,
                                                 const std::string& nameSpace,
                                                 const std::string& deploymentName,
                                                 const std::string& serviceName,
                                                 const std::string& exposureMode,
                                                 int replicas,
                                                 const std::string& runtimeScheme = "") const;
    KubernetesRuntimeInfo rollbackKubernetesRuntime(const SshConnectionConfig& config,
                                                    const std::string& nameSpace,
                                                    const std::string& deploymentName,
                                                    const std::string& serviceName,
                                                    const std::string& exposureMode,
                                                    const std::string& runtimeScheme = "") const;
    KubernetesRuntimeInfo removeKubernetesRuntime(const SshConnectionConfig& config,
                                                  const std::string& nameSpace,
                                                  const std::string& deploymentName,
                                                  const std::string& serviceName,
                                                  const std::string& exposureMode) const;
    KubernetesRuntimeInfo removeComposeKubernetesRuntime(const SshConnectionConfig& config,
                                                         const std::string& nameSpace,
                                                         const std::string& stackName,
                                                         const std::string& exposureMode) const;
    SshOperationResult fetchKnownHostsEntry(const std::string& host, int port) const;

private:
    struct SessionFiles {
        std::string knownHostsPath;
        std::string privateKeyPath;
        // Mode-0600 file holding the SSH password for `sshpass -f`. Passing the
        // password via SSHPASS=... in the command string put it in the argv of
        // sh/timeout, where any process in the container could read it from
        // `ps` or /proc/<pid>/cmdline.
        std::string passwordPath;
        std::string sshPrefix;
        std::string sshpassPrefix;
    };

    std::string workspaceRoot_;

    std::string shellQuote(const std::string& value) const;
    int runCommand(const std::string& command, std::string& output) const;
    SessionFiles prepareSessionFiles(const SshConnectionConfig& config) const;
    void cleanupSessionFiles(const SessionFiles& files) const;
};

} // namespace stackpilot
